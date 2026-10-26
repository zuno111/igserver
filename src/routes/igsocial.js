// igSocial — SNS 공용 백엔드. aidia·CyLife·유튜브 도구 등 STUDIO ig SNS 계열이 공통으로 쓴다.
// 포스트/피드, 팔로우(팔로잉 피드), 좋아요·댓글, 멀티발행 타깃·상태 기록.
// 외부 플랫폼(인스타·X 등) 실제 게시는 각 플랫폼 커넥터/워커가 수행하고 여기에 상태를 보고한다
// (발행 레코드·상태 전이는 실제 동작, 외부 실게시는 커넥터 연결 지점).
//   posts        : 포스트 {text, media[fileId], author, authorName, likes, comments, ts}
//   _follow      : 팔로우 (doc_id = follower:followee) {follower, followee, ts}
//   _post_like   : 좋아요 (doc_id = postId:uid)
//   post_comments: 댓글 {postId, uid, name, text, ts}
//   social_pub   : 멀티발행 {postId, targets:[{platform,status,ref,error}], ts}
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';

const router = Router();
const PLATFORMS = ['instagram', 'x', 'facebook', 'threads', 'tiktok', 'youtube', 'linkedin', 'naverblog'];

function postPublic(r, { liked = false, mine = false } = {}) {
  const d = r.data || {};
  return { id: r.doc_id, text: d.text || '', media: d.media || [], author: r.owner_id, authorName: d.authorName || '익명',
    likes: d.likes | 0, comments: d.comments | 0, created_at: r.created_at, liked, mine };
}
async function isFollowing(pid, a, b) { return !!(await getRepo().getRecord(pid, '_follow', a + ':' + b)); }
async function liked(pid, postId, uid) { return uid ? !!(await getRepo().getRecord(pid, '_post_like', postId + ':' + uid)) : false; }

// ===================== 포스트 / 피드 =====================
// 전체 피드(최신). ?scope=following 이면 내가 팔로우한 사람 글만.
router.get('/feed', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user?.uid;
    const rows = await getRepo().queryRecords(pid, 'posts', { limit: 100, sort: 'created_at:desc' });
    let list = rows;
    if (req.query.scope === 'following' && uid) {
      const fol = await getRepo().queryRecords(pid, '_follow', { ownerId: uid, limit: 1000 });
      const set = new Set(fol.map((f) => f.data.followee));
      list = rows.filter((r) => set.has(r.owner_id) || r.owner_id === uid);
    }
    const out = [];
    for (const r of list) out.push(postPublic(r, { liked: await liked(pid, r.doc_id, uid), mine: uid && r.owner_id === uid }));
    res.json({ posts: out });
  } catch (e) { next(e); }
});
// 특정 유저의 글
router.get('/users/:uid/posts', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id;
    const rows = await getRepo().queryRecords(pid, 'posts', { ownerId: req.params.uid, limit: 100, sort: 'created_at:desc' });
    const out = [];
    for (const r of rows) out.push(postPublic(r, { liked: await liked(pid, r.doc_id, req.user?.uid) }));
    const followers = (await getRepo().queryRecords(pid, '_follow', { limit: 5000, filters: [['followee', 'eq', req.params.uid]] })).length;
    const following = (await getRepo().queryRecords(pid, '_follow', { ownerId: req.params.uid, limit: 5000 })).length;
    res.json({ posts: out, followers, following, isFollowing: req.user ? await isFollowing(pid, req.user.uid, req.params.uid) : false });
  } catch (e) { next(e); }
});
router.post('/posts', requireUser, async (req, res, next) => {
  try {
    const { text, media } = req.body || {};
    const t = String(text || '').trim();
    if (!t && !(Array.isArray(media) && media.length)) return res.status(400).json({ error: 'empty', message: '내용이나 미디어가 필요합니다.' });
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('po_');
    const d = { text: t.slice(0, 5000), media: Array.isArray(media) ? media.slice(0, 20) : [], authorName: req.user.name || '익명', likes: 0, comments: 0, ts: Date.now() };
    const rec = await getRepo().putRecord({ project_id: pid, collection: 'posts', doc_id: id, data: d, owner_id: uid });
    broadcast(pid, 'igsocial:feed', { type: 'post_new', id, author: uid, ts: Date.now() });
    res.status(201).json({ post: postPublic(rec, { mine: true }) });
  } catch (e) { next(e); }
});
router.delete('/posts/:id', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'posts', req.params.id);
    if (!rec || rec.owner_id !== req.user.uid) return res.status(404).json({ error: 'not_found' });
    await repo.deleteRecord(pid, 'posts', req.params.id, { hard: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===================== 좋아요 =====================
router.post('/posts/:id/like', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'posts', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const lid = req.params.id + ':' + uid;
    const had = await repo.getRecord(pid, '_post_like', lid);
    if (had) { await repo.deleteRecord(pid, '_post_like', lid, { hard: true }); rec.data.likes = Math.max(0, (rec.data.likes | 0) - 1); }
    else { await repo.putRecord({ project_id: pid, collection: '_post_like', doc_id: lid, data: { postId: req.params.id, uid, ts: Date.now() }, owner_id: uid }); rec.data.likes = (rec.data.likes | 0) + 1; }
    await repo.putRecord({ project_id: pid, collection: 'posts', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    res.json({ ok: true, liked: !had, likes: rec.data.likes });
  } catch (e) { next(e); }
});

// ===================== 댓글 =====================
router.get('/posts/:id/comments', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'post_comments', { limit: 200, sort: 'created_at:desc', filters: [['postId', 'eq', req.params.id]] });
    res.json({ comments: rows.map((r) => ({ id: r.doc_id, uid: r.data.uid, name: r.data.name, text: r.data.text, ts: r.data.ts })) });
  } catch (e) { next(e); }
});
router.post('/posts/:id/comments', requireUser, async (req, res, next) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'posts', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const id = randomId('cm_');
    await repo.putRecord({ project_id: pid, collection: 'post_comments', doc_id: id, data: { postId: req.params.id, uid, name: req.user.name || '익명', text: text.slice(0, 1000), ts: Date.now() }, owner_id: uid });
    rec.data.comments = (rec.data.comments | 0) + 1;
    await repo.putRecord({ project_id: pid, collection: 'posts', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    broadcast(pid, 'igsocial:post:' + req.params.id, { type: 'comment', ts: Date.now() });
    res.status(201).json({ ok: true, id });
  } catch (e) { next(e); }
});

// ===================== 팔로우 =====================
router.post('/follow/:uid', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, me = req.user.uid, target = req.params.uid;
    if (me === target) return res.status(400).json({ error: 'self' });
    const fid = me + ':' + target, repo = getRepo();
    const had = await repo.getRecord(pid, '_follow', fid);
    if (had) { await repo.deleteRecord(pid, '_follow', fid, { hard: true }); }
    else { await repo.putRecord({ project_id: pid, collection: '_follow', doc_id: fid, data: { follower: me, followee: target, ts: Date.now() }, owner_id: me }); }
    res.json({ ok: true, following: !had });
  } catch (e) { next(e); }
});

// ===================== 멀티발행 (aidia형) =====================
// 한 포스트를 여러 외부 플랫폼에 발행 예약. targets 각각 pending으로 큐잉.
router.post('/publish', requireUser, async (req, res, next) => {
  try {
    const { postId, text, media, platforms } = req.body || {};
    const plats = (Array.isArray(platforms) ? platforms : []).filter((p) => PLATFORMS.includes(p));
    if (!plats.length) return res.status(400).json({ error: 'no_platforms', message: '발행 대상 플랫폼이 필요합니다.' });
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('sp_');
    const d = { postId: postId || null, text: String(text || '').slice(0, 5000), media: Array.isArray(media) ? media.slice(0, 20) : [],
      targets: plats.map((p) => ({ platform: p, status: 'pending', ref: null, error: null })), ts: Date.now() };
    await getRepo().putRecord({ project_id: pid, collection: 'social_pub', doc_id: id, data: d, owner_id: uid });
    broadcast(pid, 'igsocial:publish:' + uid, { type: 'publish_new', id, platforms: plats, ts: Date.now() });
    res.status(201).json({ publish: { id, ...d } });
  } catch (e) { next(e); }
});
// 플랫폼별 결과 보고(커넥터/워커). status: pending|posted|failed, ref(외부 글 id), error.
router.post('/publish/:id/result', requireUser, async (req, res, next) => {
  try {
    const { platform, status, ref, error } = req.body || {};
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'social_pub', req.params.id);
    if (!rec || rec.owner_id !== uid) return res.status(404).json({ error: 'not_found' });
    const t = rec.data.targets.find((x) => x.platform === platform);
    if (!t) return res.status(400).json({ error: 'bad_platform' });
    if (status && ['pending', 'posted', 'failed'].includes(status)) t.status = status;
    if (ref != null) t.ref = String(ref).slice(0, 200);
    if (error != null) t.error = String(error).slice(0, 300);
    await repo.putRecord({ project_id: pid, collection: 'social_pub', doc_id: req.params.id, data: rec.data, owner_id: uid });
    res.json({ ok: true, targets: rec.data.targets });
  } catch (e) { next(e); }
});
router.get('/publish', requireUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'social_pub', { ownerId: req.user.uid, limit: 100, sort: 'created_at:desc' });
    res.json({ publishes: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});

export default router;
