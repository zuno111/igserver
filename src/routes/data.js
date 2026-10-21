// 범용 데이터 API. 프로젝트가 자유롭게 컬렉션/문서를 저장·조회 (Firestore 스타일).
// 어떤 웹앱/앱이든 이 API만으로 백엔드 저장소를 쓸 수 있다.
// 권한 규칙: ?scope=private → 본인 문서만 / 기본(public) → 프로젝트 내 공유
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { fireWebhooks } from '../webhooks.js';
import { getLimits, quotaError } from '../quota.js';
import { validate, getSchema } from '../schema.js';
import { canRead, canWrite, canManageAcl, getAcl, sanitizeAcl } from '../acl.js';
import { randomId } from '../config.js';
import { normalizeIncs } from '../util.js';

const router = Router();

// 서버 전용 컬렉션 보호: '_' 로 시작하는 컬렉션은 범용 데이터 API로 읽기/쓰기 금지
// (ISC 지갑/원장 등 서버 권한 데이터는 전용 모듈에서만 다룬다)
router.param('collection', (req, res, next, val) => {
  if (typeof val === 'string' && val.startsWith('_')) {
    return res.status(403).json({ error: 'reserved_collection', message: '서버 전용 컬렉션입니다.' });
  }
  next();
});

// 실시간 변경 알림. 비공개(_acl) 레코드는 읽기 권한자에게만 보낸다(정보 유출 방지).
// 공개(_acl 없음 또는 public)면 컬렉션 구독자 전체에게 보낸다.
function emitChange(req, collection, rec, payload) {
  const pid = req.project.id;
  const acl = rec ? getAcl(rec) : null;
  if (!acl || acl.public === true) { broadcast(pid, `data:${collection}`, payload); return; }
  broadcast(pid, `data:${collection}`, payload, (ws) => canRead(rec, ws.uid ? { uid: ws.uid, role: 'user' } : null));
}

// 참조 필드 펼치기(조인). expand=field:collection (반복 가능). data[field]가 다른 레코드의 id면 그 레코드를 붙인다.
async function expandItems(repo, pid, items, rawExpand) {
  if (!rawExpand) return;
  const specs = (Array.isArray(rawExpand) ? rawExpand : [rawExpand])
    .map((s) => String(s).split(':')).filter((a) => a.length === 2 && safeName(a[1]));
  if (!specs.length) return;
  for (const it of items) {
    for (const [field, coll] of specs) {
      const refId = it.data?.[field];
      if (typeof refId !== 'string' || !safeName(refId)) continue;
      const ref = await repo.getRecord(pid, coll, refId);
      if (ref && !ref.deleted) (it._expand ||= {})[field] = outRecord(ref);
    }
  }
}

// 변경 이력 기록 (프로젝트 settings.history !== false 일 때. 기본 on)
function recordHistory(req, collection, docId, op, data) {
  if (req.project?.settings?.history === false) return;
  getRepo().addHistory({ project_id: req.project.id, collection, doc_id: docId, op, data, actor_id: req.user?.uid })
    .catch(() => {});
}

// 안전한 컬렉션/문서 이름
function safeName(s) { return typeof s === 'string' && /^[A-Za-z0-9_\-.]{1,128}$/.test(s); }

// 쿼리 파라미터 파싱: filter=field:op:value (반복), sort=field:dir
const VALID_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']);
function coerce(v) { if (v === '' || v == null) return v; const n = Number(v); return (!isNaN(n) && String(n) === v) ? n : v; }
function parseFilters(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((s) => { const [field, op, ...rest] = String(s).split(':'); return { field, op, value: coerce(rest.join(':')) }; })
    .filter((f) => f.field && VALID_OPS.has(f.op));
}
function parseSort(raw) {
  if (!raw) return null;
  const [field, dir] = String(raw).split(':');
  return field ? { field, dir: dir === 'asc' ? 'asc' : 'desc' } : null;
}
function queryOpts(req) {
  const opts = { filters: parseFilters(req.query.filter), sort: parseSort(req.query.sort), deleted: req.query.deleted === 'true' };
  if (req.query.q) opts.q = String(req.query.q).slice(0, 200);
  if (req.query.scope === 'private') {
    if (!req.user) { const e = new Error('본인 데이터 조회는 로그인이 필요합니다.'); e.status = 401; e.code = 'no_token'; throw e; }
    opts.ownerId = req.user.uid;
  }
  return opts;
}

// 건수: GET /data/:collection/_count  (/:id 보다 먼저 등록)
router.get('/:collection/_count', optionalUser, async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!safeName(collection)) return res.status(400).json({ error: 'bad_collection' });
    const opts = queryOpts(req);
    const count = await getRepo().countCollection(req.project.id, collection, { ownerId: opts.ownerId, filters: opts.filters, deleted: opts.deleted, q: opts.q });
    res.json({ count });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.code, message: e.message }); next(e); }
});

// 집계: GET /data/:collection/_aggregate?op=sum|avg|min|max|count&field=&groupBy=&filter=
router.get('/:collection/_aggregate', optionalUser, async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!safeName(collection)) return res.status(400).json({ error: 'bad_collection' });
    const op = ['sum', 'avg', 'min', 'max', 'count'].includes(req.query.op) ? req.query.op : 'count';
    const field = req.query.field ? String(req.query.field) : null;
    const groupBy = req.query.groupBy ? String(req.query.groupBy) : null;
    if (op !== 'count' && !field) return res.status(400).json({ error: 'no_field', message: `${op} 집계는 field가 필요합니다.` });
    const filters = parseFilters(req.query.filter);
    const result = await getRepo().aggregate(req.project.id, collection, { field, op, groupBy, filters });
    res.json({ op, field, groupBy, ...result });
  } catch (e) { next(e); }
});

// 목록: GET /data/:collection?scope=private&filter=f:op:v&sort=field:dir&limit=&offset=
router.get('/:collection', optionalUser, async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!safeName(collection)) return res.status(400).json({ error: 'bad_collection' });
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const opts = { limit, offset, ...queryOpts(req) };
    const rows = await getRepo().queryRecords(req.project.id, collection, opts);
    const items = rows.map(outRecord);
    await expandItems(getRepo(), req.project.id, items, req.query.expand);
    res.json({ items });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.code, message: e.message }); next(e); }
});

// 단건: GET /data/:collection/:id
router.get('/:collection/:id', optionalUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    if (!safeName(collection)) return res.status(400).json({ error: 'bad_collection' });
    const rec = await getRepo().getRecord(req.project.id, collection, id);
    if (!rec || rec.deleted) return res.status(404).json({ error: 'not_found' });
    if (!canRead(rec, req.user)) return res.status(403).json({ error: 'forbidden', message: '이 문서를 볼 권한이 없습니다.' });
    const item = outRecord(rec);
    await expandItems(getRepo(), req.project.id, [item], req.query.expand);
    res.json({ item });
  } catch (e) { next(e); }
});

// 배치: POST /data/:collection/_batch  { ops: [{op:'create'|'update'|'delete', id?, data?, hard?}] }
router.post('/:collection/_batch', requireUser, async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!safeName(collection)) return res.status(400).json({ error: 'bad_collection' });
    const ops = req.body?.ops;
    if (!Array.isArray(ops)) return res.status(400).json({ error: 'bad_ops', message: 'ops 배열이 필요합니다.' });
    if (ops.length > 200) return res.status(400).json({ error: 'too_many', message: '한 번에 최대 200개까지 가능합니다.' });
    const repo = getRepo();
    const schema = getSchema(req.project, collection);
    const limits = getLimits(req.project);
    let recordCount = limits.maxRecords === Infinity ? 0 : await repo.countRecords(req.project.id);
    const results = [];
    let changed = false;
    for (const op of ops) {
      try {
        if (op.op === 'create') {
          if (limits.maxRecords !== Infinity && recordCount >= limits.maxRecords) { results.push({ ok: false, error: 'quota_exceeded' }); continue; }
          if (schema) { const e = validate(schema, op.data); if (e.length) { results.push({ ok: false, error: 'validation_failed', errors: e }); continue; } }
          const docId = randomId('d_');
          const rec = await repo.putRecord({ project_id: req.project.id, collection, doc_id: docId, data: op.data ?? {}, owner_id: req.user.uid });
          recordCount++; changed = true;
          recordHistory(req, collection, docId, 'create', rec.data);
          emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'create', id: docId, data: rec.data, rev: rec.rev, ts: Date.now() });
          results.push({ ok: true, op: 'create', id: docId });
        } else if (op.op === 'update') {
          if (!op.id) { results.push({ ok: false, error: 'no_id' }); continue; }
          const ex = await repo.getRecord(req.project.id, collection, op.id);
          if (!ex || ex.deleted) { results.push({ ok: false, error: 'not_found', id: op.id }); continue; }
          if (!canWrite(ex, req.user)) { results.push({ ok: false, error: 'forbidden', id: op.id }); continue; }
          if (schema) { const e = validate(schema, op.data); if (e.length) { results.push({ ok: false, error: 'validation_failed', errors: e, id: op.id }); continue; } }
          const rec = await repo.putRecord({ project_id: req.project.id, collection, doc_id: op.id, data: op.data ?? {}, owner_id: ex.owner_id });
          changed = true;
          recordHistory(req, collection, op.id, 'update', rec.data);
          emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'update', id: op.id, data: rec.data, rev: rec.rev, ts: Date.now() });
          results.push({ ok: true, op: 'update', id: op.id });
        } else if (op.op === 'delete') {
          if (!op.id) { results.push({ ok: false, error: 'no_id' }); continue; }
          const ex = await repo.getRecord(req.project.id, collection, op.id);
          if (!ex) { results.push({ ok: false, error: 'not_found', id: op.id }); continue; }
          if (!canWrite(ex, req.user)) { results.push({ ok: false, error: 'forbidden', id: op.id }); continue; }
          await repo.deleteRecord(req.project.id, collection, op.id, { hard: !!op.hard });
          changed = true;
          recordHistory(req, collection, op.id, op.hard ? 'hard_delete' : 'delete', null);
          emitChange(req, collection, ex, { type: 'data_changed', collection, op: op.hard ? 'hard_delete' : 'delete', id: op.id, ts: Date.now() });
          results.push({ ok: true, op: 'delete', id: op.id });
        } else {
          results.push({ ok: false, error: 'bad_op', op: op.op });
        }
      } catch (e) { results.push({ ok: false, error: String(e.message || e) }); }
    }
    if (changed) fireWebhooks(req.project, 'data.batch', { collection, count: results.filter((r) => r.ok).length });
    res.json({ results, total: results.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (e) { next(e); }
});

// 생성(자동 ID): POST /data/:collection  { ...data }
router.post('/:collection', requireUser, async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (!safeName(collection)) return res.status(400).json({ error: 'bad_collection' });
    // 스키마 검증
    const schema = getSchema(req.project, collection);
    if (schema) { const errs = validate(schema, req.body); if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs }); }
    // 쿼터: 레코드 수 한도
    const limits = getLimits(req.project);
    if (limits.maxRecords !== Infinity && (await getRepo().countRecords(req.project.id)) >= limits.maxRecords) return quotaError(res, 'records', limits.maxRecords);
    const docId = randomId('d_');
    const rec = await getRepo().putRecord({
      project_id: req.project.id, collection, doc_id: docId,
      data: req.body ?? {}, owner_id: req.user.uid,
    });
    emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'create', id: docId, data: rec.data, rev: rec.rev, ts: Date.now() });
    recordHistory(req, collection, docId, 'create', rec.data);
    fireWebhooks(req.project, 'data.create', { collection, id: docId, data: rec.data });
    res.status(201).json({ item: outRecord(rec) });
  } catch (e) { next(e); }
});

// 생성/덮어쓰기(ID 지정): PUT /data/:collection/:id
router.put('/:collection/:id', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    if (!safeName(collection) || !safeName(id)) return res.status(400).json({ error: 'bad_name' });
    const schema = getSchema(req.project, collection);
    if (schema) { const errs = validate(schema, req.body); if (errs.length) return res.status(422).json({ error: 'validation_failed', errors: errs }); }
    const repo = getRepo();
    const existing = await repo.getRecord(req.project.id, collection, id);
    // 소유자 또는 _acl.writers 만 수정 가능 (신규 생성은 허용)
    if (existing && !canWrite(existing, req.user)) {
      return res.status(403).json({ error: 'forbidden', message: '이 문서를 수정할 권한이 없습니다.' });
    }
    // _acl 은 소유자만 변경 가능 — 권한 없으면 기존 _acl 유지
    const body = { ...(req.body ?? {}) };
    // 낙관적 동시성: If-Match 헤더 또는 body._rev 로 기대 버전 지정 (제어 필드는 저장에서 제외)
    let expectedRev;
    const ifm = req.get('If-Match');
    if (ifm != null && ifm !== '' && ifm !== '*') { const n = parseInt(String(ifm).replace(/"/g, ''), 10); if (Number.isFinite(n)) expectedRev = n; }
    else if (body._rev != null) { const n = parseInt(body._rev, 10); if (Number.isFinite(n)) expectedRev = n; }
    delete body._rev;
    if (existing && '_acl' in body && !canManageAcl(existing, req.user)) {
      if (getAcl(existing)) body._acl = getAcl(existing); else delete body._acl;
    }
    let rec;
    try {
      rec = await repo.putRecord({
        project_id: req.project.id, collection, doc_id: id,
        data: body, owner_id: existing?.owner_id || req.user.uid, expectedRev,
      });
    } catch (e) {
      if (e.code === 'rev_conflict') return res.status(409).json({ error: 'rev_conflict', message: '다른 곳에서 먼저 수정되었습니다. 최신 내용을 받아 다시 시도하세요.', current: e.current });
      throw e;
    }
    emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'update', id, data: rec.data, rev: rec.rev, ts: Date.now() });
    recordHistory(req, collection, id, 'update', rec.data);
    fireWebhooks(req.project, 'data.update', { collection, id, data: rec.data });
    res.json({ item: outRecord(rec) });
  } catch (e) { next(e); }
});

// 삭제: DELETE /data/:collection/:id  (기본 소프트 삭제, ?hard=true 영구 삭제)
router.delete('/:collection/:id', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const repo = getRepo();
    const existing = await repo.getRecord(req.project.id, collection, id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!canWrite(existing, req.user)) {
      return res.status(403).json({ error: 'forbidden', message: '이 문서를 삭제할 권한이 없습니다.' });
    }
    const hard = req.query.hard === 'true';
    await repo.deleteRecord(req.project.id, collection, id, { hard });
    recordHistory(req, collection, id, hard ? 'hard_delete' : 'delete', null);
    emitChange(req, collection, existing, { type: 'data_changed', collection, op: hard ? 'hard_delete' : 'delete', id, ts: Date.now() });
    fireWebhooks(req.project, hard ? 'data.hard_delete' : 'data.delete', { collection, id });
    res.json({ ok: true, hard });
  } catch (e) { next(e); }
});

// 원자적 증감: POST /data/:collection/:id/inc  { field, by } 또는 { fields: {점수:10, 좋아요:-1} }
// 동시에 여러 번 호출돼도 값이 정확히 누적된다(경쟁 조건 없음). 없으면 0에서 시작해 생성.
router.post('/:collection/:id/inc', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    if (!safeName(collection) || !safeName(id)) return res.status(400).json({ error: 'bad_name' });
    const { incs, error } = normalizeIncs(req.body);
    if (error) return res.status(400).json({ error: 'bad_inc', message: error });
    const repo = getRepo();
    const existing = await repo.getRecord(req.project.id, collection, id);
    if (existing && !existing.deleted && !canWrite(existing, req.user)) {
      return res.status(403).json({ error: 'forbidden', message: '이 문서를 수정할 권한이 없습니다.' });
    }
    const rec = await repo.incRecord(req.project.id, collection, id, incs, { ownerId: req.user.uid, createIfMissing: true });
    recordHistory(req, collection, id, 'inc', rec.data);
    emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'update', id, data: rec.data, rev: rec.rev, ts: Date.now() });
    fireWebhooks(req.project, 'data.update', { collection, id, data: rec.data });
    res.json({ item: outRecord(rec) });
  } catch (e) { next(e); }
});

// 레코드 공유 설정: POST /data/:collection/:id/share  { public, readers, writers }  (소유자만)
router.post('/:collection/:id/share', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const repo = getRepo();
    const existing = await repo.getRecord(req.project.id, collection, id);
    if (!existing || existing.deleted) return res.status(404).json({ error: 'not_found' });
    if (!canManageAcl(existing, req.user)) return res.status(403).json({ error: 'forbidden', message: '소유자만 공유 설정을 바꿀 수 있습니다.' });
    const acl = sanitizeAcl(req.body);
    const data = { ...existing.data, _acl: acl };
    const rec = await repo.putRecord({ project_id: req.project.id, collection, doc_id: id, data, owner_id: existing.owner_id });
    recordHistory(req, collection, id, 'share', rec.data);
    res.json({ item: outRecord(rec), acl });
  } catch (e) { next(e); }
});

// 변경 이력 조회: GET /data/:collection/:id/history
router.get('/:collection/:id/history', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const history = await getRepo().listHistory(req.project.id, collection, id, { limit });
    res.json({ history });
  } catch (e) { next(e); }
});

// 특정 버전으로 롤백: POST /data/:collection/:id/rollback  { version }
router.post('/:collection/:id/rollback', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: 'no_version', message: 'version이 필요합니다.' });
    const repo = getRepo();
    const existing = await repo.getRecord(req.project.id, collection, id);
    if (existing && existing.owner_id && existing.owner_id !== req.user.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', message: '본인 문서만 롤백할 수 있습니다.' });
    }
    const snap = await repo.getHistoryVersion(req.project.id, collection, id, version);
    if (!snap) return res.status(404).json({ error: 'version_not_found' });
    if (snap.data == null) return res.status(400).json({ error: 'cannot_rollback', message: '삭제 시점으로는 롤백할 수 없습니다. 데이터가 있는 버전을 고르세요.' });
    const rec = await repo.putRecord({ project_id: req.project.id, collection, doc_id: id, data: snap.data, owner_id: existing?.owner_id || req.user.uid });
    recordHistory(req, collection, id, 'rollback', rec.data);
    emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'update', id, data: rec.data, rev: rec.rev, ts: Date.now() });
    fireWebhooks(req.project, 'data.update', { collection, id, data: rec.data });
    res.json({ item: outRecord(rec), rolledBackTo: version });
  } catch (e) { next(e); }
});

// 복구: POST /data/:collection/:id/restore  (휴지통 → 원복)
router.post('/:collection/:id/restore', requireUser, async (req, res, next) => {
  try {
    const { collection, id } = req.params;
    const repo = getRepo();
    const existing = await repo.getRecord(req.project.id, collection, id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (existing.owner_id && existing.owner_id !== req.user.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', message: '본인 문서만 복구할 수 있습니다.' });
    }
    const rec = await repo.restoreRecord(req.project.id, collection, id);
    emitChange(req, collection, rec, { type: 'data_changed', collection, op: 'restore', id, data: rec.data, rev: rec.rev, ts: Date.now() });
    fireWebhooks(req.project, 'data.restore', { collection, id, data: rec.data });
    res.json({ item: outRecord(rec) });
  } catch (e) { next(e); }
});

function outRecord(r) {
  return { id: r.doc_id, collection: r.collection, data: r.data, owner_id: r.owner_id, deleted: !!r.deleted, rev: r.rev ?? 0, created_at: r.created_at, updated_at: r.updated_at };
}

export default router;
