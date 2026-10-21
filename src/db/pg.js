// PostgreSQL 드라이버. 여러 노드가 같은 DB를 바라보며 수평 확장할 때 사용.
// DATABASE_URL 환경변수 설정 시 자동 선택. 인터페이스는 sqlite/memory와 동일.
import pg from 'pg';
import { applyIncs, normalizeFilters, normalizeSort } from '../util.js';

// 서버측 쿼리 빌더 (JSONB 필드 필터/정렬)
const PGOPS = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const okField = (f) => typeof f === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(f);
function jsonPath(field) { // a.b.c → data#>>'{a,b,c}'
  const parts = field.split('.').map((s) => s.replace(/[^A-Za-z0-9_]/g, ''));
  return `data#>>'{${parts.join(',')}}'`;
}
function pgWhere(filters, params) {
  filters = normalizeFilters(filters);
  let sql = '';
  for (const f of filters || []) {
    if (!okField(f.field)) continue;
    const col = jsonPath(f.field);
    if (f.op === 'contains') { params.push('%' + f.value + '%'); sql += ` AND ${col} ILIKE $${params.length}`; }
    else if (['gt', 'gte', 'lt', 'lte'].includes(f.op)) { params.push(Number(f.value)); sql += ` AND (${col})::numeric ${PGOPS[f.op]} $${params.length}`; }
    else if (PGOPS[f.op]) { params.push(String(f.value)); sql += ` AND ${col} ${PGOPS[f.op]} $${params.length}`; }
  }
  return sql;
}
function pgOrder(sort) {
  sort = normalizeSort(sort);
  if (!sort || !okField(sort.field)) return ' ORDER BY updated_at DESC';
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  if (sort.field === 'updated_at' || sort.field === 'created_at') return ` ORDER BY ${sort.field} ${dir}`;
  return ` ORDER BY ${jsonPath(sort.field)} ${dir}`;
}

export async function createPgRepo(config) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const q = (text, params) => pool.query(text, params);

  await q(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      api_key TEXT UNIQUE NOT NULL, secret_key TEXT, status TEXT NOT NULL DEFAULT 'active',
      settings JSONB NOT NULL DEFAULT '{}', created_at BIGINT NOT NULL);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS secret_key TEXT;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, email TEXT NOT NULL,
      password_hash TEXT NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'user',
      meta JSONB NOT NULL DEFAULT '{}', created_at BIGINT NOT NULL, UNIQUE(project_id, email));
    CREATE INDEX IF NOT EXISTS idx_users_project ON users(project_id);
    CREATE TABLE IF NOT EXISTS records (
      project_id TEXT NOT NULL, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
      data JSONB NOT NULL, owner_id TEXT, deleted INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY(project_id, collection, doc_id));
    ALTER TABLE records ADD COLUMN IF NOT EXISTS deleted INT NOT NULL DEFAULT 0;
    ALTER TABLE records ADD COLUMN IF NOT EXISTS rev INT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_records_coll ON records(project_id, collection, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_records_owner ON records(project_id, collection, owner_id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT,
      size BIGINT NOT NULL, storage_path TEXT NOT NULL, owner_id TEXT, created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, project_id TEXT, actor_id TEXT, action TEXT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}', ip TEXT, created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS record_history (
      id BIGSERIAL PRIMARY KEY, project_id TEXT NOT NULL, collection TEXT NOT NULL, doc_id TEXT NOT NULL,
      op TEXT NOT NULL, data JSONB, actor_id TEXT, created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_history_doc ON record_history(project_id, collection, doc_id, id DESC);
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, mode TEXT NOT NULL, label TEXT,
      load REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'up',
      last_seen BIGINT NOT NULL, meta JSONB NOT NULL DEFAULT '{}');
  `);

  const one = (r) => r.rows[0] || null;
  return {
    driver: 'postgres',
    async close() { await pool.end(); },

    async createProject(p) {
      await q(`INSERT INTO projects(id,name,slug,api_key,secret_key,status,settings,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.id, p.name, p.slug, p.api_key, p.secret_key ?? null, p.status || 'active', p.settings || {}, p.created_at || Date.now()]);
      return this.getProject(p.id);
    },
    async getProject(id) { return one(await q('SELECT * FROM projects WHERE id=$1', [id])); },
    async getProjectByKey(k) { return one(await q('SELECT * FROM projects WHERE api_key=$1', [k])); },
    async getProjectBySecretKey(k) { return one(await q('SELECT * FROM projects WHERE secret_key=$1', [k])); },
    async getProjectBySlug(s) { return one(await q('SELECT * FROM projects WHERE slug=$1', [s])); },
    async listProjects() { return (await q('SELECT * FROM projects ORDER BY created_at DESC')).rows; },
    async updateProject(id, patch) {
      const c = await this.getProject(id); if (!c) return null; const n = { ...c, ...patch };
      await q('UPDATE projects SET name=$1,status=$2,settings=$3,api_key=$4,secret_key=$5 WHERE id=$6', [n.name, n.status, n.settings, n.api_key, n.secret_key ?? null, id]);
      return this.getProject(id);
    },
    async deleteProject(id) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('DELETE FROM users WHERE project_id=$1', [id]);
        await c.query('DELETE FROM records WHERE project_id=$1', [id]);
        await c.query('DELETE FROM files WHERE project_id=$1', [id]);
        await c.query('DELETE FROM projects WHERE id=$1', [id]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return true;
    },
    async countUsers(pid) { return parseInt((await q('SELECT COUNT(*) c FROM users WHERE project_id=$1', [pid])).rows[0].c, 10); },
    async countRecords(pid) { return parseInt((await q('SELECT COUNT(*) c FROM records WHERE project_id=$1', [pid])).rows[0].c, 10); },
    async sumFileBytes(pid) { return parseInt((await q('SELECT COALESCE(SUM(size),0)::bigint s FROM files WHERE project_id=$1', [pid])).rows[0].s, 10); },

    async createUser(u) {
      await q(`INSERT INTO users(id,project_id,email,password_hash,name,role,meta,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.id, u.project_id, u.email, u.password_hash, u.name, u.role || 'user', u.meta || {}, u.created_at || Date.now()]);
      return this.getUser(u.id);
    },
    async getUser(id) { return one(await q('SELECT * FROM users WHERE id=$1', [id])); },
    async getUserByEmail(pid, email) { return one(await q('SELECT * FROM users WHERE project_id=$1 AND email=$2', [pid, email])); },
    async listUsers(pid, { limit = 100, offset = 0 } = {}) {
      return (await q('SELECT * FROM users WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [pid, limit, offset])).rows;
    },
    async updateUser(id, patch) {
      const c = await this.getUser(id); if (!c) return null; const n = { ...c, ...patch };
      await q('UPDATE users SET name=$1,role=$2,password_hash=$3,meta=$4 WHERE id=$5', [n.name, n.role, n.password_hash, n.meta, id]);
      return this.getUser(id);
    },
    async deleteUser(id) { await q('DELETE FROM users WHERE id=$1', [id]); return true; },

    async putRecord(r) {
      const now = Date.now();
      if (r.expectedRev != null) {
        // 낙관적 동시성: 트랜잭션 안에서 현재 rev 확인 후 일치할 때만 수정
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const ex = (await c.query('SELECT created_at, rev FROM records WHERE project_id=$1 AND collection=$2 AND doc_id=$3 FOR UPDATE', [r.project_id, r.collection, r.doc_id])).rows[0];
          const curRev = ex ? ex.rev : 0;
          if (curRev !== Number(r.expectedRev)) { await c.query('ROLLBACK'); const e = new Error('rev_conflict'); e.code = 'rev_conflict'; e.current = curRev; throw e; }
          await c.query(`INSERT INTO records(project_id,collection,doc_id,data,owner_id,created_at,updated_at,rev)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(project_id,collection,doc_id) DO UPDATE SET data=$4,updated_at=$7,rev=$8`,
            [r.project_id, r.collection, r.doc_id, r.data, r.owner_id, ex ? Number(ex.created_at) : now, now, curRev + 1]);
          await c.query('COMMIT');
        } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); }
        return this.getRecord(r.project_id, r.collection, r.doc_id);
      }
      await q(`INSERT INTO records(project_id,collection,doc_id,data,owner_id,created_at,updated_at,rev)
        VALUES($1,$2,$3,$4,$5,$6,$7,1)
        ON CONFLICT(project_id,collection,doc_id) DO UPDATE SET data=$4,updated_at=$7,rev=records.rev+1`,
        [r.project_id, r.collection, r.doc_id, r.data, r.owner_id, now, now]);
      return this.getRecord(r.project_id, r.collection, r.doc_id);
    },
    // 원자적 증감 (SELECT ... FOR UPDATE 트랜잭션).
    async incRecord(projectId, collection, docId, incs, { ownerId = null, createIfMissing = true } = {}) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const ex = (await c.query('SELECT * FROM records WHERE project_id=$1 AND collection=$2 AND doc_id=$3 FOR UPDATE', [projectId, collection, docId])).rows[0];
        if ((!ex || ex.deleted) && !createIfMissing) { await c.query('ROLLBACK'); return null; }
        const base = (ex && !ex.deleted) ? ex.data : {};
        const data = applyIncs({ ...base }, incs);
        const now = Date.now();
        const rev = (ex ? ex.rev : 0) + 1;
        await c.query(`INSERT INTO records(project_id,collection,doc_id,data,owner_id,created_at,updated_at,rev,deleted)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,0)
          ON CONFLICT(project_id,collection,doc_id) DO UPDATE SET data=$4,updated_at=$7,rev=$8,deleted=0`,
          [projectId, collection, docId, data, ex ? ex.owner_id : ownerId, ex ? Number(ex.created_at) : now, now, rev]);
        await c.query('COMMIT');
      } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); }
      return this.getRecord(projectId, collection, docId);
    },
    async getRecord(p, c, d) { return one(await q('SELECT * FROM records WHERE project_id=$1 AND collection=$2 AND doc_id=$3', [p, c, d])); },
    async queryRecords(p, c, { ownerId, limit = 100, offset = 0, filters, sort, deleted = false, q: qq } = {}) {
      const params = [p, c, deleted ? 1 : 0]; let sql = 'SELECT * FROM records WHERE project_id=$1 AND collection=$2 AND deleted=$3';
      if (ownerId) { params.push(ownerId); sql += ` AND owner_id=$${params.length}`; }
      sql += pgWhere(filters, params);
      if (qq) { params.push('%' + qq + '%'); sql += ` AND data::text ILIKE $${params.length}`; }
      sql += pgOrder(sort);
      params.push(limit); sql += ` LIMIT $${params.length}`;
      params.push(offset); sql += ` OFFSET $${params.length}`;
      return (await q(sql, params)).rows;
    },
    async countCollection(p, c, { ownerId, filters, deleted = false, q: qq } = {}) {
      const params = [p, c, deleted ? 1 : 0]; let sql = 'SELECT COUNT(*)::int c FROM records WHERE project_id=$1 AND collection=$2 AND deleted=$3';
      if (ownerId) { params.push(ownerId); sql += ` AND owner_id=$${params.length}`; }
      sql += pgWhere(filters, params);
      if (qq) { params.push('%' + qq + '%'); sql += ` AND data::text ILIKE $${params.length}`; }
      return (await q(sql, params)).rows[0].c;
    },
    async deleteRecord(p, c, d, { hard = false } = {}) {
      if (hard) await q('DELETE FROM records WHERE project_id=$1 AND collection=$2 AND doc_id=$3', [p, c, d]);
      else await q('UPDATE records SET deleted=1, updated_at=$4 WHERE project_id=$1 AND collection=$2 AND doc_id=$3', [p, c, d, Date.now()]);
      return true;
    },
    async restoreRecord(p, c, d) {
      await q('UPDATE records SET deleted=0, updated_at=$4 WHERE project_id=$1 AND collection=$2 AND doc_id=$3', [p, c, d, Date.now()]);
      return this.getRecord(p, c, d);
    },
    async listCollections(pid) {
      return (await q('SELECT collection, COUNT(*)::int c FROM records WHERE project_id=$1 AND deleted=0 GROUP BY collection', [pid])).rows
        .map((r) => ({ collection: r.collection, count: r.c }));
    },
    async addHistory(h) {
      await q('INSERT INTO record_history(project_id,collection,doc_id,op,data,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [h.project_id, h.collection, h.doc_id, h.op, h.data ?? null, h.actor_id ?? null, Date.now()]);
    },
    async listHistory(pid, c, d, { limit = 100 } = {}) {
      return (await q('SELECT * FROM record_history WHERE project_id=$1 AND collection=$2 AND doc_id=$3 ORDER BY id DESC LIMIT $4', [pid, c, d, limit])).rows
        .map((r) => ({ version: Number(r.id), op: r.op, data: r.data, actor_id: r.actor_id, created_at: Number(r.created_at) }));
    },
    async getHistoryVersion(pid, c, d, version) {
      const r = (await q('SELECT * FROM record_history WHERE id=$1 AND project_id=$2 AND collection=$3 AND doc_id=$4', [version, pid, c, d])).rows[0];
      return r ? { version: Number(r.id), op: r.op, data: r.data, created_at: Number(r.created_at) } : null;
    },

    async aggregate(pid, c, { field, op = 'count', groupBy, filters } = {}) {
      const params = [pid, c];
      const where = pgWhere(filters, params);
      const valExpr = field && okField(field) ? `(${jsonPath(field)})::numeric` : null;
      const aggSql = op === 'count' ? 'COUNT(*)'
        : op === 'sum' ? `SUM(${valExpr})`
        : op === 'avg' ? `AVG(${valExpr})`
        : op === 'min' ? `MIN(${valExpr})`
        : op === 'max' ? `MAX(${valExpr})` : 'COUNT(*)';
      if (op !== 'count' && !valExpr) return groupBy ? { groups: [] } : { value: null };
      const base = `FROM records WHERE project_id=$1 AND collection=$2 AND deleted=0${where}`;
      if (!groupBy || !okField(groupBy)) {
        const row = (await q(`SELECT ${aggSql} v ${base}`, params)).rows[0];
        return { value: row.v == null ? null : Number(row.v) };
      }
      const gExpr = jsonPath(groupBy);
      const rows = (await q(`SELECT ${gExpr} g, ${aggSql} v ${base} GROUP BY ${gExpr} ORDER BY v DESC`, params)).rows;
      return { groups: rows.map((r) => ({ group: r.g, value: r.v == null ? null : Number(r.v) })) };
    },

    async sweepOldRecords(pid, c, cutoffMs) {
      const r = await q('UPDATE records SET deleted=1, updated_at=$4 WHERE project_id=$1 AND collection=$2 AND deleted=0 AND updated_at < $3', [pid, c, cutoffMs, Date.now()]);
      return r.rowCount;
    },
    async purgeTrash(pid, cutoffMs) {
      const r = await q('DELETE FROM records WHERE project_id=$1 AND deleted=1 AND updated_at < $2', [pid, cutoffMs]);
      return r.rowCount;
    },

    async createFile(f) {
      await q(`INSERT INTO files(id,project_id,filename,mime,size,storage_path,owner_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [f.id, f.project_id, f.filename, f.mime, f.size, f.storage_path, f.owner_id, f.created_at || Date.now()]);
      return this.getFile(f.id);
    },
    async getFile(id) { return one(await q('SELECT * FROM files WHERE id=$1', [id])); },
    async listFiles(pid, { limit = 100, offset = 0 } = {}) {
      return (await q('SELECT * FROM files WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [pid, limit, offset])).rows;
    },
    async deleteFile(id) { await q('DELETE FROM files WHERE id=$1', [id]); return true; },

    async addAudit(a) {
      await q(`INSERT INTO audit(id,project_id,actor_id,action,meta,ip,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.project_id, a.actor_id, a.action, a.meta || {}, a.ip, a.created_at || Date.now()]);
    },
    async listAudit({ projectId, limit = 100, offset = 0 } = {}) {
      if (projectId) return (await q('SELECT * FROM audit WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [projectId, limit, offset])).rows;
      return (await q('SELECT * FROM audit ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset])).rows;
    },

    async upsertNode(n) {
      await q(`INSERT INTO nodes(id,url,mode,label,load,status,last_seen,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET url=$2,mode=$3,label=$4,load=$5,status=$6,last_seen=$7,meta=$8`,
        [n.id, n.url, n.mode, n.label || '', n.load || 0, n.status || 'up', Date.now(), n.meta || {}]);
    },
    async listNodes() { return (await q('SELECT * FROM nodes ORDER BY last_seen DESC')).rows; },
    async removeStaleNodes(maxAgeMs) { await q('DELETE FROM nodes WHERE last_seen < $1', [Date.now() - maxAgeMs]); },
    async retentionSweep(days) {
      if (!days) return 0;
      const r = await q('DELETE FROM audit WHERE created_at < $1', [Date.now() - days * 86400000]);
      return r.rowCount;
    },
    async dumpProject(pid) {
      return {
        users: (await q('SELECT * FROM users WHERE project_id=$1', [pid])).rows,
        records: (await q('SELECT * FROM records WHERE project_id=$1', [pid])).rows,
        files: (await q('SELECT * FROM files WHERE project_id=$1', [pid])).rows,
      };
    },
  };
}
