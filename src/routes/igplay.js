// igPlay + ISC 모듈.
// UGC 블록/복셀 레벨 플랫폼(igPlay)과 인디 토큰 경제(ISC, IndieStreamCoin)를 한 라우트로 묶는다.
// 핵심: ISC 잔액/적립/차감은 전부 서버가 권한을 쥔다. 클라이언트는 이벤트만 보고하고,
//       적립량은 서버의 EARN 규칙으로 계산해 지갑에 반영한다(클라가 잔액을 못 쓴다).
// 저장: igServer 범용 레코드 스토어(getRepo) 재사용.
//   levels        : 유저 제작 레벨 (owner_id = 제작자 uid)
//   comments      : 레벨 댓글
//   times         : 클리어 타임(랭킹)
//   _isc_wallet   : 지갑 (doc_id = uid)            ← 서버 전용(_ 접두사: 제네릭 /api/data 쓰기 차단)
//   _isc_ledger   : 적립/차감 원장(append-only)    ← 서버 전용
//   _isc_like     : 좋아요 중복 방지 (doc_id = levelId:uid)
//   _isc_playlog  : 플레이 적립 쿨다운 (doc_id = uid:levelId)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';

const router = Router();

// ---- 서버 권한 경제 규칙 (igPlay 프론트 EARN/SKINS와 동일해야 함) ----
const EARN = { play: 2, clear: 15, firstClear: 40, likeGiven: 1, creatorPerPlay: 3, creatorPerClear: 8 };
const SKINS = {
  classic: { price: 0 }, mint: { price: 60 }, violet: { price: 90 },
  gold: { price: 150 }, crimson: { price: 150 }, ice: { price: 220 },
};
const START_ISC = 120;
const PLAY_COOLDOWN_MS = 60 * 1000;   // 같은 레벨 플레이 적립 쿨다운(어뷰징 방지)
const BOOST_MS = 24 * 3600 * 1000;
const BOOST_COST = 50;
const TIP_MIN = 1, TIP_MAX = 1000;

// ---- 지갑 헬퍼 (서버 전용) ----
async function getWallet(pid, uid) {
  const rec = await getRepo().getRecord(pid, '_isc_wallet', uid);
  if (rec && rec.data) return { balance: rec.data.balance | 0, skins: rec.data.skins || ['classic'], skin: rec.data.skin || 'classic' };
  return { balance: START_ISC, skins: ['classic'], skin: 'classic' };
}
async function putWallet(pid, uid, w) {
  await getRepo().putRecord({ project_id: pid, collection: '_isc_wallet', doc_id: uid, data: w, owner_id: uid });
  return w;
}
async function ledger(pid, uid, delta, reason, ref) {
  await getRepo().putRecord({
    project_id: pid, collection: '_isc_ledger', doc_id: randomId('l_'),
    data: { uid, delta, reason, ref: ref || null, ts: Date.now() }, owner_id: uid,
  });
}
// 적립: 지갑 반영 + 원장 기록 + 실시간 알림
async function credit(pid, uid, amount, reason, ref) {
  if (!uid || amount <= 0) return null;
  const w = await getWallet(pid, uid);
  w.balance += amount;
  await putWallet(pid, uid, w);
  await ledger(pid, uid, amount, reason, ref);
  broadcast(pid, `isc:${uid}`, { type: 'isc_changed', balance: w.balance, delta: amount, reason, ts: Date.now() });
  return w;
}
// 차감: 잔액 부족이면 null
async function debit(pid, uid, amount, reason, ref) {
  const w = await getWallet(pid, uid);
  if (w.balance < amount) return null;
  w.balance -= amount;
  await putWallet(pid, uid, w);
  await ledger(pid, uid, -amount, reason, ref);
  broadcast(pid, `isc:${uid}`, { type: 'isc_changed', balance: w.balance, delta: -amount, reason, ts: Date.now() });
  return w;
}

function levelPublic(rec) {
  if (!rec) return null;
  const d = rec.data || {};
  return {
    id: rec.doc_id, title: d.title, creator: d.creator, creatorId: rec.owner_id,
    genre: d.genre, difficulty: d.difficulty, voxels: d.voxels || [], spawn: d.spawn || null,
    desc: d.desc || '', plays: d.plays | 0, likes: d.likes | 0,
    boostedUntil: d.boostedUntil || 0, created_at: rec.created_at,
  };
}
const GENRES = ['파쿠르', '수집', '입문', '어드벤처', '스피드런'];
const DIFFS = ['쉬움', '보통', '어려움', '전문가'];

// ===================== 레벨 =====================
// 목록 (부스트 우선)
router.get('/levels', optionalUser, async (req, res, next) => {
  try {
    const repo = getRepo();
    const rows = await repo.queryRecords(req.project.id, 'levels', { limit: 200, sort: 'created_at:desc' });
    const list = rows.map(levelPublic);
    const now = Date.now();
    list.sort((a, b) => ((b.boostedUntil > now) ? 1 : 0) - ((a.boostedUntil > now) ? 1 : 0));
    res.json({ levels: list });
  } catch (e) { next(e); }
});
// 단건
router.get('/levels/:id', optionalUser, async (req, res, next) => {
  try {
    const rec = await getRepo().getRecord(req.project.id, 'levels', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    res.json({ level: levelPublic(rec) });
  } catch (e) { next(e); }
});
// 업로드
router.post('/levels', requireUser, async (req, res, next) => {
  try {
    const { title, genre, difficulty, voxels, spawn, desc } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'bad_title', message: '제목이 필요합니다.' });
    if (!Array.isArray(voxels) || !voxels.length) return res.status(400).json({ error: 'bad_voxels', message: '블록 데이터가 필요합니다.' });
    if (!voxels.some((b) => b && (b.t === 1 || b.t === 2))) return res.status(400).json({ error: 'no_ground', message: '지면 블록이 필요합니다.' });
    if (!voxels.some((b) => b && b.t === 4)) return res.status(400).json({ error: 'no_goal', message: '골 블록이 필요합니다.' });
    const repo = getRepo();
    const id = randomId('lv_');
    const data = {
      title: String(title).slice(0, 80), creator: req.user.name || '익명',
      genre: GENRES.includes(genre) ? genre : '어드벤처',
      difficulty: DIFFS.includes(difficulty) ? difficulty : '보통',
      voxels: voxels.slice(0, 20000), spawn: spawn || null, desc: String(desc || '').slice(0, 500),
      plays: 0, likes: 0, boostedUntil: 0,
    };
    const rec = await repo.putRecord({ project_id: req.project.id, collection: 'levels', doc_id: id, data, owner_id: req.user.uid });
    broadcast(req.project.id, 'igplay:levels', { type: 'level_new', id, title: data.title, ts: Date.now() });
    res.status(201).json({ level: levelPublic(rec) });
  } catch (e) { next(e); }
});

// ===================== 이벤트 → ISC 적립 (서버 권한) =====================
// body: { type: 'play'|'clear', levelId, coins, total }
router.post('/events', requireUser, async (req, res, next) => {
  try {
    const { type, levelId, coins = 0, total = 0 } = req.body || {};
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const lv = levelId ? await repo.getRecord(pid, 'levels', levelId) : null;
    const creatorId = lv ? lv.owner_id : null;
    let reward = 0, first = false;

    if (type === 'play') {
      // 플레이 수 증가
      if (lv) { lv.data.plays = (lv.data.plays | 0) + 1; await repo.putRecord({ project_id: pid, collection: 'levels', doc_id: levelId, data: lv.data, owner_id: creatorId }); }
      // 적립 쿨다운 확인
      const stampId = uid + ':' + (levelId || 'x');
      const stamp = await repo.getRecord(pid, '_isc_playlog', stampId);
      const last = stamp?.data?.ts || 0;
      if (Date.now() - last >= PLAY_COOLDOWN_MS) {
        reward = EARN.play;
        await repo.putRecord({ project_id: pid, collection: '_isc_playlog', doc_id: stampId, data: { ts: Date.now() }, owner_id: uid });
        if (reward) await credit(pid, uid, reward, 'play', levelId);
        if (creatorId && creatorId !== uid) await credit(pid, creatorId, EARN.creatorPerPlay, 'creator_play', levelId);
      }
    } else if (type === 'clear') {
      // 첫 클리어 판정
      const fcId = uid + ':' + (levelId || 'x');
      const fc = await repo.getRecord(pid, '_isc_firstclear', fcId);
      first = !fc;
      if (first) await repo.putRecord({ project_id: pid, collection: '_isc_firstclear', doc_id: fcId, data: { ts: Date.now() }, owner_id: uid });
      const ratio = total > 0 ? Math.max(0, Math.min(1, coins / total)) : 0;
      reward = EARN.clear + Math.round(ratio * 10) + (first ? EARN.firstClear : 0);
      await credit(pid, uid, reward, 'clear', levelId);
      if (creatorId && creatorId !== uid) await credit(pid, creatorId, EARN.creatorPerClear, 'creator_clear', levelId);
    } else {
      return res.status(400).json({ error: 'bad_type' });
    }
    const w = await getWallet(pid, uid);
    res.json({ ok: true, reward, first, wallet: w });
  } catch (e) { next(e); }
});

// ===================== 랭킹 =====================
// 타임 제출
router.post('/times', requireUser, async (req, res, next) => {
  try {
    const { levelId, ms } = req.body || {};
    if (!levelId || typeof ms !== 'number' || ms <= 0) return res.status(400).json({ error: 'bad_time' });
    const pid = req.project.id;
    await getRepo().putRecord({ project_id: pid, collection: 'times', doc_id: randomId('t_'),
      data: { levelId, uid: req.user.uid, name: req.user.name || '익명', ms: Math.round(ms) }, owner_id: req.user.uid });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
// 레벨 랭킹 (타임 오름차순 top N)
router.get('/ranking/:levelId', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'times', { limit: 500,
      filters: [['levelId', 'eq', req.params.levelId]] });
    const times = rows.map((r) => r.data).filter(Boolean).sort((a, b) => a.ms - b.ms).slice(0, 20);
    res.json({ ranking: times });
  } catch (e) { next(e); }
});

// ===================== 댓글 =====================
router.get('/comments/:levelId', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'comments', { limit: 200, sort: 'created_at:desc',
      filters: [['levelId', 'eq', req.params.levelId]] });
    res.json({ comments: rows.map((r) => ({ id: r.doc_id, ...r.data, created_at: r.created_at })) });
  } catch (e) { next(e); }
});
router.post('/comments', requireUser, async (req, res, next) => {
  try {
    const { levelId, body } = req.body || {};
    if (!levelId || !body || !String(body).trim()) return res.status(400).json({ error: 'bad_comment' });
    const rec = await getRepo().putRecord({ project_id: req.project.id, collection: 'comments', doc_id: randomId('c_'),
      data: { levelId, uid: req.user.uid, name: req.user.name || '익명', body: String(body).slice(0, 500) }, owner_id: req.user.uid });
    broadcast(req.project.id, `igplay:comments:${levelId}`, { type: 'comment_new', levelId, ts: Date.now() });
    res.status(201).json({ comment: { id: rec.doc_id, ...rec.data, created_at: rec.created_at } });
  } catch (e) { next(e); }
});

// ===================== 좋아요 =====================
router.post('/like', requireUser, async (req, res, next) => {
  try {
    const { levelId } = req.body || {};
    if (!levelId) return res.status(400).json({ error: 'bad_level' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const likeId = levelId + ':' + uid;
    const existing = await repo.getRecord(pid, '_isc_like', likeId);
    const lv = await repo.getRecord(pid, 'levels', levelId);
    if (existing) {
      await repo.deleteRecord(pid, '_isc_like', likeId, { hard: true });
      if (lv) { lv.data.likes = Math.max(0, (lv.data.likes | 0) - 1); await repo.putRecord({ project_id: pid, collection: 'levels', doc_id: levelId, data: lv.data, owner_id: lv.owner_id }); }
      return res.json({ liked: false, likes: lv ? lv.data.likes : 0 });
    }
    await repo.putRecord({ project_id: pid, collection: '_isc_like', doc_id: likeId, data: { ts: Date.now() }, owner_id: uid });
    if (lv) { lv.data.likes = (lv.data.likes | 0) + 1; await repo.putRecord({ project_id: pid, collection: 'levels', doc_id: levelId, data: lv.data, owner_id: lv.owner_id }); }
    await credit(pid, uid, EARN.likeGiven, 'like', levelId);
    res.json({ liked: true, likes: lv ? lv.data.likes : 1 });
  } catch (e) { next(e); }
});

// ===================== 지갑 / 상점 =====================
router.get('/wallet', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid;
    const w = await getWallet(pid, uid);
    const led = await getRepo().queryRecords(pid, '_isc_ledger', { ownerId: uid, limit: 20, sort: 'created_at:desc' });
    res.json({ wallet: w, ledger: led.map((r) => r.data) });
  } catch (e) { next(e); }
});
router.post('/shop/buy', requireUser, async (req, res, next) => {
  try {
    const { skinId } = req.body || {};
    const sk = SKINS[skinId];
    if (!sk) return res.status(400).json({ error: 'bad_skin' });
    const pid = req.project.id, uid = req.user.uid;
    let w = await getWallet(pid, uid);
    if (w.skins.includes(skinId)) return res.status(409).json({ error: 'owned', message: '이미 보유한 스킨입니다.' });
    const after = await debit(pid, uid, sk.price, 'buy_skin', skinId);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    after.skins = after.skins.concat([skinId]); after.skin = skinId;
    await putWallet(pid, uid, after);
    res.json({ wallet: after });
  } catch (e) { next(e); }
});
router.post('/shop/equip', requireUser, async (req, res, next) => {
  try {
    const { skinId } = req.body || {};
    const pid = req.project.id, uid = req.user.uid;
    const w = await getWallet(pid, uid);
    if (!w.skins.includes(skinId)) return res.status(400).json({ error: 'not_owned' });
    w.skin = skinId; await putWallet(pid, uid, w);
    res.json({ wallet: w });
  } catch (e) { next(e); }
});
// 후원: tipper 차감 → creator 적립
router.post('/tip', requireUser, async (req, res, next) => {
  try {
    const { levelId, amount } = req.body || {};
    const amt = Math.round(amount || 0);
    if (amt < TIP_MIN || amt > TIP_MAX) return res.status(400).json({ error: 'bad_amount' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const lv = await repo.getRecord(pid, 'levels', levelId);
    if (!lv) return res.status(404).json({ error: 'no_level' });
    if (lv.owner_id === uid) return res.status(400).json({ error: 'self_tip', message: '본인 레벨에는 후원할 수 없습니다.' });
    const after = await debit(pid, uid, amt, 'tip', levelId);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    await credit(pid, lv.owner_id, amt, 'tip_received', levelId);
    res.json({ ok: true, wallet: after });
  } catch (e) { next(e); }
});
// 부스트: owner 차감 → 레벨 상위 노출
router.post('/boost', requireUser, async (req, res, next) => {
  try {
    const { levelId } = req.body || {};
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const lv = await repo.getRecord(pid, 'levels', levelId);
    if (!lv) return res.status(404).json({ error: 'no_level' });
    if (lv.owner_id !== uid) return res.status(403).json({ error: 'not_owner' });
    if ((lv.data.boostedUntil || 0) > Date.now()) return res.status(409).json({ error: 'already_boosted' });
    const after = await debit(pid, uid, BOOST_COST, 'boost', levelId);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    lv.data.boostedUntil = Date.now() + BOOST_MS;
    await repo.putRecord({ project_id: pid, collection: 'levels', doc_id: levelId, data: lv.data, owner_id: uid });
    res.json({ ok: true, boostedUntil: lv.data.boostedUntil, wallet: after });
  } catch (e) { next(e); }
});

export default router;
