// 파일 업로드/다운로드. 의존성 최소화를 위해 raw 바이너리 업로드 방식.
// 업로드: POST /files?filename=foo.png  (바디 = 파일 바이너리)
// 다운로드: GET /files/:id  /  목록: GET /files  /  삭제: DELETE /files/:id
import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { getLimits, quotaError } from '../quota.js';
import { config, randomId } from '../config.js';

const router = Router();

function uploadDir(projectId) {
  const dir = path.join(config.dataDir, 'uploads', projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeFilename(s) {
  const base = path.basename(String(s || 'file')).replace(/[^\w.\-가-힣 ]/g, '_').slice(0, 200);
  return base || 'file';
}

// 업로드
router.post('/', requireUser, raw({ type: () => true, limit: config.maxUploadBytes }), async (req, res, next) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty', message: '파일 내용이 비어 있습니다.' });
    // 쿼터: 총 파일 용량 한도
    const limits = getLimits(req.project);
    if (limits.maxFileBytes !== Infinity) {
      const used = await getRepo().sumFileBytes(req.project.id);
      if (used + req.body.length > limits.maxFileBytes) return quotaError(res, 'fileBytes', limits.maxFileBytes);
    }
    const filename = safeFilename(req.query.filename);
    const id = randomId('f_');
    const storagePath = path.join(uploadDir(req.project.id), id + '_' + filename);
    fs.writeFileSync(storagePath, req.body);
    const file = await getRepo().createFile({
      id, project_id: req.project.id, filename, mime: req.get('Content-Type') || 'application/octet-stream',
      size: req.body.length, storage_path: storagePath, owner_id: req.user.uid,
    });
    res.status(201).json({ file: outFile(file, req) });
  } catch (e) { next(e); }
});

// 목록
router.get('/', requireUser, async (req, res, next) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const files = await getRepo().listFiles(req.project.id, { limit, offset });
    res.json({ items: files.map((f) => outFile(f, req)) });
  } catch (e) { next(e); }
});

// 다운로드 (공개: 프로젝트 키로 접근, 토큰 선택)
router.get('/:id', optionalUser, async (req, res, next) => {
  try {
    const file = await getRepo().getFile(req.params.id);
    if (!file || file.project_id !== req.project.id) return res.status(404).json({ error: 'not_found' });
    if (!fs.existsSync(file.storage_path)) return res.status(410).json({ error: 'gone', message: '파일이 저장소에 없습니다.' });
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    fs.createReadStream(file.storage_path).pipe(res);
  } catch (e) { next(e); }
});

// 삭제
router.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const repo = getRepo();
    const file = await repo.getFile(req.params.id);
    if (!file || file.project_id !== req.project.id) return res.status(404).json({ error: 'not_found' });
    if (file.owner_id && file.owner_id !== req.user.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    try { fs.unlinkSync(file.storage_path); } catch {}
    await repo.deleteFile(file.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function outFile(f, req) {
  const base = `${req.protocol}://${req.get('host')}`;
  return { id: f.id, filename: f.filename, mime: f.mime, size: f.size, created_at: f.created_at, url: `${base}/api/files/${f.id}?key=${req.project.api_key}` };
}

export default router;
