// igVideo — 영상 제작 공용 백엔드. 컷룸·VR툴·4DGS 등 STUDIO ig 영상 제작 툴이 공통으로 쓴다.
// 프로젝트 저장(편집 상태 JSON), 미디어 에셋(files 재사용), 렌더 잡 큐(상태 기록), 완료물 발행 연계.
// 실제 렌더링은 각 툴/워커가 수행하고 여기에 상태·결과 파일을 보고한다(큐·상태는 실제 동작, 렌더 자체는 워커 몫).
//   vid_projects : 프로젝트 {title, tool, data(편집상태), assets[fileId], cover, ts}
//   vid_jobs     : 렌더 잡 {projectId, tool, status(queued|processing|done|failed), progress, outputFileId, error, ts}
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';

const router = Router();
const PROJ_MAX_BYTES = 2000000; // 프로젝트 편집상태 JSON 최대
const STATUS = ['queued', 'processing', 'done', 'failed'];

function projPublic(r) {
  const d = r.data || {};
  return { id: r.doc_id, title: d.title, tool: d.tool || null, cover: d.cover || null, assets: d.assets || [], updated_at: r.updated_at, created_at: r.created_at, ownerId: r.owner_id };
}

// ===================== 프로젝트 =====================
router.get('/projects', requireUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'vid_projects', { ownerId: req.user.uid, limit: 100, sort: 'updated_at:desc' });
    res.json({ projects: rows.map(projPublic) });
  } catch (e) { next(e); }
});
router.get('/projects/:id', requireUser, async (req, res, next) => {
  try {
    const rec = await getRepo().getRecord(req.project.id, 'vid_projects', req.params.id);
    if (!rec || rec.owner_id !== req.user.uid) return res.status(404).json({ error: 'not_found' });
    res.json({ project: { ...projPublic(rec), data: rec.data.data || null } });
  } catch (e) { next(e); }
});
router.post('/projects', requireUser, async (req, res, next) => {
  try {
    const { title, tool, data, assets, cover } = req.body || {};
    if (!title) return res.status(400).json({ error: 'bad_title', message: '제목이 필요합니다.' });
    if (data !== undefined && JSON.stringify(data).length > PROJ_MAX_BYTES) return res.status(413).json({ error: 'too_big' });
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('vp_');
    const d = { title: String(title).slice(0, 120), tool: tool ? String(tool).slice(0, 40) : null, data: data || null, assets: Array.isArray(assets) ? assets.slice(0, 500) : [], cover: (typeof cover === 'string' && cover.length < 900000) ? cover : null, ts: Date.now() };
    const rec = await getRepo().putRecord({ project_id: pid, collection: 'vid_projects', doc_id: id, data: d, owner_id: uid });
    res.status(201).json({ project: projPublic(rec) });
  } catch (e) { next(e); }
});
router.put('/projects/:id', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vid_projects', req.params.id);
    if (!rec || rec.owner_id !== uid) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {}, d = rec.data;
    if (b.title != null) d.title = String(b.title).slice(0, 120);
    if (b.data !== undefined) { if (JSON.stringify(b.data).length > PROJ_MAX_BYTES) return res.status(413).json({ error: 'too_big' }); d.data = b.data; }
    if (Array.isArray(b.assets)) d.assets = b.assets.slice(0, 500);
    if (typeof b.cover === 'string' && b.cover.length < 900000) d.cover = b.cover;
    d.ts = Date.now();
    await repo.putRecord({ project_id: pid, collection: 'vid_projects', doc_id: req.params.id, data: d, owner_id: uid });
    res.json({ project: projPublic(rec) });
  } catch (e) { next(e); }
});
router.delete('/projects/:id', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vid_projects', req.params.id);
    if (!rec || rec.owner_id !== uid) return res.status(404).json({ error: 'not_found' });
    await repo.deleteRecord(pid, 'vid_projects', req.params.id, { hard: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ===================== 렌더 잡 큐 =====================
// 제출 → queued. 워커(또는 같은 툴)가 상태를 processing→done/failed 로 보고. 완료 시 outputFileId 연결.
router.post('/jobs', requireUser, async (req, res, next) => {
  try {
    const { projectId, tool, params } = req.body || {};
    const pid = req.project.id, uid = req.user.uid;
    const id = randomId('vj_');
    const d = { projectId: projectId || null, tool: tool ? String(tool).slice(0, 40) : null, params: params || null, status: 'queued', progress: 0, outputFileId: null, error: null, ts: Date.now() };
    await getRepo().putRecord({ project_id: pid, collection: 'vid_jobs', doc_id: id, data: d, owner_id: uid });
    broadcast(pid, 'igvideo:jobs:' + uid, { type: 'job_new', id, status: 'queued', ts: Date.now() });
    res.status(201).json({ job: { id, ...d } });
  } catch (e) { next(e); }
});
// 상태 보고(소유자/워커). progress 0~100, status 전이, 완료 시 outputFileId.
router.post('/jobs/:id/status', requireUser, async (req, res, next) => {
  try {
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await repo.getRecord(pid, 'vid_jobs', req.params.id);
    if (!rec || rec.owner_id !== uid) return res.status(404).json({ error: 'not_found' });
    const { status, progress, outputFileId, error } = req.body || {};
    if (status && !STATUS.includes(status)) return res.status(400).json({ error: 'bad_status' });
    const d = rec.data;
    if (status) d.status = status;
    if (progress != null) d.progress = Math.max(0, Math.min(100, progress | 0));
    if (outputFileId != null) d.outputFileId = String(outputFileId).slice(0, 80);
    if (error != null) d.error = String(error).slice(0, 300);
    d.ts = Date.now();
    await repo.putRecord({ project_id: pid, collection: 'vid_jobs', doc_id: req.params.id, data: d, owner_id: uid });
    broadcast(pid, 'igvideo:jobs:' + uid, { type: 'job_update', id: req.params.id, status: d.status, progress: d.progress, ts: Date.now() });
    res.json({ job: { id: req.params.id, ...d } });
  } catch (e) { next(e); }
});
router.get('/jobs', requireUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'vid_jobs', { ownerId: req.user.uid, limit: 100, sort: 'created_at:desc' });
    res.json({ jobs: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.get('/jobs/:id', requireUser, async (req, res, next) => {
  try {
    const rec = await getRepo().getRecord(req.project.id, 'vid_jobs', req.params.id);
    if (!rec || rec.owner_id !== req.user.uid) return res.status(404).json({ error: 'not_found' });
    res.json({ job: { id: rec.doc_id, ...rec.data } });
  } catch (e) { next(e); }
});

export default router;
