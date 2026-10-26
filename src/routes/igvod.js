// igVod — 영상·쇼츠(롤샷) 콘텐츠. 업로드·피드·재생(조회수)·좋아요·댓글.
// 게임 레벨([[igplay]])·라이브([[iglive]])와 함께 통합 재생/피드를 이룬다. 파일은 [[files]] 재사용.
//   vod         : {kind('video'|'short'), title, fileId, cover, dur, creator, views, likes, comments, tags, desc, geo}
//   _vod_like   : 좋아요 (doc_id = vodId:uid)
//   vod_comments: 댓글
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';
import { cleanGeo } from './igplay.js';

const router = Router();
const SHORT_MAX = 60; // 쇼츠 최대 길이(초)

function vodPublic(r, { liked = false, mine = false } = {}) {
  const d = r.data || {};
  return { id: r.doc_id, kind: d.kind, title: d.title, fileId: d.fileId || null, cover: d.cover || null,
    dur: d.dur | 0, creator: d.creator || '익명', creatorId: r.owner_id, views: d.views | 0, likes: d.likes | 0,
    comments: d.comments | 0, tags: d.tags || [], desc: d.desc || '', geo: d.geo || null, created_at: r.created_at, liked, mine };
}
async function liked(pid, id, uid) { return uid ? !!(await getRepo().getRecord(pid, '_vod_like', id + ':' + uid)) : false; }

// 피드: 전체(영상+쇼츠) 또는 kind 필터. 최신순.
router.get('/feed', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user?.uid, kind = req.query.kind;
    const filters = (kind === 'video' || kind === 'short') ? [['kind', 'eq', kind]] : undefined;
    const rows = await getRepo().queryRecords(pid, 'vod', { limit: 200, sort: 'created_at:desc', filters });
    const out = [];
    for (const r of rows) out.push(vodPublic(r, { liked: await liked(pid, r.doc_id, uid), mine: uid && r.owner_id === uid }));
    res.json({ items: out });
  } catch (e) { next(e); }
});
// 쇼츠 전용 피드(세로 스와이프용)
router.get('/shorts', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id;
    const rows = await getRepo().queryRecords(pid, 'vod', { limit: 200, sort: 'created_at:desc', filters: [['kind', 'eq', 'short']] });
    res.json({ items: rows.map((r) => vodPublic(r)) });
  } catch (e) { next(e); }
});
// 단건 + 조회수 증가(재생)
router.get('/:id', optionalUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vod', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    rec.data.views = (rec.data.views | 0) + 1;
    await repo.putRecord({ project_id: pid, collection: 'vod', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    const mine = req.user && rec.owner_id === req.user.uid;
    res.json({ item: vodPublic(rec, { liked: await liked(pid, req.params.id, req.user?.uid), mine }) });
  } catch (e) { next(e); }
});
// 업로드(발행). short는 dur<=60 강제.
router.post('/', requireUser, async (req, res, next) => {
  try {
    const b = req.body || {};
    let kind = b.kind === 'short' ? 'short' : 'video';
    if (!b.title) return res.status(400).json({ error: 'bad_title', message: '제목이 필요합니다.' });
    if (!b.fileId && !b.externalUrl) return res.status(400).json({ error: 'no_media', message: '영상 파일이 필요합니다.' });
    let dur = Math.max(0, b.dur | 0);
    if (kind === 'short' && dur > SHORT_MAX) return res.status(400).json({ error: 'too_long', message: '쇼츠(롤샷)는 60초 이하여야 합니다.' });
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('vd_');
    const data = { kind, title: String(b.title).slice(0, 120), fileId: b.fileId ? String(b.fileId).slice(0, 80) : null,
      externalUrl: (typeof b.externalUrl === 'string' && /^https?:\/\//.test(b.externalUrl)) ? b.externalUrl.slice(0, 500) : null,
      cover: (typeof b.cover === 'string' && b.cover.length < 900000) ? b.cover : null, dur,
      creator: req.user.name || '익명', views: 0, likes: 0, comments: 0,
      tags: Array.isArray(b.tags) ? b.tags.slice(0, 10).map((t) => String(t).slice(0, 24)) : [],
      desc: String(b.desc || '').slice(0, 2000), geo: cleanGeo(b.geo) };
    const rec = await getRepo().putRecord({ project_id: pid, collection: 'vod', doc_id: id, data, owner_id: uid });
    broadcast(pid, 'igvod:feed', { type: 'vod_new', id, kind, title: data.title, ts: Date.now() });
    res.status(201).json({ item: vodPublic(rec, { mine: true }) });
  } catch (e) { next(e); }
});
router.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vod', req.params.id);
    if (!rec || rec.owner_id !== req.user.uid) return res.status(404).json({ error: 'not_found' });
    await repo.deleteRecord(pid, 'vod', req.params.id, { hard: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// 좋아요 토글
router.post('/:id/like', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vod', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const lid = req.params.id + ':' + uid; const had = await repo.getRecord(pid, '_vod_like', lid);
    if (had) { await repo.deleteRecord(pid, '_vod_like', lid, { hard: true }); rec.data.likes = Math.max(0, (rec.data.likes | 0) - 1); }
    else { await repo.putRecord({ project_id: pid, collection: '_vod_like', doc_id: lid, data: { vodId: req.params.id, uid, ts: Date.now() }, owner_id: uid }); rec.data.likes = (rec.data.likes | 0) + 1; }
    await repo.putRecord({ project_id: pid, collection: 'vod', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    res.json({ ok: true, liked: !had, likes: rec.data.likes });
  } catch (e) { next(e); }
});
// 댓글
router.get('/:id/comments', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'vod_comments', { limit: 200, sort: 'created_at:desc', filters: [['vodId', 'eq', req.params.id]] });
    res.json({ comments: rows.map((r) => ({ id: r.doc_id, uid: r.data.uid, name: r.data.name, text: r.data.text, ts: r.data.ts })) });
  } catch (e) { next(e); }
});
router.post('/:id/comments', requireUser, async (req, res, next) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vod', req.params.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    await repo.putRecord({ project_id: pid, collection: 'vod_comments', doc_id: randomId('vc_'), data: { vodId: req.params.id, uid, name: req.user.name || '익명', text: text.slice(0, 1000), ts: Date.now() }, owner_id: uid });
    rec.data.comments = (rec.data.comments | 0) + 1;
    await repo.putRecord({ project_id: pid, collection: 'vod', doc_id: req.params.id, data: rec.data, owner_id: rec.owner_id });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
// 특정 유저(채널)의 영상
router.get('/users/:uid/items', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'vod', { ownerId: req.params.uid, limit: 100, sort: 'created_at:desc' });
    res.json({ items: rows.map((r) => vodPublic(r)) });
  } catch (e) { next(e); }
});

export default router;
