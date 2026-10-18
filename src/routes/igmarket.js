// igMarket 모듈.
// STUDIO ig 디지털 제품/프로젝트 투자 매칭 마켓. igPlay 레벨·채널을 ISC로 거래·투자한다.
// 핵심: 창작자가 자기 레벨(또는 채널/프로젝트)을 매물로 등록(자동 등록 포함) → 다른 유저가 ISC로 구매 또는 투자(지분).
// 경제는 공용 [[isc]] 레이어 재사용(서버 권한). 매물/거래/투자 기록은 범용 레코드 스토어.
//   listings  : 매물 {kind:'level'|'channel'|'project', refId, title, cover, mode:'sale'|'invest', price, raised, goal, ownerId, status}
//   _mkt_trade: 거래 원장 (append-only)
//   _mkt_share: 투자 지분 (doc_id = listingId:uid)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';
import { credit, debit, getWallet } from '../isc.js';

const router = Router();
const KINDS = ['level', 'channel', 'project'];
const MODES = ['sale', 'invest'];
const FEE_RATE = 0.05; // 거래 수수료 5% (플랫폼 소각/보관)

function listingPublic(rec) {
  if (!rec) return null;
  const d = rec.data || {};
  return {
    id: rec.doc_id, kind: d.kind, refId: d.refId || null, title: d.title, cover: d.cover || null,
    mode: d.mode, price: d.price | 0, goal: d.goal | 0, raised: d.raised | 0,
    ownerId: rec.owner_id, ownerName: d.ownerName || '', status: d.status || 'open',
    desc: d.desc || '', created_at: rec.created_at, backers: d.backers | 0,
  };
}

// 목록 (열린 매물 우선)
router.get('/listings', optionalUser, async (req, res, next) => {
  try {
    const kind = req.query.kind;
    const filters = KINDS.includes(kind) ? [['kind', 'eq', kind]] : undefined;
    const rows = await getRepo().queryRecords(req.project.id, 'listings', { limit: 200, sort: 'created_at:desc', filters });
    res.json({ listings: rows.map(listingPublic) });
  } catch (e) { next(e); }
});
// 단건
router.get('/listings/:id', optionalUser, async (req, res, next) => {
  try {
    const rec = await getRepo().getRecord(req.project.id, 'listings', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json({ listing: listingPublic(rec) });
  } catch (e) { next(e); }
});
// 매물 등록 (igPlay 레벨/채널/프로젝트 자동 등록 포함)
router.post('/listings', requireUser, async (req, res, next) => {
  try {
    const { kind, refId, title, cover, mode, price, goal, desc } = req.body || {};
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind' });
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'bad_mode' });
    if (!title) return res.status(400).json({ error: 'bad_title', message: '제목이 필요합니다.' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    // 레벨 매물이면 소유권 검증(자기 레벨만)
    if (kind === 'level' && refId) {
      const lv = await repo.getRecord(pid, 'levels', refId);
      if (lv && lv.owner_id !== uid) return res.status(403).json({ error: 'not_owner', message: '본인 레벨만 등록할 수 있습니다.' });
      // 중복 등록 방지
      const dup = await repo.queryRecords(pid, 'listings', { limit: 1, filters: [['refId', 'eq', refId]] });
      if (dup.length && (dup[0].data.status || 'open') === 'open') return res.status(409).json({ error: 'already_listed', message: '이미 마켓에 등록된 레벨입니다.' });
    }
    const id = randomId('mk_');
    const data = {
      kind, refId: refId || null, title: String(title).slice(0, 80), cover: (typeof cover === 'string' && cover.length < 900000) ? cover : null,
      mode, price: mode === 'sale' ? Math.max(1, price | 0) : 0, goal: mode === 'invest' ? Math.max(1, goal | 0) : 0,
      raised: 0, backers: 0, ownerName: req.user.name || '익명', status: 'open', desc: String(desc || '').slice(0, 500),
    };
    const rec = await repo.putRecord({ project_id: pid, collection: 'listings', doc_id: id, data, owner_id: uid });
    broadcast(pid, 'igmarket:listings', { type: 'listing_new', id, title: data.title, kind, ts: Date.now() });
    res.status(201).json({ listing: listingPublic(rec) });
  } catch (e) { next(e); }
});
// 매물 내리기
router.post('/listings/:id/close', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'listings', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.owner_id !== req.user.uid) return res.status(403).json({ error: 'not_owner' });
    rec.data.status = 'closed';
    await repo.putRecord({ project_id: pid, collection: 'listings', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 구매 (sale) — 구매자 ISC 차감 → 수수료 제외하고 판매자 적립, 레벨 소유권 이전(옵션)
router.post('/listings/:id/buy', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'listings', req.params.id);
    if (!rec || (rec.data.status || 'open') !== 'open') return res.status(404).json({ error: 'not_available' });
    if (rec.data.mode !== 'sale') return res.status(400).json({ error: 'not_for_sale' });
    if (rec.owner_id === uid) return res.status(400).json({ error: 'self_buy', message: '본인 매물은 구매할 수 없습니다.' });
    const price = rec.data.price | 0;
    const after = await debit(pid, uid, price, 'mkt_buy', req.params.id);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    const sellerGet = Math.round(price * (1 - FEE_RATE));
    await credit(pid, rec.owner_id, sellerGet, 'mkt_sold', req.params.id);
    // 레벨 소유권 이전
    if (rec.data.kind === 'level' && rec.data.refId) {
      const lv = await repo.getRecord(pid, 'levels', rec.data.refId);
      if (lv) { lv.data.creator = req.user.name || '익명'; await repo.putRecord({ project_id: pid, collection: 'levels', doc_id: rec.data.refId, data: lv.data, owner_id: uid }); }
    }
    rec.data.status = 'sold';
    await repo.putRecord({ project_id: pid, collection: 'listings', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    await repo.putRecord({ project_id: pid, collection: '_mkt_trade', doc_id: randomId('tr_'), data: { listingId: req.params.id, buyer: uid, seller: rec.owner_id, price, ts: Date.now() }, owner_id: uid });
    res.json({ ok: true, wallet: after });
  } catch (e) { next(e); }
});

// 투자 (invest) — 금액만큼 ISC 차감 → 매물 raised 증가, 지분 기록. 목표 도달 시 funded.
router.post('/listings/:id/invest', requireUser, async (req, res, next) => {
  try {
    const { amount } = req.body || {};
    const amt = Math.round(amount || 0);
    if (amt < 1) return res.status(400).json({ error: 'bad_amount' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'listings', req.params.id);
    if (!rec || (rec.data.status || 'open') !== 'open') return res.status(404).json({ error: 'not_available' });
    if (rec.data.mode !== 'invest') return res.status(400).json({ error: 'not_invest' });
    if (rec.owner_id === uid) return res.status(400).json({ error: 'self_invest', message: '본인 매물에는 투자할 수 없습니다.' });
    const after = await debit(pid, uid, amt, 'mkt_invest', req.params.id);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    // 지분 기록(누적)
    const shId = req.params.id + ':' + uid;
    const sh = await repo.getRecord(pid, '_mkt_share', shId);
    const prev = sh?.data?.amount || 0;
    await repo.putRecord({ project_id: pid, collection: '_mkt_share', doc_id: shId, data: { listingId: req.params.id, uid, name: req.user.name || '익명', amount: prev + amt, ts: Date.now() }, owner_id: uid });
    // 매물 모금액/후원자 갱신
    rec.data.raised = (rec.data.raised | 0) + amt;
    if (!prev) rec.data.backers = (rec.data.backers | 0) + 1;
    if (rec.data.raised >= (rec.data.goal | 0)) rec.data.status = 'funded';
    await repo.putRecord({ project_id: pid, collection: 'listings', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    // 모금액은 창작자에게 적립(간단 모델: 즉시 지급)
    await credit(pid, rec.owner_id, amt, 'mkt_raised', req.params.id);
    broadcast(pid, `igmarket:listing:${req.params.id}`, { type: 'invest', raised: rec.data.raised, goal: rec.data.goal, ts: Date.now() });
    res.json({ ok: true, wallet: after, raised: rec.data.raised, goal: rec.data.goal, status: rec.data.status });
  } catch (e) { next(e); }
});

// 내 지분 목록
router.get('/myshares', requireUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, '_mkt_share', { ownerId: req.user.uid, limit: 100, sort: 'created_at:desc' });
    res.json({ shares: rows.map((r) => r.data) });
  } catch (e) { next(e); }
});

export default router;
