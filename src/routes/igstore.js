// igStore — STUDIO ig 통합 콘텐츠 마켓(게임·앱·온라인 콘텐츠 전부 하나로).
// 레벨/게임/앱/3D에셋/이미지/음원/영상/문서/번들을 한 카탈로그에 등록·판매·배포한다.
// 경제는 공용 [[isc]] 재사용(서버 권한). 토큰 게이팅은 [[igtoken]]의 _tok_bal을 공유한다.
// 접근 방식(access): free(무료) / paid(ISC 결제) / ad(광고 시청 후 해제) / token(창작자 토큰 보유).
// 소유(entitlement)가 있어야 다운로드 페이로드(fileId/externalUrl)를 받는다. 미보유자는 페이로드가 가려진다.
//   catalog        : 콘텐츠 아이템 {kind, title, cover, desc, creator, access, price, gateSymbol, gateMin,
//                                  fileId, externalUrl, tags[], downloads, revenue, status, source}
//   _store_entitle : 소유권 (doc_id = itemId:uid) {itemId, uid, via, ts}
//   _store_adview  : 광고 해제 쿨다운/검증 (doc_id = itemId:uid)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';
import { credit, debit } from '../isc.js';

const router = Router();

// 지원 콘텐츠 종류 — 게임·앱·온라인 콘텐츠 전부. STUDIO ig 각 툴이 산출물을 이 종류로 등록한다.
//   game   : 게임(실행형)        level  : igPlay 레벨
//   app    : 웹앱/도구            asset3d: 3D 모델(webmax/GAE, GLB/OBJ)
//   image  : 이미지(레이어룸)     music  : 음원(IG Sound)
//   video  : 영상(컷룸)           doc    : 문서/프리셋/템플릿
//   bundle : 묶음 상품
export const KINDS = ['game', 'level', 'app', 'asset3d', 'image', 'music', 'video', 'doc', 'bundle'];
const ACCESS = ['free', 'paid', 'ad', 'token'];
const FEE_RATE = 0.05;          // 결제 수수료 5%
const AD_MIN_WATCH_MS = 4000;   // 광고 해제 최소 시청(서버 검증)

function itemPublic(rec, { entitled = false, mine = false } = {}) {
  if (!rec) return null;
  const d = rec.data || {};
  const out = {
    id: rec.doc_id, kind: d.kind, title: d.title, cover: d.cover || null, desc: d.desc || '',
    creator: d.creator || '', ownerId: rec.owner_id, access: d.access || 'free',
    price: d.price | 0, gateSymbol: d.gateSymbol || null, gateMin: d.gateMin | 0,
    tags: Array.isArray(d.tags) ? d.tags : [], downloads: d.downloads | 0, revenue: d.revenue | 0,
    status: d.status || 'open', source: d.source || null, created_at: rec.created_at,
    hasPayload: !!(d.fileId || d.externalUrl), entitled, mine,
  };
  // 페이로드는 소유자/본인에게만 노출
  if (entitled || mine) { out.fileId = d.fileId || null; out.externalUrl = d.externalUrl || null; }
  return out;
}

async function tokenBalance(pid, symbol, uid) {
  if (!symbol || !uid) return 0;
  const r = await getRepo().getRecord(pid, '_tok_bal', String(symbol).toUpperCase() + ':' + uid);
  return r?.data?.amount || 0;
}
async function isEntitled(pid, itemId, uid) {
  if (!uid) return false;
  const r = await getRepo().getRecord(pid, '_store_entitle', itemId + ':' + uid);
  return !!r;
}
async function grant(pid, itemId, uid, via) {
  await getRepo().putRecord({ project_id: pid, collection: '_store_entitle', doc_id: itemId + ':' + uid, data: { itemId, uid, via, ts: Date.now() }, owner_id: uid });
}
async function bumpDownloads(pid, repo, rec) {
  rec.data.downloads = (rec.data.downloads | 0) + 1;
  await repo.putRecord({ project_id: pid, collection: 'catalog', doc_id: rec.doc_id, data: rec.data, owner_id: rec.owner_id });
}

// ===================== 둘러보기 =====================
// GET /catalog?kind=&q=&sort=  — 공개 목록(검색·종류 필터)
router.get('/catalog', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user?.uid;
    const kind = req.query.kind;
    const filters = KINDS.includes(kind) ? [['kind', 'eq', kind]] : undefined;
    const sort = req.query.sort === 'downloads' ? 'downloads:desc' : 'created_at:desc';
    let rows = await getRepo().queryRecords(pid, 'catalog', { limit: 300, sort, filters });
    rows = rows.filter((r) => (r.data.status || 'open') === 'open');
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) rows = rows.filter((r) => (r.data.title || '').toLowerCase().includes(q) || (Array.isArray(r.data.tags) && r.data.tags.some((t) => String(t).toLowerCase().includes(q))));
    // 로그인 시 소유 여부 한 번에 표시
    const out = [];
    for (const r of rows) {
      const mine = uid && r.owner_id === uid;
      const entitled = mine ? true : await isEntitled(pid, r.doc_id, uid);
      out.push(itemPublic(r, { entitled, mine }));
    }
    res.json({ items: out });
  } catch (e) { next(e); }
});

// GET /catalog/:id — 단건(소유 시 페이로드 포함). 토큰 게이팅이면 보유량도 알려준다.
router.get('/catalog/:id', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user?.uid;
    const rec = await getRepo().getRecord(pid, 'catalog', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const mine = uid && rec.owner_id === uid;
    const entitled = mine ? true : await isEntitled(pid, rec.doc_id, uid);
    const out = itemPublic(rec, { entitled, mine });
    if (rec.data.access === 'token' && rec.data.gateSymbol && uid) out.myTokenBalance = await tokenBalance(pid, rec.data.gateSymbol, uid);
    res.json({ item: out });
  } catch (e) { next(e); }
});

// ===================== 발행(등록) =====================
// POST /catalog — 콘텐츠 올리기. STUDIO ig 각 툴(webmax/레이어룸/컷룸/IG Sound/GAE 등)이 산출물을 여기로 등록.
//   fileId(업로드한 /api/files 파일 id) 또는 externalUrl 중 하나로 실제 콘텐츠를 연결한다.
router.post('/catalog', requireUser, async (req, res, next) => {
  try {
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind', message: '지원하지 않는 콘텐츠 종류입니다.' });
    if (!b.title) return res.status(400).json({ error: 'bad_title', message: '제목이 필요합니다.' });
    let access = ACCESS.includes(b.access) ? b.access : 'free';
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const price = access === 'paid' ? Math.max(1, b.price | 0) : 0;
    let gateSymbol = null, gateMin = 0;
    if (access === 'token') {
      gateSymbol = String(b.gateSymbol || '').toUpperCase();
      if (!gateSymbol) return res.status(400).json({ error: 'bad_gate', message: '토큰 게이팅은 심볼이 필요합니다.' });
      const tok = await repo.getRecord(pid, 'tokens', gateSymbol);
      if (!tok) return res.status(400).json({ error: 'no_token', message: '발행되지 않은 토큰입니다.' });
      gateMin = Math.max(1, b.gateMin | 0);
    }
    const id = randomId('ci_');
    const data = {
      kind, title: String(b.title).slice(0, 100), cover: (typeof b.cover === 'string' && b.cover.length < 900000) ? b.cover : null,
      desc: String(b.desc || '').slice(0, 1000), creator: req.user.name || '익명', access, price, gateSymbol, gateMin,
      fileId: b.fileId ? String(b.fileId).slice(0, 80) : null, externalUrl: (typeof b.externalUrl === 'string' && /^https?:\/\//.test(b.externalUrl)) ? b.externalUrl.slice(0, 500) : null,
      tags: Array.isArray(b.tags) ? b.tags.slice(0, 10).map((t) => String(t).slice(0, 24)) : [],
      refColl: b.refColl ? String(b.refColl).slice(0, 40) : null, refId: b.refId ? String(b.refId).slice(0, 80) : null,
      source: b.source ? String(b.source).slice(0, 40) : null, downloads: 0, revenue: 0, status: 'open',
    };
    const rec = await repo.putRecord({ project_id: pid, collection: 'catalog', doc_id: id, data, owner_id: uid });
    broadcast(pid, 'igstore:catalog', { type: 'item_new', id, kind, title: data.title, ts: Date.now() });
    res.status(201).json({ item: itemPublic(rec, { mine: true }) });
  } catch (e) { next(e); }
});

// 수정(창작자) — 제목/설명/표지/가격/접근/태그/페이로드 갱신
router.patch('/catalog/:id', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'catalog', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.owner_id !== req.user.uid) return res.status(403).json({ error: 'not_owner' });
    const b = req.body || {}, d = rec.data;
    if (b.title != null) d.title = String(b.title).slice(0, 100);
    if (b.desc != null) d.desc = String(b.desc).slice(0, 1000);
    if (typeof b.cover === 'string' && b.cover.length < 900000) d.cover = b.cover;
    if (ACCESS.includes(b.access)) d.access = b.access;
    if (d.access === 'paid') d.price = Math.max(1, (b.price != null ? b.price : d.price) | 0); else d.price = 0;
    if (b.fileId != null) d.fileId = b.fileId ? String(b.fileId).slice(0, 80) : null;
    if (b.externalUrl != null) d.externalUrl = (typeof b.externalUrl === 'string' && /^https?:\/\//.test(b.externalUrl)) ? b.externalUrl.slice(0, 500) : null;
    if (Array.isArray(b.tags)) d.tags = b.tags.slice(0, 10).map((t) => String(t).slice(0, 24));
    await repo.putRecord({ project_id: pid, collection: 'catalog', doc_id: req.params.id, data: d, owner_id: rec.owner_id });
    res.json({ item: itemPublic(rec, { mine: true }) });
  } catch (e) { next(e); }
});

// 내리기(창작자)
router.post('/catalog/:id/close', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'catalog', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.owner_id !== req.user.uid) return res.status(403).json({ error: 'not_owner' });
    rec.data.status = 'closed';
    await repo.putRecord({ project_id: pid, collection: 'catalog', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===================== 획득(소유권 부여) =====================
// 무료/토큰 게이팅 획득
router.post('/catalog/:id/claim', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'catalog', req.params.id);
    if (!rec || (rec.data.status || 'open') !== 'open') return res.status(404).json({ error: 'not_available' });
    const d = rec.data;
    if (d.access === 'free') { await grant(pid, rec.doc_id, uid, 'free'); return res.json({ ok: true, via: 'free' }); }
    if (d.access === 'token') {
      const bal = await tokenBalance(pid, d.gateSymbol, uid);
      if (bal < (d.gateMin | 0)) return res.status(403).json({ error: 'need_token', message: `${d.gateSymbol} ${d.gateMin}개 이상 보유해야 합니다.`, need: d.gateMin, have: bal });
      await grant(pid, rec.doc_id, uid, 'token'); return res.json({ ok: true, via: 'token' });
    }
    return res.status(400).json({ error: 'not_claimable', message: '구매 또는 광고 시청이 필요합니다.' });
  } catch (e) { next(e); }
});

// ISC 결제 구매 → 소유권, 창작자 적립(수수료 제외)
router.post('/catalog/:id/buy', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'catalog', req.params.id);
    if (!rec || (rec.data.status || 'open') !== 'open') return res.status(404).json({ error: 'not_available' });
    const d = rec.data;
    if (d.access !== 'paid') return res.status(400).json({ error: 'not_paid', message: '유료 상품이 아닙니다.' });
    if (rec.owner_id === uid) return res.status(400).json({ error: 'self_buy', message: '본인 콘텐츠입니다.' });
    if (await isEntitled(pid, rec.doc_id, uid)) return res.status(409).json({ error: 'owned', message: '이미 보유 중입니다.' });
    const price = d.price | 0;
    const after = await debit(pid, uid, price, 'store_buy', rec.doc_id);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    const creatorGet = Math.round(price * (1 - FEE_RATE));
    await credit(pid, rec.owner_id, creatorGet, 'store_sold', rec.doc_id);
    d.revenue = (d.revenue | 0) + creatorGet;
    await repo.putRecord({ project_id: pid, collection: 'catalog', doc_id: rec.doc_id, data: d, owner_id: rec.owner_id });
    await grant(pid, rec.doc_id, uid, 'paid');
    broadcast(pid, `igstore:item:${rec.doc_id}`, { type: 'buy', downloads: d.downloads, ts: Date.now() });
    res.json({ ok: true, wallet: after, via: 'paid' });
  } catch (e) { next(e); }
});

// 광고 시청 후 해제 → 소유권(결제 없음). 창작자는 광고 리워드 없음(플랫폼 노출 수익 모델).
router.post('/catalog/:id/adview', requireUser, async (req, res, next) => {
  try {
    const { watchedMs } = req.body || {};
    if (typeof watchedMs !== 'number' || watchedMs < AD_MIN_WATCH_MS) return res.status(400).json({ error: 'too_short', message: '광고를 끝까지 시청해야 합니다.' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'catalog', req.params.id);
    if (!rec || (rec.data.status || 'open') !== 'open') return res.status(404).json({ error: 'not_available' });
    if (rec.data.access !== 'ad') return res.status(400).json({ error: 'not_ad', message: '광고 해제 상품이 아닙니다.' });
    if (await isEntitled(pid, rec.doc_id, uid)) return res.json({ ok: true, via: 'ad' });
    await repo.putRecord({ project_id: pid, collection: '_store_adview', doc_id: rec.doc_id + ':' + uid, data: { itemId: rec.doc_id, uid, ts: Date.now() }, owner_id: uid });
    await grant(pid, rec.doc_id, uid, 'ad');
    res.json({ ok: true, via: 'ad' });
  } catch (e) { next(e); }
});

// ===================== 다운로드(소유 검증) =====================
// GET /catalog/:id/download — 소유자만 페이로드(fileId→/api/files, 또는 externalUrl) 수령. 다운로드 수 증가.
router.get('/catalog/:id/download', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'catalog', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const mine = rec.owner_id === uid;
    const entitled = mine || await isEntitled(pid, rec.doc_id, uid);
    if (!entitled) return res.status(403).json({ error: 'not_entitled', message: '먼저 구매·획득해야 합니다.' });
    const d = rec.data;
    if (!d.fileId && !d.externalUrl) return res.status(404).json({ error: 'no_payload', message: '연결된 파일이 없습니다.' });
    if (!mine) await bumpDownloads(pid, repo, rec);
    res.json({ ok: true, kind: d.kind, title: d.title, fileUrl: d.fileId ? ('/api/files/' + d.fileId) : null, externalUrl: d.externalUrl || null });
  } catch (e) { next(e); }
});

// ===================== 내 라이브러리 =====================
// 내가 획득한 콘텐츠 + 내가 발행한 콘텐츠
router.get('/library', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const ents = await repo.queryRecords(pid, '_store_entitle', { ownerId: uid, limit: 300, sort: 'created_at:desc' });
    const owned = [];
    for (const e of ents) {
      const rec = await repo.getRecord(pid, 'catalog', e.data.itemId);
      if (rec) owned.push({ ...itemPublic(rec, { entitled: true }), via: e.data.via });
    }
    const mineRows = await repo.queryRecords(pid, 'catalog', { ownerId: uid, limit: 200, sort: 'created_at:desc' });
    res.json({ owned, published: mineRows.map((r) => itemPublic(r, { mine: true })) });
  } catch (e) { next(e); }
});

export default router;
