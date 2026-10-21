// NAS(파일 저장·공유 서버). 폴더 트리 + 경로 기반 업로드/다운로드/이동/삭제 + 공유 링크.
// 메타데이터는 서버 전용 컬렉션(_nasfiles/_nasfolders) 레코드로 저장(드라이버 수정 불필요),
// 바이너리는 디스크(dataDir/uploads/<pid>)에 저장. 어떤 DB 드라이버에서도 동일 동작.
import { Router, raw, json } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { getLimits, quotaError } from '../quota.js';
import { config, randomId } from '../config.js';

const router = Router();
const jsonBody = json({ limit: '1mb' });
const FILES = '_nasfiles';
const FOLDERS = '_nasfolders';
const BIG = 100000; // 한 프로젝트 전체 조회 상한

function uploadDir(pid) { const d = path.join(config.dataDir, 'uploads', pid); fs.mkdirSync(d, { recursive: true }); return d; }

// 경로 정규화: 항상 '/'로 시작, '.'/'..' 제거, 제어문자·과도한 길이 거부. 루트는 '/'.
function normPath(p) {
  let s = String(p == null ? '/' : p).trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    if (seg.length > 255 || /[\u0000-\u001f]/.test(seg)) return null;
    parts.push(seg);
  }
  return '/' + parts.join('/');
}
function parentOf(p) { if (p === '/') return null; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function baseName(p) { return p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1); }
function isUnder(p, prefix) { return p === prefix || p.startsWith(prefix === '/' ? '/' : prefix + '/'); }

async function allFiles(pid) { return getRepo().queryRecords(pid, FILES, { limit: BIG }); }
async function allFolders(pid) { return getRepo().queryRecords(pid, FOLDERS, { limit: BIG }); }
async function fileByPath(pid, p) { return (await allFiles(pid)).find((r) => r.data.path === p) || null; }
async function folderByPath(pid, p) { return (await allFolders(pid)).find((r) => r.data.path === p) || null; }

// 조상 폴더 체인 보장(없으면 생성). 루트는 암묵적으로 존재.
async function ensureChain(pid, folderPath, ownerId) {
  if (!folderPath || folderPath === '/') return;
  const existing = new Set((await allFolders(pid)).map((r) => r.data.path));
  const segs = folderPath.split('/').filter(Boolean);
  let cur = '';
  for (const s of segs) {
    cur = cur + '/' + s;
    if (!existing.has(cur)) {
      await getRepo().putRecord({ project_id: pid, collection: FOLDERS, doc_id: randomId('nd_'),
        data: { path: cur, folder: parentOf(cur), name: s }, owner_id: ownerId });
      existing.add(cur);
    }
  }
}

async function nasBytes(pid) {
  const r = await getRepo().aggregate(pid, FILES, { op: 'sum', field: 'size' });
  return Number(r.value) || 0;
}

const outFolder = (r) => ({ type: 'folder', name: r.data.name, path: r.data.path, created_at: r.created_at });
function outFile(r, req, withShare = true) {
  const base = `${req.protocol}://${req.get('host')}`;
  const o = { type: 'file', id: r.doc_id, name: r.data.name, path: r.data.path, folder: r.data.folder,
    mime: r.data.mime, size: r.data.size, created_at: r.created_at, updated_at: r.updated_at,
    url: `${base}/api/nas/file?path=${encodeURIComponent(r.data.path)}&key=${req.project.api_key}` };
  if (withShare && r.data.shareToken && (!r.data.shareExpires || r.data.shareExpires > Date.now())) {
    o.share = { token: r.data.shareToken, expires: r.data.shareExpires || null, url: `${base}/api/nas/shared/${r.data.shareToken}?key=${req.project.api_key}` };
  }
  return o;
}

// 폴더 내용 목록: GET /nas/list?path=/photos
router.get('/list', requireUser, async (req, res, next) => {
  try {
    const p = normPath(req.query.path || '/');
    if (p == null) return res.status(400).json({ error: 'bad_path' });
    const [files, folders] = [await allFiles(req.project.id), await allFolders(req.project.id)];
    const subFolders = folders.filter((r) => r.data.folder === p).map(outFolder).sort((a, b) => a.name.localeCompare(b.name));
    const subFiles = files.filter((r) => r.data.folder === p).map((r) => outFile(r, req)).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: p, folders: subFolders, files: subFiles });
  } catch (e) { next(e); }
});

// 폴더 생성: POST /nas/folder { path }
router.post('/folder', requireUser, jsonBody, async (req, res, next) => {
  try {
    const p = normPath(req.body?.path);
    if (p == null || p === '/') return res.status(400).json({ error: 'bad_path', message: '올바른 폴더 경로가 필요합니다.' });
    if (await folderByPath(req.project.id, p)) return res.status(409).json({ error: 'exists', message: '이미 있는 폴더입니다.' });
    if (await fileByPath(req.project.id, p)) return res.status(409).json({ error: 'exists', message: '같은 경로에 파일이 있습니다.' });
    await ensureChain(req.project.id, p, req.user.uid);
    const r = await folderByPath(req.project.id, p);
    res.status(201).json({ folder: outFolder(r) });
  } catch (e) { next(e); }
});

// 업로드: POST /nas/upload?path=/photos/a.jpg  (바디=바이너리). 같은 경로면 덮어쓰기.
router.post('/upload', requireUser, raw({ type: () => true, limit: config.maxUploadBytes }), async (req, res, next) => {
  try {
    const p = normPath(req.query.path);
    if (p == null || p === '/' || !baseName(p)) return res.status(400).json({ error: 'bad_path', message: '업로드 경로(파일명 포함)가 필요합니다.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty', message: '파일 내용이 비어 있습니다.' });
    if (await folderByPath(req.project.id, p)) return res.status(409).json({ error: 'is_folder', message: '같은 경로에 폴더가 있습니다.' });
    // 쿼터: 파일 테이블 + NAS 합산이 한도 내인지
    const limits = getLimits(req.project);
    if (limits.maxFileBytes !== Infinity) {
      const existing = await fileByPath(req.project.id, p);
      const used = (await getRepo().sumFileBytes(req.project.id)) + (await nasBytes(req.project.id)) - (existing?.data.size || 0);
      if (used + req.body.length > limits.maxFileBytes) return quotaError(res, 'fileBytes', limits.maxFileBytes);
    }
    await ensureChain(req.project.id, parentOf(p), req.user.uid);
    const existing = await fileByPath(req.project.id, p);
    const docId = existing ? existing.doc_id : randomId('nf_');
    const storagePath = existing?.data.storagePath || path.join(uploadDir(req.project.id), docId);
    fs.writeFileSync(storagePath, req.body);
    const rec = await getRepo().putRecord({
      project_id: req.project.id, collection: FILES, doc_id: docId,
      data: {
        path: p, folder: parentOf(p), name: baseName(p),
        mime: req.get('Content-Type') || 'application/octet-stream', size: req.body.length, storagePath,
        shareToken: existing?.data.shareToken, shareExpires: existing?.data.shareExpires,
      },
      owner_id: existing?.owner_id || req.user.uid,
    });
    res.status(201).json({ file: outFile(rec, req) });
  } catch (e) { next(e); }
});

// 다운로드: GET /nas/file?path=/photos/a.jpg  (프로젝트 키로 접근)
router.get('/file', optionalUser, async (req, res, next) => {
  try {
    const p = normPath(req.query.path);
    if (p == null) return res.status(400).json({ error: 'bad_path' });
    const rec = await fileByPath(req.project.id, p);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (!fs.existsSync(rec.data.storagePath)) return res.status(410).json({ error: 'gone', message: '파일이 저장소에 없습니다.' });
    res.setHeader('Content-Type', rec.data.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rec.data.name)}`);
    fs.createReadStream(rec.data.storagePath).pipe(res);
  } catch (e) { next(e); }
});

// 메타: GET /nas/meta?path=
router.get('/meta', requireUser, async (req, res, next) => {
  try {
    const p = normPath(req.query.path);
    if (p == null) return res.status(400).json({ error: 'bad_path' });
    const f = await fileByPath(req.project.id, p);
    if (f) return res.json({ item: outFile(f, req) });
    const d = await folderByPath(req.project.id, p);
    if (d) return res.json({ item: outFolder(d) });
    res.status(404).json({ error: 'not_found' });
  } catch (e) { next(e); }
});

// 이동/이름변경: POST /nas/move { from, to }  (폴더면 하위 전체 경로 갱신)
router.post('/move', requireUser, jsonBody, async (req, res, next) => {
  try {
    const from = normPath(req.body?.from), to = normPath(req.body?.to);
    if (from == null || to == null || from === '/' || to === '/') return res.status(400).json({ error: 'bad_path' });
    if (isUnder(to, from)) return res.status(400).json({ error: 'bad_move', message: '폴더를 자기 하위로 옮길 수 없습니다.' });
    const repo = getRepo();
    const [files, folders] = [await allFiles(req.project.id), await allFolders(req.project.id)];
    const srcFile = files.find((r) => r.data.path === from);
    const srcFolder = folders.find((r) => r.data.path === from);
    if (!srcFile && !srcFolder) return res.status(404).json({ error: 'not_found' });
    if (files.some((r) => r.data.path === to) || folders.some((r) => r.data.path === to)) return res.status(409).json({ error: 'exists', message: '대상 경로가 이미 있습니다.' });
    await ensureChain(req.project.id, parentOf(to), req.user.uid);
    const reattach = (oldPath) => to + oldPath.slice(from.length); // from 접두사를 to로 치환
    let moved = 0;
    if (srcFile) {
      srcFile.data.path = to; srcFile.data.folder = parentOf(to); srcFile.data.name = baseName(to);
      await repo.putRecord({ project_id: req.project.id, collection: FILES, doc_id: srcFile.doc_id, data: srcFile.data, owner_id: srcFile.owner_id }); moved++;
    } else {
      // 폴더: 자신 + 하위 폴더/파일 전부 경로 갱신
      for (const r of folders.filter((x) => isUnder(x.data.path, from))) {
        const np = reattach(r.data.path); r.data.path = np; r.data.folder = parentOf(np); r.data.name = baseName(np);
        await repo.putRecord({ project_id: req.project.id, collection: FOLDERS, doc_id: r.doc_id, data: r.data, owner_id: r.owner_id }); moved++;
      }
      for (const r of files.filter((x) => isUnder(x.data.path, from))) {
        const np = reattach(r.data.path); r.data.path = np; r.data.folder = parentOf(np); r.data.name = baseName(np);
        await repo.putRecord({ project_id: req.project.id, collection: FILES, doc_id: r.doc_id, data: r.data, owner_id: r.owner_id }); moved++;
      }
    }
    res.json({ ok: true, from, to, moved });
  } catch (e) { next(e); }
});

// 삭제: DELETE /nas/delete?path=  (폴더면 하위 전체 재귀 삭제)
router.delete('/delete', requireUser, async (req, res, next) => {
  try {
    const p = normPath(req.query.path);
    if (p == null || p === '/') return res.status(400).json({ error: 'bad_path' });
    const repo = getRepo();
    const [files, folders] = [await allFiles(req.project.id), await allFolders(req.project.id)];
    const targetFile = files.find((r) => r.data.path === p);
    const targetFolder = folders.find((r) => r.data.path === p);
    if (!targetFile && !targetFolder) return res.status(404).json({ error: 'not_found' });
    const canManage = (r) => !r.owner_id || r.owner_id === req.user.uid || req.user.role === 'admin';
    let removed = 0;
    if (targetFile) {
      if (!canManage(targetFile)) return res.status(403).json({ error: 'forbidden' });
      try { fs.unlinkSync(targetFile.data.storagePath); } catch {}
      await repo.deleteRecord(req.project.id, FILES, targetFile.doc_id, { hard: true }); removed++;
    } else {
      const delFiles = files.filter((r) => isUnder(r.data.path, p));
      const delFolders = folders.filter((r) => isUnder(r.data.path, p));
      if (![...delFiles, ...delFolders].every(canManage)) return res.status(403).json({ error: 'forbidden', message: '하위에 다른 사람 소유 항목이 있습니다.' });
      for (const r of delFiles) { try { fs.unlinkSync(r.data.storagePath); } catch {} await repo.deleteRecord(req.project.id, FILES, r.doc_id, { hard: true }); removed++; }
      for (const r of delFolders) { await repo.deleteRecord(req.project.id, FOLDERS, r.doc_id, { hard: true }); removed++; }
    }
    res.json({ ok: true, removed });
  } catch (e) { next(e); }
});

// 공유 링크 발급: POST /nas/share { path, expiresInSec? }  (파일만)
router.post('/share', requireUser, jsonBody, async (req, res, next) => {
  try {
    const p = normPath(req.body?.path);
    if (p == null) return res.status(400).json({ error: 'bad_path' });
    const rec = await fileByPath(req.project.id, p);
    if (!rec) return res.status(404).json({ error: 'not_found', message: '파일만 공유할 수 있습니다.' });
    if (rec.owner_id && rec.owner_id !== req.user.uid && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const token = rec.data.shareToken || crypto.randomBytes(16).toString('hex');
    const sec = parseInt(req.body?.expiresInSec, 10);
    rec.data.shareToken = token;
    rec.data.shareExpires = Number.isFinite(sec) && sec > 0 ? Date.now() + sec * 1000 : null;
    await getRepo().putRecord({ project_id: req.project.id, collection: FILES, doc_id: rec.doc_id, data: rec.data, owner_id: rec.owner_id });
    res.json({ file: outFile(rec, req) });
  } catch (e) { next(e); }
});

// 공유 해제: DELETE /nas/share?path=
router.delete('/share', requireUser, async (req, res, next) => {
  try {
    const p = normPath(req.query.path);
    if (p == null) return res.status(400).json({ error: 'bad_path' });
    const rec = await fileByPath(req.project.id, p);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    delete rec.data.shareToken; delete rec.data.shareExpires;
    await getRepo().putRecord({ project_id: req.project.id, collection: FILES, doc_id: rec.doc_id, data: rec.data, owner_id: rec.owner_id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 공유 다운로드(비로그인): GET /nas/shared/:token  (프로젝트 키로 프로젝트 식별)
router.get('/shared/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const rec = (await allFiles(req.project.id)).find((r) => r.data.shareToken && r.data.shareToken === token);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.data.shareExpires && rec.data.shareExpires < Date.now()) return res.status(410).json({ error: 'expired', message: '만료된 공유 링크입니다.' });
    if (!fs.existsSync(rec.data.storagePath)) return res.status(410).json({ error: 'gone' });
    res.setHeader('Content-Type', rec.data.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rec.data.name)}`);
    fs.createReadStream(rec.data.storagePath).pipe(res);
  } catch (e) { next(e); }
});

// 사용량: GET /nas/usage
router.get('/usage', requireUser, async (req, res, next) => {
  try {
    const [files, folders] = [await allFiles(req.project.id), await allFolders(req.project.id)];
    const bytes = files.reduce((a, r) => a + (r.data.size || 0), 0);
    const limits = getLimits(req.project);
    res.json({ bytes, files: files.length, folders: folders.length, maxFileBytes: limits.maxFileBytes === Infinity ? null : limits.maxFileBytes });
  } catch (e) { next(e); }
});

export default router;
