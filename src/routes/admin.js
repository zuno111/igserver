// 관리자 API. 대시보드가 호출. 프로젝트 등록/조회/삭제, 모니터링, 유저·감사·노드 조회.
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { verifyPassword, hashPassword, signAdminToken } from '../auth.js';
import { requireAdmin, requireRole } from '../middleware/auth.js';
import { rateLimit } from '../ratelimit.js';
import { metricsSummary, requestSeries } from '../logger.js';
import { roomStats, presenceStats, presenceList } from '../realtime.js';
import { getUsage } from '../quota.js';
import { runJob } from '../scheduler.js';
import { config, randomId, randomKey, randomSecretKey } from '../config.js';
import crypto from 'node:crypto';

const router = Router();
const loginLimit = rateLimit({ windowMs: config.rlWindowMs, max: config.rlAuthMax, keyBy: 'ip' });

// 관리자 계정은 settings 안에 보관되는 단일 계정 (projects 테이블의 '__system__' 프로젝트에 저장)
const SYS = '__system__';
// 관리자 계정은 시스템 프로젝트 settings.admins 배열에 저장: [{id,email,hash,role,created_at}]
async function ensureAdmin() {
  const repo = getRepo();
  let sys = await repo.getProject(SYS);
  if (!sys) {
    sys = await repo.createProject({
      id: SYS, name: 'System', slug: SYS, api_key: randomKey(), secret_key: randomSecretKey(), status: 'active',
      settings: { admins: [{ id: 'adm_owner', email: config.adminEmail, hash: await hashPassword(config.adminPassword), role: 'owner', created_at: Date.now() }] },
    });
  } else if (!sys.settings.admins) {
    // 기존 단일 관리자 → owner로 마이그레이션
    const admins = [{ id: 'adm_owner', email: sys.settings.adminEmail || config.adminEmail, hash: sys.settings.adminHash || await hashPassword(config.adminPassword), role: 'owner', created_at: Date.now() }];
    const next = { ...sys.settings, admins }; delete next.adminHash;
    sys = await repo.updateProject(SYS, { settings: next });
  }
  return sys;
}

// 관리자 로그인
router.post('/login', loginLimit, async (req, res, next) => {
  try {
    const sys = await ensureAdmin();
    const { email, password } = req.body || {};
    const admin = (sys.settings.admins || []).find((a) => a.email === email);
    if (!admin || !(await verifyPassword(password || '', admin.hash))) {
      return res.status(401).json({ error: 'invalid_credentials', message: '관리자 이메일 또는 비밀번호가 올바르지 않습니다.' });
    }
    res.json({ token: signAdminToken({ id: admin.id, email: admin.email, role: admin.role }), role: admin.role });
  } catch (e) { next(e); }
});

// 내 관리자 정보
router.get('/me', requireAdmin, (req, res) => res.json({ email: req.admin.email, role: req.admin.role }));

// 관리자 비밀번호 변경 (자기 것)
router.post('/change-password', requireAdmin, async (req, res, next) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'weak_password', message: '관리자 비밀번호는 8자 이상이어야 합니다.' });
    const repo = getRepo();
    const sys = await ensureAdmin();
    const hash = await hashPassword(newPassword);
    const admins = (sys.settings.admins || []).map((a) => a.id === req.admin.uid ? { ...a, hash } : a);
    await repo.updateProject(SYS, { settings: { ...sys.settings, admins } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 관리자 계정 관리 (owner 전용) ----
router.get('/admins', requireAdmin, requireRole('admin'), async (_req, res, next) => {
  try {
    const sys = await ensureAdmin();
    res.json({ admins: (sys.settings.admins || []).map((a) => ({ id: a.id, email: a.email, role: a.role, created_at: a.created_at })) });
  } catch (e) { next(e); }
});
router.post('/admins', requireAdmin, requireRole('owner'), async (req, res, next) => {
  try {
    const { email, password, role } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'weak_password', message: '비밀번호는 8자 이상이어야 합니다.' });
    const r = ['owner', 'admin', 'viewer'].includes(role) ? role : 'admin';
    const repo = getRepo();
    const sys = await ensureAdmin();
    if ((sys.settings.admins || []).some((a) => a.email === email)) return res.status(409).json({ error: 'email_taken', message: '이미 등록된 관리자 이메일입니다.' });
    const admin = { id: randomId('adm_'), email, hash: await hashPassword(password), role: r, created_at: Date.now() };
    await repo.updateProject(SYS, { settings: { ...sys.settings, admins: [...(sys.settings.admins || []), admin] } });
    res.status(201).json({ admin: { id: admin.id, email, role: r } });
  } catch (e) { next(e); }
});
router.patch('/admins/:id', requireAdmin, requireRole('owner'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const sys = await ensureAdmin();
    const admins = sys.settings.admins || [];
    const target = admins.find((a) => a.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    const r = ['owner', 'admin', 'viewer'].includes(req.body.role) ? req.body.role : target.role;
    // 마지막 owner의 강등 방지
    if (target.role === 'owner' && r !== 'owner' && admins.filter((a) => a.role === 'owner').length <= 1) {
      return res.status(400).json({ error: 'last_owner', message: '마지막 owner는 강등할 수 없습니다.' });
    }
    const next = admins.map((a) => a.id === req.params.id ? { ...a, role: r } : a);
    await repo.updateProject(SYS, { settings: { ...sys.settings, admins: next } });
    res.json({ ok: true, role: r });
  } catch (e) { next(e); }
});
router.delete('/admins/:id', requireAdmin, requireRole('owner'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const sys = await ensureAdmin();
    const admins = sys.settings.admins || [];
    const target = admins.find((a) => a.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role === 'owner' && admins.filter((a) => a.role === 'owner').length <= 1) {
      return res.status(400).json({ error: 'last_owner', message: '마지막 owner는 삭제할 수 없습니다.' });
    }
    await repo.updateProject(SYS, { settings: { ...sys.settings, admins: admins.filter((a) => a.id !== req.params.id) } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 프로젝트 관리 ----
router.get('/projects', requireAdmin, async (_req, res, next) => {
  try {
    const repo = getRepo();
    const list = (await repo.listProjects()).filter((p) => p.id !== SYS);
    const withStats = await Promise.all(list.map(async (p) => {
      let proj = p;
      if (!proj.secret_key) proj = await repo.updateProject(proj.id, { secret_key: randomSecretKey() }); // 기존 프로젝트 lazy 발급
      return { ...publicProject(proj), users: await repo.countUsers(proj.id), records: await repo.countRecords(proj.id) };
    }));
    res.json({ projects: withStats });
  } catch (e) { next(e); }
});

router.post('/projects', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, slug } = req.body || {};
    if (!name) return res.status(400).json({ error: 'bad_name', message: '프로젝트 이름이 필요합니다.' });
    const repo = getRepo();
    const finalSlug = (slug || name).toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || randomId('p');
    if (await repo.getProjectBySlug(finalSlug)) return res.status(409).json({ error: 'slug_taken', message: '이미 사용 중인 slug입니다.' });
    const project = await repo.createProject({
      id: randomId('p_'), name, slug: finalSlug, api_key: randomKey(), secret_key: randomSecretKey(), status: 'active', settings: {},
    });
    await repo.addAudit({ id: randomId('a_'), actor_id: 'admin', action: 'project_create', meta: { id: project.id, name }, ip: req.ip });
    res.status(201).json({ project: publicProject(project) });
  } catch (e) { next(e); }
});

router.get('/projects/:id', requireAdmin, async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    res.json({ project: publicProject(p), users: await repo.countUsers(p.id), records: await repo.countRecords(p.id), collections: await repo.listCollections(p.id), usage: await getUsage(repo, p) });
  } catch (e) { next(e); }
});

router.patch('/projects/:id', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const patch = {};
    if (req.body.name) patch.name = req.body.name;
    if (req.body.status && ['active', 'disabled'].includes(req.body.status)) patch.status = req.body.status;
    let settings = p.settings;
    if (req.body.plan && ['free', 'pro', 'unlimited'].includes(req.body.plan)) settings = { ...settings, plan: req.body.plan };
    if (req.body.limits && typeof req.body.limits === 'object') settings = { ...settings, limits: req.body.limits };
    if (settings !== p.settings) patch.settings = settings;
    const updated = await repo.updateProject(p.id, patch);
    res.json({ project: publicProject(updated) });
  } catch (e) { next(e); }
});

// API 키 재발급
router.post('/projects/:id/rotate-key', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const which = req.body?.which === 'secret' ? 'secret' : 'api';
    const patch = which === 'secret' ? { secret_key: randomSecretKey() } : { api_key: randomKey() };
    const updated = await repo.updateProject(p.id, patch);
    await repo.addAudit({ id: randomId('a_'), actor_id: 'admin', action: 'rotate_key', meta: { id: p.id, which }, ip: req.ip });
    res.json({ project: publicProject(updated) });
  } catch (e) { next(e); }
});

router.delete('/projects/:id', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    await repo.deleteProject(p.id);
    await repo.addAudit({ id: randomId('a_'), actor_id: 'admin', action: 'project_delete', meta: { id: p.id, name: p.name }, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 프로젝트 유저 목록
router.get('/projects/:id/users', requireAdmin, async (req, res, next) => {
  try {
    const repo = getRepo();
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const users = await repo.listUsers(req.params.id, { limit, offset });
    res.json({ users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at })) });
  } catch (e) { next(e); }
});

// 모니터링 요약
router.get('/overview', requireAdmin, async (_req, res, next) => {
  try {
    const repo = getRepo();
    const projects = (await repo.listProjects()).filter((p) => p.id !== SYS);
    let totalUsers = 0, totalRecords = 0;
    for (const p of projects) { totalUsers += await repo.countUsers(p.id); totalRecords += await repo.countRecords(p.id); }
    res.json({
      driver: repo.driver,
      projects: projects.length,
      users: totalUsers,
      records: totalRecords,
      metrics: metricsSummary(),
      rooms: roomStats(),
      presence: presenceStats(),
      series: requestSeries(),
    });
  } catch (e) { next(e); }
});

// 감사 로그
router.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const rows = await getRepo().listAudit({ projectId: req.query.projectId, limit, offset });
    res.json({ audit: rows });
  } catch (e) { next(e); }
});

// ---- 백업 / 복원 ----
router.get('/projects/:id/export', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const dump = await repo.dumpProject(p.id);
    res.json({
      version: 1, exportedAt: Date.now(),
      project: { name: p.name, slug: p.slug, settings: p.settings },
      users: dump.users, records: dump.records, files: dump.files,
    });
  } catch (e) { next(e); }
});

router.post('/import', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const backup = req.body || {};
    if (!backup.project || !Array.isArray(backup.records)) return res.status(400).json({ error: 'bad_backup', message: '올바른 백업 파일이 아닙니다.' });
    // 새 프로젝트로 복원
    const baseName = (req.body.name || backup.project.name || 'restored') + '';
    let slug = baseName.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || randomId('p');
    if (await repo.getProjectBySlug(slug)) slug = slug + '-' + randomId('').slice(0, 5);
    const project = await repo.createProject({ id: randomId('p_'), name: baseName, slug, api_key: randomKey(), secret_key: randomSecretKey(), status: 'active', settings: backup.project.settings || {} });
    // 유저 복원 (새 id 부여, 비번 해시 유지). 원본→새 id 매핑으로 레코드 소유권 재연결.
    const idMap = {};
    for (const u of backup.users || []) {
      const newId = randomId('u_');
      idMap[u.id] = newId;
      await repo.createUser({ ...u, id: newId, project_id: project.id }).catch(() => {});
    }
    // 레코드 복원 (소유자 재매핑)
    for (const r of backup.records || []) {
      await repo.putRecord({ project_id: project.id, collection: r.collection, doc_id: r.doc_id, data: r.data, owner_id: idMap[r.owner_id] || r.owner_id }).catch(() => {});
    }
    await repo.addAudit({ id: randomId('a_'), actor_id: 'admin', action: 'import', meta: { newProject: project.id, users: (backup.users || []).length, records: (backup.records || []).length }, ip: req.ip });
    res.status(201).json({ project: publicProject(project), restored: { users: (backup.users || []).length, records: (backup.records || []).length } });
  } catch (e) { next(e); }
});

// ---- 스키마 관리 ----
router.get('/projects/:id/schemas', requireAdmin, async (req, res, next) => {
  try {
    const p = await getRepo().getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    res.json({ schemas: p.settings.schemas || {} });
  } catch (e) { next(e); }
});
router.put('/projects/:id/schemas/:collection', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!/^[A-Za-z0-9_\-.]{1,128}$/.test(collection)) return res.status(400).json({ error: 'bad_collection' });
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const def = { fields: req.body.fields || {}, strict: !!req.body.strict };
    const schemas = { ...(p.settings.schemas || {}), [collection]: def };
    await repo.updateProject(p.id, { settings: { ...p.settings, schemas } });
    res.json({ collection, schema: def });
  } catch (e) { next(e); }
});
router.delete('/projects/:id/schemas/:collection', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const schemas = { ...(p.settings.schemas || {}) };
    delete schemas[req.params.collection];
    await repo.updateProject(p.id, { settings: { ...p.settings, schemas } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 실시간 접속자 상세 ----
router.get('/projects/:id/presence', requireAdmin, async (req, res, next) => {
  try {
    const p = await getRepo().getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    res.json({ online: presenceList(p.id) });
  } catch (e) { next(e); }
});

// ---- 데이터 뷰어 (관리자가 프로젝트 데이터 직접 조회·편집) ----
router.get('/projects/:id/data/:collection', requireAdmin, async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const { collection } = req.params;
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const deleted = req.query.deleted === 'true';
    const q = req.query.q ? String(req.query.q).slice(0, 200) : undefined;
    const [items, count] = await Promise.all([
      repo.queryRecords(p.id, collection, { limit, offset, deleted, q }),
      repo.countCollection(p.id, collection, { deleted, q }),
    ]);
    res.json({ items: items.map((r) => ({ id: r.doc_id, data: r.data, owner_id: r.owner_id, deleted: !!r.deleted, created_at: r.created_at, updated_at: r.updated_at })), count });
  } catch (e) { next(e); }
});
router.put('/projects/:id/data/:collection/:docId', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const { collection, docId } = req.params;
    const existing = await repo.getRecord(p.id, collection, docId);
    const rec = await repo.putRecord({ project_id: p.id, collection, doc_id: docId, data: req.body?.data ?? {}, owner_id: existing?.owner_id || null });
    await repo.addHistory({ project_id: p.id, collection, doc_id: docId, op: 'admin_edit', data: rec.data, actor_id: 'admin' }).catch(() => {});
    res.json({ item: { id: rec.doc_id, data: rec.data } });
  } catch (e) { next(e); }
});
router.delete('/projects/:id/data/:collection/:docId', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const { collection, docId } = req.params;
    await repo.deleteRecord(p.id, collection, docId, { hard: req.query.hard === 'true' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.post('/projects/:id/data/:collection/:docId/restore', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const { collection, docId } = req.params;
    const rec = await repo.restoreRecord(p.id, collection, docId);
    res.json({ item: rec ? { id: rec.doc_id, data: rec.data } : null });
  } catch (e) { next(e); }
});

// ---- 예약 작업(스케줄러) 관리 ----
router.get('/projects/:id/jobs', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const p = await getRepo().getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    res.json({ jobs: p.settings.jobs || [] });
  } catch (e) { next(e); }
});
router.post('/projects/:id/jobs', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const { type, intervalMin, collection, olderThanDays } = req.body || {};
    if (!['cleanup_old', 'empty_trash', 'webhook_ping'].includes(type)) return res.status(400).json({ error: 'bad_type' });
    if (type === 'cleanup_old' && !collection) return res.status(400).json({ error: 'no_collection', message: 'cleanup_old 작업은 collection이 필요합니다.' });
    const job = {
      id: randomId('job_'), type, intervalMin: Math.max(1, Number(intervalMin) || 60),
      collection: collection || null, olderThanDays: olderThanDays != null ? Number(olderThanDays) : 30,
      active: true, lastRun: null, lastResult: null, created_at: Date.now(),
    };
    const jobs = [...(p.settings.jobs || []), job];
    await repo.updateProject(p.id, { settings: { ...p.settings, jobs } });
    res.status(201).json({ job });
  } catch (e) { next(e); }
});
router.post('/projects/:id/jobs/:jobId/run', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const jobs = p.settings.jobs || [];
    const job = jobs.find((j) => j.id === req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    const result = await runJob(repo, p, job);
    job.lastRun = Date.now(); job.lastResult = result;
    await repo.updateProject(p.id, { settings: { ...p.settings, jobs } });
    res.json({ result });
  } catch (e) { next(e); }
});
router.delete('/projects/:id/jobs/:jobId', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const jobs = (p.settings.jobs || []).filter((j) => j.id !== req.params.jobId);
    await repo.updateProject(p.id, { settings: { ...p.settings, jobs } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 범위 제한 API 키 관리 ----
router.get('/projects/:id/keys', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const p = await getRepo().getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    res.json({ keys: p.settings.apiKeys || [] });
  } catch (e) { next(e); }
});
router.post('/projects/:id/keys', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const { label, mode, collections, expiresInDays } = req.body || {};
    const def = {
      id: randomId('k_'), key: randomKey(), label: (label || '추가 키') + '',
      mode: mode === 'read' ? 'read' : 'write',
      collections: Array.isArray(collections) && collections.length ? collections.filter((c) => /^[A-Za-z0-9_\-.]{1,128}$/.test(c)) : null,
      expiresAt: expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null,
      created_at: Date.now(),
    };
    const apiKeys = [...(p.settings.apiKeys || []), def];
    await repo.updateProject(p.id, { settings: { ...p.settings, apiKeys } });
    res.status(201).json({ key: def });
  } catch (e) { next(e); }
});
router.delete('/projects/:id/keys/:keyId', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const apiKeys = (p.settings.apiKeys || []).filter((k) => k.id !== req.params.keyId);
    await repo.updateProject(p.id, { settings: { ...p.settings, apiKeys } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- 웹훅 관리 ----
router.get('/projects/:id/webhooks', requireAdmin, async (req, res, next) => {
  try {
    const p = await getRepo().getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    res.json({ webhooks: p.settings.webhooks || [] });
  } catch (e) { next(e); }
});
router.post('/projects/:id/webhooks', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const { url, events } = req.body || {};
    if (!url || !/^https?:\/\/.+/.test(url)) return res.status(400).json({ error: 'bad_url', message: 'http(s) URL이 필요합니다.' });
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const hook = { id: randomId('wh_'), url, events: Array.isArray(events) ? events : [], secret: 'whsec_' + crypto.randomBytes(16).toString('hex'), active: true, created_at: Date.now() };
    const webhooks = [...(p.settings.webhooks || []), hook];
    await repo.updateProject(p.id, { settings: { ...p.settings, webhooks } });
    res.status(201).json({ webhook: hook });
  } catch (e) { next(e); }
});
router.delete('/projects/:id/webhooks/:whid', requireAdmin, requireRole('admin'), async (req, res, next) => {
  try {
    const repo = getRepo();
    const p = await repo.getProject(req.params.id);
    if (!p || p.id === SYS) return res.status(404).json({ error: 'not_found' });
    const webhooks = (p.settings.webhooks || []).filter((w) => w.id !== req.params.whid);
    await repo.updateProject(p.id, { settings: { ...p.settings, webhooks } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 클러스터 노드 목록
router.get('/nodes', requireAdmin, async (_req, res, next) => {
  try {
    const nodes = await getRepo().listNodes();
    res.json({ nodes });
  } catch (e) { next(e); }
});

function publicProject(p) {
  return { id: p.id, name: p.name, slug: p.slug, api_key: p.api_key, secret_key: p.secret_key || null, status: p.status, plan: p.settings?.plan || 'free', created_at: p.created_at };
}

export { ensureAdmin };
export default router;
