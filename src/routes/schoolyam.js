// 스쿨얌(School Yam) — 학교 매점 전날 주문·다음날 픽업 구매대행 API.
// Vercel 서버리스 + @vercel/blob(단일 JSON Blob) 버전을 igServer 레코드 스토어로 이식.
// 원본 데이터 모델: { orders, ads, sellers, settlements, products, shops, settings:{adsEnabled} }
// 저장(컬렉션): sy_shops, sy_products, sy_orders, sy_sellers, sy_ads, _sy_settle, sy_points, sy_meta(settings)
// 인증: 손님(학부모/학생)=프로젝트 공개키(api_key). 운영자=시크릿키(req.projectAuth==='secret').
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { randomId } from '../config.js';

const router = Router();

const SELLER_FEE = 0.20;          // 셀러(그 학년 대표) 정산 수수료 20%
const AD_VIEW_POINTS = 10;        // 광고 1회 시청 적립 포인트
const MAX_ITEMS = 100;

function isAdmin(req) { return req.projectAuth === 'secret'; }
function requireAdmin(req, res) {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_only', message: '운영자(시크릿) 키가 필요합니다.' }); return false; }
  return true;
}
function normPhone(s) { return String(s || '').replace(/[^0-9]/g, ''); }
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shop'; }

// ---- 설정(메타) ----
async function getSettings(repo, pid) {
  const rec = await repo.getRecord(pid, 'sy_meta', 'settings');
  return Object.assign({ adsEnabled: false }, rec?.data || {});
}
async function saveSettings(repo, pid, patch) {
  const cur = await getSettings(repo, pid);
  const next = Object.assign({ adsEnabled: false }, cur, patch);
  await repo.putRecord({ project_id: pid, collection: 'sy_meta', doc_id: 'settings', data: next, owner_id: null });
  return next;
}

function shopPublic(r) { const d = r.data || {}; return { id: r.doc_id, name: d.name, slug: d.slug, country: d.country || null, state: d.state || null, area: d.area || null, school: d.school || null, created_at: r.created_at }; }
function productPublic(r) { const d = r.data || {}; return { id: r.doc_id, shop: d.shop, name: d.name, price: d.price | 0, photo: d.photo || null, active: d.active !== false, created_at: r.created_at }; }
function orderPublic(r, admin) {
  const d = r.data || {};
  const base = { id: r.doc_id, shop: d.shop, items: d.items || [], total: d.total | 0, grade: d.grade || null, classroom: d.classroom || null, payment: d.payment || 'cash', status: d.status || 'received', created_at: r.created_at };
  // 개인정보(이름·전화)는 운영자에게만 노출. 손님 본인 조회는 별도 경로에서 전화 일치로만.
  if (admin) { base.name = d.name || null; base.phone = d.phone || null; base.sellerId = d.sellerId || null; }
  return base;
}

// ======================= 공개(손님) =======================

// 설정(광고 on/off만 공개)
router.get('/settings', async (req, res, next) => {
  try {
    const s = await getSettings(getRepo(), req.project.id);
    if (isAdmin(req)) return res.json({ ok: true, settings: s });
    res.json({ ok: true, settings: { adsEnabled: s.adsEnabled } });
  } catch (e) { next(e); }
});

// 샵 목록 / 단건(slug 또는 접속코드)
router.get('/shops', async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'sy_shops', { limit: 500, sort: 'created_at:desc' });
    res.json({ ok: true, shops: rows.map(shopPublic) });
  } catch (e) { next(e); }
});
router.get('/shops/:slug', async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'sy_shops', { limit: 1, filters: [['slug', 'eq', req.params.slug]] });
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, shop: shopPublic(rows[0]) });
  } catch (e) { next(e); }
});

// 상품(해당 샵의 활성 상품)
router.get('/products', async (req, res, next) => {
  try {
    const shop = String(req.query.shop || '');
    const filters = shop ? [['shop', 'eq', shop]] : undefined;
    const rows = await getRepo().queryRecords(req.project.id, 'sy_products', { limit: 500, sort: 'created_at:desc', filters });
    const list = rows.map(productPublic).filter((p) => isAdmin(req) ? true : p.active);
    res.json({ ok: true, products: list });
  } catch (e) { next(e); }
});

// 주문 생성(현장 현금결제 기본). 해당 샵+학년의 승인 셀러에게 자동 배정 + 정산(20%) 기록.
router.post('/orders', async (req, res, next) => {
  try {
    const repo = getRepo(), pid = req.project.id, b = req.body || {};
    const shop = String(b.shop || '').trim();
    const items = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS) : [];
    if (!shop) return res.status(400).json({ error: 'bad_shop', message: '샵이 필요합니다.' });
    if (!items.length) return res.status(400).json({ error: 'empty_cart', message: '담은 상품이 없습니다.' });
    // 서버에서 가격 재검증(클라 값 신뢰 안 함)
    let total = 0; const clean = [];
    for (const it of items) {
      const prod = await repo.getRecord(pid, 'sy_products', String(it.id || ''));
      if (!prod || prod.data.shop !== shop || prod.data.active === false) continue;
      const qty = Math.min(999, Math.max(1, Math.floor(Number(it.qty) || 1)));
      const price = prod.data.price | 0;
      total += price * qty;
      clean.push({ id: prod.doc_id, name: prod.data.name, price, qty });
    }
    if (!clean.length) return res.status(400).json({ error: 'no_valid_items', message: '유효한 상품이 없습니다.' });
    const grade = b.grade != null ? String(b.grade).slice(0, 20) : null;
    // 셀러 자동 배정: 같은 샵+학년의 승인 셀러 1명
    let sellerId = null;
    if (grade) {
      const sellers = await repo.queryRecords(pid, 'sy_sellers', { limit: 50, filters: [['shop', 'eq', shop]] });
      const match = sellers.find((s) => (s.data.status === 'approved') && String(s.data.grade) === grade);
      if (match) sellerId = match.doc_id;
    }
    const id = randomId('o_');
    const data = {
      shop, items: clean, total, name: b.name ? String(b.name).slice(0, 60) : null,
      phone: normPhone(b.phone) || null, grade, classroom: b.classroom ? String(b.classroom).slice(0, 20) : null,
      payment: 'cash', status: 'received', sellerId,
    };
    await repo.putRecord({ project_id: pid, collection: 'sy_orders', doc_id: id, data, owner_id: null });
    // 정산 기록(셀러 배정 시)
    if (sellerId) {
      const fee = Math.round(total * SELLER_FEE);
      await repo.putRecord({ project_id: pid, collection: '_sy_settle', doc_id: randomId('st_'), data: { sellerId, orderId: id, shop, grade, amount: total, fee, net: total - fee, ts: Date.now() }, owner_id: null });
    }
    res.status(201).json({ ok: true, order: orderPublic({ doc_id: id, data, created_at: Date.now() }, false) });
  } catch (e) { next(e); }
});

// 내 주문(전화번호 일치로만)
router.get('/orders/mine', async (req, res, next) => {
  try {
    const phone = normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'need_phone' });
    const rows = await getRepo().queryRecords(req.project.id, 'sy_orders', { limit: 100, sort: 'created_at:desc', filters: [['phone', 'eq', phone]] });
    res.json({ ok: true, orders: rows.map((r) => orderPublic(r, false)) });
  } catch (e) { next(e); }
});

// 광고: 다음 광고 1개(설정 off면 없음)
router.get('/ad/next', async (req, res, next) => {
  try {
    const repo = getRepo(), pid = req.project.id;
    const s = await getSettings(repo, pid);
    if (s.adsEnabled === false) return res.json({ ok: true, ad: null });
    const rows = await repo.queryRecords(pid, 'sy_ads', { limit: 100, sort: 'created_at:desc' });
    const active = rows.filter((a) => a.data.active !== false && a.data.status === 'active').map((a) => ({ id: a.doc_id, title: a.data.title, image: a.data.image || null, link: a.data.link || null }));
    if (!active.length) return res.json({ ok: true, ad: null });
    res.json({ ok: true, ad: active[Math.floor(Math.random() * active.length)] });
  } catch (e) { next(e); }
});

// 광고 시청 적립
router.post('/ad/view', async (req, res, next) => {
  try {
    const repo = getRepo(), pid = req.project.id;
    const phone = normPhone((req.body || {}).phone);
    if (!phone) return res.status(400).json({ error: 'need_phone' });
    const rec = await repo.getRecord(pid, 'sy_points', phone);
    const points = ((rec?.data?.points) | 0) + AD_VIEW_POINTS;
    await repo.putRecord({ project_id: pid, collection: 'sy_points', doc_id: phone, data: { points }, owner_id: null });
    res.json({ ok: true, points, added: AD_VIEW_POINTS });
  } catch (e) { next(e); }
});

// 포인트 조회
router.get('/points', async (req, res, next) => {
  try {
    const phone = normPhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: 'need_phone' });
    const rec = await getRepo().getRecord(req.project.id, 'sy_points', phone);
    res.json({ ok: true, points: (rec?.data?.points) | 0 });
  } catch (e) { next(e); }
});

// 셀러 신청(승인 대기)
router.post('/sellers/apply', async (req, res, next) => {
  try {
    const repo = getRepo(), pid = req.project.id, b = req.body || {};
    const shop = String(b.shop || '').trim();
    const grade = b.grade != null ? String(b.grade).slice(0, 20) : '';
    if (!shop || !grade) return res.status(400).json({ error: 'bad_input', message: '샵과 학년이 필요합니다.' });
    const id = randomId('sl_');
    const data = { shop, school: b.school ? String(b.school).slice(0, 60) : null, grade, name: b.name ? String(b.name).slice(0, 40) : null, phone: normPhone(b.phone) || null, status: 'pending', fee_rate: SELLER_FEE };
    await repo.putRecord({ project_id: pid, collection: 'sy_sellers', doc_id: id, data, owner_id: null });
    res.status(201).json({ ok: true, seller: { id, shop, grade, status: 'pending' } });
  } catch (e) { next(e); }
});

// ======================= 운영자(시크릿 키) =======================

// 주문 목록(기간/샵 필터)
router.get('/orders', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const shop = String(req.query.shop || '');
    const filters = shop ? [['shop', 'eq', shop]] : undefined;
    let rows = await getRepo().queryRecords(req.project.id, 'sy_orders', { limit: 1000, sort: 'created_at:desc', filters });
    rows = filterByRange(rows, req.query.from, req.query.to);
    res.json({ ok: true, orders: rows.map((r) => orderPublic(r, true)) });
  } catch (e) { next(e); }
});
router.post('/orders/:id/status', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id;
    const rec = await repo.getRecord(pid, 'sy_orders', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const status = String((req.body || {}).status || '');
    if (!['received', 'preparing', 'ready', 'done', 'canceled'].includes(status)) return res.status(400).json({ error: 'bad_status' });
    rec.data.status = status;
    await repo.putRecord({ project_id: pid, collection: 'sy_orders', doc_id: req.params.id, data: rec.data, owner_id: null });
    res.json({ ok: true, status });
  } catch (e) { next(e); }
});

// 상품 CRUD
router.post('/products', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    if (!b.shop || !b.name) return res.status(400).json({ error: 'bad_input' });
    const id = randomId('pr_');
    const data = { shop: String(b.shop), name: String(b.name).slice(0, 80), price: Math.max(0, Math.floor(Number(b.price) || 0)), photo: typeof b.photo === 'string' && b.photo.length < 2_000_000 ? b.photo : null, active: b.active !== false };
    await getRepo().putRecord({ project_id: req.project.id, collection: 'sy_products', doc_id: id, data, owner_id: null });
    res.status(201).json({ ok: true, product: productPublic({ doc_id: id, data, created_at: Date.now() }) });
  } catch (e) { next(e); }
});
router.put('/products/:id', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id;
    const rec = await repo.getRecord(pid, 'sy_products', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {}, d = rec.data;
    if (b.name != null) d.name = String(b.name).slice(0, 80);
    if (b.price != null) d.price = Math.max(0, Math.floor(Number(b.price) || 0));
    if (b.photo != null) d.photo = typeof b.photo === 'string' && b.photo.length < 2_000_000 ? b.photo : null;
    if (b.active != null) d.active = !!b.active;
    await repo.putRecord({ project_id: pid, collection: 'sy_products', doc_id: req.params.id, data: d, owner_id: null });
    res.json({ ok: true, product: productPublic(rec) });
  } catch (e) { next(e); }
});
router.delete('/products/:id', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    await getRepo().deleteRecord?.(req.project.id, 'sy_products', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 샵 CRUD
router.post('/shops', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'bad_input' });
    const id = randomId('sh_');
    const data = { name: String(b.name).slice(0, 60), slug: slugify(b.slug || b.name), country: b.country || null, state: b.state || null, area: b.area || null, school: b.school || null };
    await getRepo().putRecord({ project_id: req.project.id, collection: 'sy_shops', doc_id: id, data, owner_id: null });
    res.status(201).json({ ok: true, shop: shopPublic({ doc_id: id, data, created_at: Date.now() }) });
  } catch (e) { next(e); }
});
router.delete('/shops/:id', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    await getRepo().deleteRecord?.(req.project.id, 'sy_shops', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 셀러 관리
router.get('/sellers', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(req.project.id, 'sy_sellers', { limit: 500, sort: 'created_at:desc' });
    res.json({ ok: true, sellers: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.post('/sellers/:id/approve', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id;
    const rec = await repo.getRecord(pid, 'sy_sellers', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    // 같은 샵+학년에 이미 승인 셀러가 있으면 거절(1명 원칙)
    const sellers = await repo.queryRecords(pid, 'sy_sellers', { limit: 200, filters: [['shop', 'eq', rec.data.shop]] });
    const exists = sellers.find((s) => s.doc_id !== rec.doc_id && s.data.status === 'approved' && String(s.data.grade) === String(rec.data.grade));
    if (exists) return res.status(409).json({ error: 'slot_taken', message: '이미 해당 학년에 승인된 셀러가 있습니다.' });
    rec.data.status = 'approved';
    await repo.putRecord({ project_id: pid, collection: 'sy_sellers', doc_id: req.params.id, data: rec.data, owner_id: null });
    res.json({ ok: true, status: 'approved' });
  } catch (e) { next(e); }
});
router.post('/sellers/:id/reject', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id;
    const rec = await repo.getRecord(pid, 'sy_sellers', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    rec.data.status = 'rejected';
    await repo.putRecord({ project_id: pid, collection: 'sy_sellers', doc_id: req.params.id, data: rec.data, owner_id: null });
    res.json({ ok: true, status: 'rejected' });
  } catch (e) { next(e); }
});

// 정산 내역
router.get('/settlements', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const seller = String(req.query.seller || '');
    const filters = seller ? [['sellerId', 'eq', seller]] : undefined;
    let rows = await getRepo().queryRecords(req.project.id, '_sy_settle', { limit: 2000, sort: 'created_at:desc', filters });
    rows = filterByRange(rows, req.query.from, req.query.to);
    const total = rows.reduce((a, r) => { a.amount += r.data.amount | 0; a.fee += r.data.fee | 0; a.net += r.data.net | 0; return a; }, { amount: 0, fee: 0, net: 0 });
    res.json({ ok: true, settlements: rows.map((r) => ({ id: r.doc_id, ...r.data })), total });
  } catch (e) { next(e); }
});

// 광고 관리
router.get('/ads', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(req.project.id, 'sy_ads', { limit: 500, sort: 'created_at:desc' });
    res.json({ ok: true, ads: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
// 광고 등록(광고주 셀프서비스는 공개로도 허용하되 status=pending). 운영자가 올리면 바로 active 가능.
router.post('/ads', async (req, res, next) => {
  try {
    const repo = getRepo(), pid = req.project.id, b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'bad_input' });
    const admin = isAdmin(req);
    const id = randomId('ad_');
    const data = { title: String(b.title).slice(0, 80), image: typeof b.image === 'string' && b.image.length < 2_000_000 ? b.image : null, link: b.link ? String(b.link).slice(0, 300) : null, shop: b.shop || null, status: admin && b.status === 'active' ? 'active' : 'pending', active: true };
    await repo.putRecord({ project_id: pid, collection: 'sy_ads', doc_id: id, data, owner_id: null });
    res.status(201).json({ ok: true, ad: { id, ...data } });
  } catch (e) { next(e); }
});
router.post('/ads/:id/approve', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id;
    const rec = await repo.getRecord(pid, 'sy_ads', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    rec.data.status = 'active';
    await repo.putRecord({ project_id: pid, collection: 'sy_ads', doc_id: req.params.id, data: rec.data, owner_id: null });
    res.json({ ok: true, status: 'active' });
  } catch (e) { next(e); }
});
router.post('/ads/:id/reject', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id;
    const rec = await repo.getRecord(pid, 'sy_ads', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    rec.data.status = 'rejected';
    await repo.putRecord({ project_id: pid, collection: 'sy_ads', doc_id: req.params.id, data: rec.data, owner_id: null });
    res.json({ ok: true, status: 'rejected' });
  } catch (e) { next(e); }
});
router.delete('/ads/:id', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    await getRepo().deleteRecord?.(req.project.id, 'sy_ads', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 설정 변경(광고 on/off 등)
router.post('/settings', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const patch = {};
    if (b.adsEnabled != null) patch.adsEnabled = !!b.adsEnabled;
    const s = await saveSettings(getRepo(), req.project.id, patch);
    res.json({ ok: true, settings: s });
  } catch (e) { next(e); }
});

// 분석(주문 수·매출·상품별·일자별)
router.get('/analytics', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const shop = String(req.query.shop || '');
    const filters = shop ? [['shop', 'eq', shop]] : undefined;
    let rows = await getRepo().queryRecords(req.project.id, 'sy_orders', { limit: 5000, sort: 'created_at:desc', filters });
    rows = filterByRange(rows, req.query.from, req.query.to);
    const byDay = {}, byProduct = {};
    let revenue = 0;
    for (const r of rows) {
      const d = r.data || {};
      if (d.status === 'canceled') continue;
      revenue += d.total | 0;
      const day = new Date(r.created_at).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + (d.total | 0);
      for (const it of (d.items || [])) byProduct[it.name] = (byProduct[it.name] || 0) + (it.qty | 0);
    }
    res.json({ ok: true, orders: rows.length, revenue, byDay, byProduct });
  } catch (e) { next(e); }
});

// 기간 필터(created_at 기준, YYYY-MM-DD)
function filterByRange(rows, from, to) {
  const f = from ? Date.parse(from) : null;
  const t = to ? Date.parse(to) + 86400000 : null; // to 포함
  if (f == null && t == null) return rows;
  return rows.filter((r) => { const c = r.created_at; return (f == null || c >= f) && (t == null || c < t); });
}

export default router;
