// igLive — 라이브 방송 + 라이브 커머스 + 선물(후원).
// 실제 영상 송출은 프론트의 P2P(WebRTC/PeerJS)로 하고, 여기서는 세션 레지스트리·시청자·채팅·
// 연결 상품·선물(ISC)을 관리한다. 시청자는 세션의 peerId로 방송자에 직접 붙는다.
// 채팅/선물/시청자수는 실시간 WS room 'live:<id>' 로 브로드캐스트.
//   live_sessions : {title, hostName, status(live|ended), live, peerId, productId, geo, watching, peak, startedAt, endedAt}
//   live_chat     : 최근 채팅 (append-only, 방별)
//   _live_gift    : 선물 원장(server-only)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';
import { credit, debit } from '../isc.js';
import { cleanGeo } from './igplay.js';

const router = Router();

function sessionPublic(rec) {
  if (!rec) return null;
  const d = rec.data || {};
  return {
    id: rec.doc_id, title: d.title, hostId: rec.owner_id, hostName: d.hostName || '익명',
    status: d.status || 'live', live: d.status !== 'ended', peerId: d.peerId || null,
    productId: d.productId || null, geo: d.geo || null, watching: d.watching | 0, peak: d.peak | 0,
    startedAt: d.startedAt || rec.created_at, endedAt: d.endedAt || null, cover: d.cover || null,
  };
}

// 현재 라이브 목록
router.get('/sessions', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'live_sessions', { limit: 100, sort: 'created_at:desc' });
    res.json({ sessions: rows.map(sessionPublic).filter((s) => s.live) });
  } catch (e) { next(e); }
});
router.get('/sessions/:id', optionalUser, async (req, res, next) => {
  try {
    const rec = await getRepo().getRecord(req.project.id, 'live_sessions', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json({ session: sessionPublic(rec) });
  } catch (e) { next(e); }
});
// 방송 시작: peerId(P2P 송출 식별자), 연결 상품(igStore catalog id), 위치(선택)
router.post('/sessions', requireUser, async (req, res, next) => {
  try {
    const { title, peerId, productId, geo, cover } = req.body || {};
    if (!title) return res.status(400).json({ error: 'bad_title', message: '방송 제목이 필요합니다.' });
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('lv_');
    const data = { title: String(title).slice(0, 80), hostName: req.user.name || '익명', status: 'live',
      peerId: peerId ? String(peerId).slice(0, 120) : null, productId: productId ? String(productId).slice(0, 80) : null,
      geo: cleanGeo(geo), cover: (typeof cover === 'string' && cover.length < 900000) ? cover : null,
      watching: 0, peak: 0, startedAt: Date.now(), endedAt: null };
    const rec = await getRepo().putRecord({ project_id: pid, collection: 'live_sessions', doc_id: id, data, owner_id: uid });
    broadcast(pid, 'iglive:sessions', { type: 'live_start', id, title: data.title, ts: Date.now() });
    res.status(201).json({ session: sessionPublic(rec) });
  } catch (e) { next(e); }
});
// 방송 종료(방송자)
router.post('/sessions/:id/stop', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'live_sessions', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.owner_id !== req.user.uid) return res.status(403).json({ error: 'not_owner' });
    rec.data.status = 'ended'; rec.data.endedAt = Date.now(); rec.data.watching = 0;
    await repo.putRecord({ project_id: pid, collection: 'live_sessions', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    broadcast(pid, 'live:' + req.params.id, { type: 'live_end', ts: Date.now() });
    broadcast(pid, 'iglive:sessions', { type: 'live_end', id: req.params.id, ts: Date.now() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// 상품/제목 갱신(라이브 커머스: 방송 중 상품 교체)
router.post('/sessions/:id/product', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'live_sessions', req.params.id);
    if (!rec || rec.owner_id !== req.user.uid) return res.status(rec ? 403 : 404).json({ error: rec ? 'not_owner' : 'not_found' });
    rec.data.productId = req.body && req.body.productId ? String(req.body.productId).slice(0, 80) : null;
    await repo.putRecord({ project_id: pid, collection: 'live_sessions', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    broadcast(pid, 'live:' + req.params.id, { type: 'product', productId: rec.data.productId, ts: Date.now() });
    res.json({ ok: true, productId: rec.data.productId });
  } catch (e) { next(e); }
});
// 시청 시작: 시청자수 증가 + peerId/상품 반환(시청자는 이걸로 P2P 접속)
router.post('/sessions/:id/join', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'live_sessions', req.params.id);
    if (!rec || rec.data.status === 'ended') return res.status(404).json({ error: 'not_live' });
    rec.data.watching = (rec.data.watching | 0) + 1;
    if (rec.data.watching > (rec.data.peak | 0)) rec.data.peak = rec.data.watching;
    await repo.putRecord({ project_id: pid, collection: 'live_sessions', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    broadcast(pid, 'live:' + req.params.id, { type: 'viewers', watching: rec.data.watching, ts: Date.now() });
    res.json({ ok: true, peerId: rec.data.peerId, productId: rec.data.productId, watching: rec.data.watching });
  } catch (e) { next(e); }
});
router.post('/sessions/:id/leave', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'live_sessions', req.params.id);
    if (!rec) return res.json({ ok: true });
    rec.data.watching = Math.max(0, (rec.data.watching | 0) - 1);
    await repo.putRecord({ project_id: pid, collection: 'live_sessions', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    broadcast(pid, 'live:' + req.params.id, { type: 'viewers', watching: rec.data.watching, ts: Date.now() });
    res.json({ ok: true, watching: rec.data.watching });
  } catch (e) { next(e); }
});
// 채팅: 저장 + 실시간 브로드캐스트
router.get('/sessions/:id/chat', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'live_chat', { limit: 50, sort: 'created_at:desc', filters: [['room', 'eq', req.params.id]] });
    res.json({ chat: rows.map((r) => r.data).reverse() });
  } catch (e) { next(e); }
});
router.post('/sessions/:id/chat', requireUser, async (req, res, next) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty' });
    const pid = req.project.id, uid = req.user.uid;
    const msg = { room: req.params.id, uid, name: req.user.name || '익명', text: text.slice(0, 300), ts: Date.now() };
    await getRepo().putRecord({ project_id: pid, collection: 'live_chat', doc_id: randomId('lc_'), data: msg, owner_id: uid });
    broadcast(pid, 'live:' + req.params.id, { type: 'chat', ...msg });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
// 선물(후원): 시청자 ISC 차감 → 방송자 적립. 라이브에 애니메이션 브로드캐스트.
router.post('/sessions/:id/gift', requireUser, async (req, res, next) => {
  try {
    const amt = Math.round((req.body && req.body.amount) || 0);
    if (amt < 1) return res.status(400).json({ error: 'bad_amount' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'live_sessions', req.params.id);
    if (!rec || rec.data.status === 'ended') return res.status(404).json({ error: 'not_live' });
    if (rec.owner_id === uid) return res.status(400).json({ error: 'self_gift', message: '본인 방송에는 선물할 수 없습니다.' });
    const after = await debit(pid, uid, amt, 'live_gift', req.params.id);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    await credit(pid, rec.owner_id, amt, 'live_gift_recv', req.params.id);
    await repo.putRecord({ project_id: pid, collection: '_live_gift', doc_id: randomId('gf_'), data: { room: req.params.id, from: uid, name: req.user.name || '익명', amount: amt, ts: Date.now() }, owner_id: uid });
    broadcast(pid, 'live:' + req.params.id, { type: 'gift', name: req.user.name || '익명', amount: amt, ts: Date.now() });
    res.json({ ok: true, wallet: after });
  } catch (e) { next(e); }
});

export default router;
