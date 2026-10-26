// igGame — 게임 공용 백엔드. STUDIO ig 게임들(방치형·3D 웹게임·메타버스 등)이 공통으로 쓰는 기능.
// 리더보드(게임별 최고점·랭킹), 클라우드 세이브(유저별 슬롯), 멀티플레이 룸(기존 realtime ws 재사용).
// 경제는 공용 [[isc]] 재사용. 게임 자체 등록/판매는 [[igstore]] catalog(kind:game)로 한다.
//   gm_scores : 최고점 (doc_id = game:uid) {game, uid, name, score, meta, ts}
//   gm_saves  : 세이브 (doc_id = game:uid:slot) {game, uid, slot, data, ts}
//   gm_rooms  : 멀티 룸 (doc_id = roomId) {game, host, title, max, players[], status, ts} — 실시간은 ws room "game:<roomId>"
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';
import { credit } from '../isc.js';

const router = Router();
const SCORE_REWARD = 5;        // 자기 최고 기록 경신 시 ISC 보상
const SAVE_MAX_BYTES = 200000; // 세이브 슬롯 1개 최대 크기

// ===================== 리더보드 =====================
// 점수 제출: 기존 최고점보다 높을 때만 갱신. 갱신 시 ISC 소액 보상(최초/경신).
router.post('/scores', requireUser, async (req, res, next) => {
  try {
    const { game, score, meta } = req.body || {};
    const g = String(game || '').trim();
    const sc = Number(score);
    if (!g || !Number.isFinite(sc)) return res.status(400).json({ error: 'bad_score', message: '게임과 점수가 필요합니다.' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const id = g + ':' + uid;
    const prev = await repo.getRecord(pid, 'gm_scores', id);
    const best = prev?.data?.score;
    let improved = false;
    if (best == null || sc > best) {
      improved = true;
      await repo.putRecord({ project_id: pid, collection: 'gm_scores', doc_id: id, data: { game: g, uid, name: req.user.name || '익명', score: sc, meta: meta || null, ts: Date.now() }, owner_id: uid });
      await credit(pid, uid, SCORE_REWARD, 'game_best', g);
      broadcast(pid, 'iggame:board:' + g, { type: 'score', uid, score: sc, ts: Date.now() });
    }
    res.json({ ok: true, improved, best: improved ? sc : best });
  } catch (e) { next(e); }
});
// 랭킹: 게임별 상위 N (점수 내림차순)
router.get('/scores/:game', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, g = String(req.params.game);
    const limit = Math.min(100, parseInt(req.query.limit || '20', 10));
    const rows = await getRepo().queryRecords(pid, 'gm_scores', { limit: 500, filters: [['game', 'eq', g]] });
    const ranked = rows.map((r) => r.data).sort((a, b) => b.score - a.score).slice(0, limit)
      .map((d, i) => ({ rank: i + 1, uid: d.uid, name: d.name, score: d.score, meta: d.meta || null }));
    let me = null;
    if (req.user) {
      const all = rows.map((r) => r.data).sort((a, b) => b.score - a.score);
      const idx = all.findIndex((d) => d.uid === req.user.uid);
      if (idx >= 0) me = { rank: idx + 1, score: all[idx].score };
    }
    res.json({ game: g, leaderboard: ranked, me });
  } catch (e) { next(e); }
});

// ===================== 클라우드 세이브 =====================
// 저장(슬롯 기본 0): 유저별 게임별 세이브. data는 JSON(문자열화 크기 제한).
router.put('/saves/:game', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, g = String(req.params.game);
    const slot = String((req.body && req.body.slot) != null ? req.body.slot : 0).slice(0, 20);
    const data = req.body ? req.body.data : undefined;
    if (data === undefined) return res.status(400).json({ error: 'no_data' });
    if (JSON.stringify(data).length > SAVE_MAX_BYTES) return res.status(413).json({ error: 'too_big', message: '세이브 용량이 너무 큽니다.' });
    await getRepo().putRecord({ project_id: pid, collection: 'gm_saves', doc_id: g + ':' + uid + ':' + slot, data: { game: g, uid, slot, data, ts: Date.now() }, owner_id: uid });
    res.json({ ok: true, slot });
  } catch (e) { next(e); }
});
// 불러오기
router.get('/saves/:game', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, g = String(req.params.game);
    const slot = String(req.query.slot != null ? req.query.slot : 0).slice(0, 20);
    const rec = await getRepo().getRecord(pid, 'gm_saves', g + ':' + uid + ':' + slot);
    if (!rec) return res.status(404).json({ error: 'no_save' });
    res.json({ save: rec.data });
  } catch (e) { next(e); }
});
// 내 세이브 슬롯 목록
router.get('/saves', requireUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'gm_saves', { ownerId: req.user.uid, limit: 100, sort: 'created_at:desc' });
    res.json({ saves: rows.map((r) => ({ game: r.data.game, slot: r.data.slot, ts: r.data.ts })) });
  } catch (e) { next(e); }
});

// ===================== 멀티플레이 룸 =====================
// 실시간 메시징은 기존 ws room "game:<roomId>"를 그대로 구독한다. 여기서는 룸 레지스트리만 관리.
router.get('/rooms', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, g = req.query.game;
    const filters = g ? [['game', 'eq', String(g)]] : undefined;
    const rows = await getRepo().queryRecords(pid, 'gm_rooms', { limit: 100, sort: 'created_at:desc', filters });
    const open = rows.map((r) => r.data).filter((d) => d.status === 'open');
    res.json({ rooms: open });
  } catch (e) { next(e); }
});
router.post('/rooms', requireUser, async (req, res, next) => {
  try {
    const { game, title, max } = req.body || {};
    const g = String(game || '').trim(); if (!g) return res.status(400).json({ error: 'bad_game' });
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('room_');
    const data = { id, game: g, host: uid, hostName: req.user.name || '익명', title: String(title || (g + ' 방')).slice(0, 60), max: Math.min(64, Math.max(2, max | 0 || 8)), players: [uid], status: 'open', ts: Date.now() };
    await getRepo().putRecord({ project_id: pid, collection: 'gm_rooms', doc_id: id, data, owner_id: uid });
    broadcast(pid, 'iggame:rooms:' + g, { type: 'room_new', id, title: data.title, ts: Date.now() });
    res.status(201).json({ room: data, wsRoom: 'game:' + id });
  } catch (e) { next(e); }
});
router.post('/rooms/:id/join', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'gm_rooms', req.params.id);
    if (!rec || rec.data.status !== 'open') return res.status(404).json({ error: 'no_room' });
    if (!rec.data.players.includes(uid)) {
      if (rec.data.players.length >= rec.data.max) return res.status(409).json({ error: 'full', message: '방이 가득 찼습니다.' });
      rec.data.players.push(uid);
      await repo.putRecord({ project_id: pid, collection: 'gm_rooms', doc_id: req.params.id, data: rec.data, owner_id: rec.data.host });
      broadcast(pid, 'game:' + req.params.id, { type: 'join', uid, name: req.user.name || '익명', count: rec.data.players.length, ts: Date.now() });
    }
    res.json({ ok: true, room: rec.data, wsRoom: 'game:' + req.params.id });
  } catch (e) { next(e); }
});
router.post('/rooms/:id/leave', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'gm_rooms', req.params.id);
    if (!rec) return res.status(404).json({ error: 'no_room' });
    rec.data.players = rec.data.players.filter((p) => p !== uid);
    // 방장이 나가거나 비면 닫기
    if (rec.data.host === uid || rec.data.players.length === 0) rec.data.status = 'closed';
    await repo.putRecord({ project_id: pid, collection: 'gm_rooms', doc_id: req.params.id, data: rec.data, owner_id: rec.data.host });
    broadcast(pid, 'game:' + req.params.id, { type: 'leave', uid, count: rec.data.players.length, status: rec.data.status, ts: Date.now() });
    res.json({ ok: true, status: rec.data.status });
  } catch (e) { next(e); }
});

export default router;
