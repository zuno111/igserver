// SQLite 드라이버 (better-sqlite3). 동기 API를 async 인터페이스로 감싼다.
// 파일 하나로 영속. 제로 설정. 설치 자동(prebuilt).
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// pkg/SEA 단독 실행파일 안에서는 네이티브 .node 바인딩을 바이너리 옆에서 직접 로드한다.
// SEA에서는 addon 객체를 직접 넘겨 better-sqlite3 내부 require를 우회한다.
function resolveNativeBinding() {
  const packaged = process.env.IG_SEA === '1' || !!process.pkg;
  if (!packaged) return undefined;
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, 'better_sqlite3.node'),
    path.join(exeDir, 'build', 'Release', 'better_sqlite3.node'),
    path.join(process.cwd(), 'better_sqlite3.node'),
  ];
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!found) return undefined;
  if (process.env.IG_SEA === '1') {
    // SEA: 번들 밖에서 .node를 직접 로드해 addon 객체로 전달
    const require = createRequire(process.execPath);
    return require(found); // addon 객체
  }
  return found; // pkg: 경로 문자열
}

export function createSqliteRepo(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'igserver.db');
  const nativeBinding = resolveNativeBinding();
  const db = new Database(dbPath, nativeBinding ? { nativeBinding } : {});
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      secret_key TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      settings TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_users_project ON users(project_id);
    CREATE TABLE IF NOT EXISTS records (
      project_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      data TEXT NOT NULL,
      owner_id TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, collection, doc_id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_coll ON records(project_id, collection, updated_at);
    CREATE INDEX IF NOT EXISTS idx_records_owner ON records(project_id, collection, owner_id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT,
      size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      owner_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id, created_at);
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      actor_id TEXT,
      action TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit(project_id, created_at);
    CREATE TABLE IF NOT EXISTS record_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      op TEXT NOT NULL,
      data TEXT,
      actor_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_doc ON record_history(project_id, collection, doc_id, id);
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      mode TEXT NOT NULL,
      label TEXT,
      load REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'up',
      last_seen INTEGER NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // 기존 DB 마이그레이션 (컬럼 없으면 추가)
  try { db.exec('ALTER TABLE projects ADD COLUMN secret_key TEXT'); } catch {}
  try { db.exec('ALTER TABLE records ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0'); } catch {}

  const J = (o) => JSON.stringify(o ?? {});
  const P = (s) => { try { return JSON.parse(s); } catch { return {}; } };

  // 서버측 쿼리 빌더 (JSON 필드 필터/정렬)
  const OPS = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const okField = (f) => typeof f === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(f);
  function buildWhere(filters) {
    const clauses = [], params = [];
    for (const f of filters || []) {
      if (!okField(f.field)) continue;
      const col = `json_extract(data,'$.${f.field}')`;
      if (f.op === 'contains') { clauses.push(`${col} LIKE ?`); params.push('%' + f.value + '%'); }
      else if (OPS[f.op]) { clauses.push(`${col} ${OPS[f.op]} ?`); params.push(f.value); }
    }
    return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
  }
  function buildOrder(sort) {
    if (!sort || !okField(sort.field)) return ' ORDER BY updated_at DESC';
    const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
    if (sort.field === 'updated_at' || sort.field === 'created_at') return ` ORDER BY ${sort.field} ${dir}`;
    return ` ORDER BY json_extract(data,'$.${sort.field}') ${dir}`;
  }
  const projRow = (r) => r && { ...r, settings: P(r.settings) };
  const userRow = (r) => r && { ...r, meta: P(r.meta) };
  const recRow = (r) => r && { ...r, data: P(r.data) };
  const auditRow = (r) => r && { ...r, meta: P(r.meta) };
  const nodeRow = (r) => r && { ...r, meta: P(r.meta) };

  return {
    driver: 'sqlite',
    async close() { db.close(); },

    // ---- projects ----
    async createProject(p) {
      db.prepare(`INSERT INTO projects(id,name,slug,api_key,secret_key,status,settings,created_at)
        VALUES(@id,@name,@slug,@api_key,@secret_key,@status,@settings,@created_at)`)
        .run({ id: p.id, name: p.name, slug: p.slug, api_key: p.api_key, secret_key: p.secret_key ?? null,
          status: p.status || 'active', settings: J(p.settings), created_at: p.created_at || Date.now() });
      return this.getProject(p.id);
    },
    async getProject(id) { return projRow(db.prepare('SELECT * FROM projects WHERE id=?').get(id)); },
    async getProjectByKey(key) { return projRow(db.prepare('SELECT * FROM projects WHERE api_key=?').get(key)); },
    async getProjectBySecretKey(key) { return projRow(db.prepare('SELECT * FROM projects WHERE secret_key=?').get(key)); },
    async getProjectBySlug(slug) { return projRow(db.prepare('SELECT * FROM projects WHERE slug=?').get(slug)); },
    async listProjects() { return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all().map(projRow); },
    async updateProject(id, patch) {
      const cur = await this.getProject(id); if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE projects SET name=?,status=?,settings=?,api_key=?,secret_key=? WHERE id=?')
        .run(next.name, next.status, J(next.settings), next.api_key, next.secret_key ?? null, id);
      return this.getProject(id);
    },
    async deleteProject(id) {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM users WHERE project_id=?').run(id);
        db.prepare('DELETE FROM records WHERE project_id=?').run(id);
        db.prepare('DELETE FROM files WHERE project_id=?').run(id);
        db.prepare('DELETE FROM projects WHERE id=?').run(id);
      });
      tx();
      return true;
    },
    async countUsers(projectId) { return db.prepare('SELECT COUNT(*) c FROM users WHERE project_id=?').get(projectId).c; },
    async countRecords(projectId) { return db.prepare('SELECT COUNT(*) c FROM records WHERE project_id=?').get(projectId).c; },
    async sumFileBytes(projectId) { return db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE project_id=?').get(projectId).s; },

    // ---- users ----
    async createUser(u) {
      db.prepare(`INSERT INTO users(id,project_id,email,password_hash,name,role,meta,created_at)
        VALUES(@id,@project_id,@email,@password_hash,@name,@role,@meta,@created_at)`)
        .run({ id: u.id, project_id: u.project_id, email: u.email, password_hash: u.password_hash,
          name: u.name ?? null, role: u.role || 'user', meta: J(u.meta), created_at: u.created_at || Date.now() });
      return this.getUser(u.id);
    },
    async getUser(id) { return userRow(db.prepare('SELECT * FROM users WHERE id=?').get(id)); },
    async getUserByEmail(projectId, email) {
      return userRow(db.prepare('SELECT * FROM users WHERE project_id=? AND email=?').get(projectId, email));
    },
    async listUsers(projectId, { limit = 100, offset = 0 } = {}) {
      return db.prepare('SELECT * FROM users WHERE project_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(projectId, limit, offset).map(userRow);
    },
    async updateUser(id, patch) {
      const cur = await this.getUser(id); if (!cur) return null;
      const n = { ...cur, ...patch };
      db.prepare('UPDATE users SET name=?,role=?,password_hash=?,meta=? WHERE id=?')
        .run(n.name, n.role, n.password_hash, J(n.meta), id);
      return this.getUser(id);
    },
    async deleteUser(id) { db.prepare('DELETE FROM users WHERE id=?').run(id); return true; },

    // ---- records (범용 데이터 저장) ----
    async putRecord(r) {
      const now = Date.now();
      const exists = db.prepare('SELECT created_at FROM records WHERE project_id=? AND collection=? AND doc_id=?')
        .get(r.project_id, r.collection, r.doc_id);
      db.prepare(`INSERT INTO records(project_id,collection,doc_id,data,owner_id,created_at,updated_at)
        VALUES(@project_id,@collection,@doc_id,@data,@owner_id,@created_at,@updated_at)
        ON CONFLICT(project_id,collection,doc_id) DO UPDATE SET data=@data,updated_at=@updated_at`)
        .run({ project_id: r.project_id, collection: r.collection, doc_id: r.doc_id, data: J(r.data),
          owner_id: r.owner_id ?? null, created_at: exists ? exists.created_at : now, updated_at: now });
      return this.getRecord(r.project_id, r.collection, r.doc_id);
    },
    async getRecord(projectId, collection, docId) {
      return recRow(db.prepare('SELECT * FROM records WHERE project_id=? AND collection=? AND doc_id=?')
        .get(projectId, collection, docId));
    },
    async queryRecords(projectId, collection, { ownerId, limit = 100, offset = 0, filters, sort, deleted = false, q } = {}) {
      const w = buildWhere(filters);
      let sql = 'SELECT * FROM records WHERE project_id=? AND collection=? AND deleted=?';
      const p = [projectId, collection, deleted ? 1 : 0];
      if (ownerId) { sql += ' AND owner_id=?'; p.push(ownerId); }
      sql += w.sql; p.push(...w.params);
      if (q) { sql += ' AND data LIKE ?'; p.push('%' + q + '%'); }
      sql += buildOrder(sort) + ' LIMIT ? OFFSET ?'; p.push(limit, offset);
      return db.prepare(sql).all(...p).map(recRow);
    },
    async countCollection(projectId, collection, { ownerId, filters, deleted = false, q } = {}) {
      const w = buildWhere(filters);
      let sql = 'SELECT COUNT(*) c FROM records WHERE project_id=? AND collection=? AND deleted=?';
      const p = [projectId, collection, deleted ? 1 : 0];
      if (ownerId) { sql += ' AND owner_id=?'; p.push(ownerId); }
      sql += w.sql; p.push(...w.params);
      if (q) { sql += ' AND data LIKE ?'; p.push('%' + q + '%'); }
      return db.prepare(sql).get(...p).c;
    },
    async deleteRecord(projectId, collection, docId, { hard = false } = {}) {
      if (hard) db.prepare('DELETE FROM records WHERE project_id=? AND collection=? AND doc_id=?').run(projectId, collection, docId);
      else db.prepare('UPDATE records SET deleted=1, updated_at=? WHERE project_id=? AND collection=? AND doc_id=?').run(Date.now(), projectId, collection, docId);
      return true;
    },
    async restoreRecord(projectId, collection, docId) {
      db.prepare('UPDATE records SET deleted=0, updated_at=? WHERE project_id=? AND collection=? AND doc_id=?').run(Date.now(), projectId, collection, docId);
      return this.getRecord(projectId, collection, docId);
    },
    async listCollections(projectId) {
      return db.prepare('SELECT collection, COUNT(*) c FROM records WHERE project_id=? AND deleted=0 GROUP BY collection')
        .all(projectId).map((r) => ({ collection: r.collection, count: r.c }));
    },

    // ---- record history ----
    async addHistory(h) {
      db.prepare(`INSERT INTO record_history(project_id,collection,doc_id,op,data,actor_id,created_at)
        VALUES(?,?,?,?,?,?,?)`)
        .run(h.project_id, h.collection, h.doc_id, h.op, h.data != null ? J(h.data) : null, h.actor_id ?? null, Date.now());
    },
    async listHistory(projectId, collection, docId, { limit = 100 } = {}) {
      return db.prepare('SELECT * FROM record_history WHERE project_id=? AND collection=? AND doc_id=? ORDER BY id DESC LIMIT ?')
        .all(projectId, collection, docId, limit)
        .map((r) => ({ version: r.id, op: r.op, data: r.data ? P(r.data) : null, actor_id: r.actor_id, created_at: r.created_at }));
    },
    async getHistoryVersion(projectId, collection, docId, version) {
      const r = db.prepare('SELECT * FROM record_history WHERE id=? AND project_id=? AND collection=? AND doc_id=?')
        .get(version, projectId, collection, docId);
      return r ? { version: r.id, op: r.op, data: r.data ? P(r.data) : null, created_at: r.created_at } : null;
    },

    // ---- 집계 쿼리 ----
    async aggregate(projectId, collection, { field, op = 'count', groupBy, filters } = {}) {
      const w = buildWhere(filters);
      const valExpr = field && okField(field) ? `CAST(json_extract(data,'$.${field}') AS REAL)` : null;
      const aggSql = op === 'count' ? 'COUNT(*)'
        : op === 'sum' ? `SUM(${valExpr})`
        : op === 'avg' ? `AVG(${valExpr})`
        : op === 'min' ? `MIN(${valExpr})`
        : op === 'max' ? `MAX(${valExpr})` : 'COUNT(*)';
      if (op !== 'count' && !valExpr) return groupBy ? { groups: [] } : { value: null };
      const base = `FROM records WHERE project_id=? AND collection=? AND deleted=0${w.sql}`;
      const params = [projectId, collection, ...w.params];
      if (!groupBy || !okField(groupBy)) {
        const row = db.prepare(`SELECT ${aggSql} v ${base}`).get(...params);
        return { value: row.v };
      }
      const gExpr = `json_extract(data,'$.${groupBy}')`;
      const rows = db.prepare(`SELECT ${gExpr} g, ${aggSql} v ${base} GROUP BY ${gExpr} ORDER BY v DESC`).all(...params);
      return { groups: rows.map((r) => ({ group: r.g, value: r.v })) };
    },

    // ---- 스케줄러 정리 작업 ----
    async sweepOldRecords(projectId, collection, cutoffMs) {
      const r = db.prepare('UPDATE records SET deleted=1, updated_at=? WHERE project_id=? AND collection=? AND deleted=0 AND updated_at < ?')
        .run(Date.now(), projectId, collection, cutoffMs);
      return r.changes;
    },
    async purgeTrash(projectId, cutoffMs) {
      const r = db.prepare('DELETE FROM records WHERE project_id=? AND deleted=1 AND updated_at < ?').run(projectId, cutoffMs);
      return r.changes;
    },

    // ---- files ----
    async createFile(f) {
      db.prepare(`INSERT INTO files(id,project_id,filename,mime,size,storage_path,owner_id,created_at)
        VALUES(@id,@project_id,@filename,@mime,@size,@storage_path,@owner_id,@created_at)`)
        .run({ id: f.id, project_id: f.project_id, filename: f.filename, mime: f.mime ?? null,
          size: f.size, storage_path: f.storage_path, owner_id: f.owner_id ?? null, created_at: f.created_at || Date.now() });
      return this.getFile(f.id);
    },
    async getFile(id) { return db.prepare('SELECT * FROM files WHERE id=?').get(id); },
    async listFiles(projectId, { limit = 100, offset = 0 } = {}) {
      return db.prepare('SELECT * FROM files WHERE project_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(projectId, limit, offset);
    },
    async deleteFile(id) { db.prepare('DELETE FROM files WHERE id=?').run(id); return true; },

    // ---- audit ----
    async addAudit(a) {
      db.prepare(`INSERT INTO audit(id,project_id,actor_id,action,meta,ip,created_at)
        VALUES(@id,@project_id,@actor_id,@action,@meta,@ip,@created_at)`)
        .run({ id: a.id, project_id: a.project_id ?? null, actor_id: a.actor_id ?? null,
          action: a.action, meta: J(a.meta), ip: a.ip ?? null, created_at: a.created_at || Date.now() });
    },
    async listAudit({ projectId, limit = 100, offset = 0 } = {}) {
      if (projectId) {
        return db.prepare('SELECT * FROM audit WHERE project_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
          .all(projectId, limit, offset).map(auditRow);
      }
      return db.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset).map(auditRow);
    },

    // ---- nodes (클러스터) ----
    async upsertNode(n) {
      db.prepare(`INSERT INTO nodes(id,url,mode,label,load,status,last_seen,meta)
        VALUES(@id,@url,@mode,@label,@load,@status,@last_seen,@meta)
        ON CONFLICT(id) DO UPDATE SET url=@url,mode=@mode,label=@label,load=@load,status=@status,last_seen=@last_seen,meta=@meta`)
        .run({ ...n, label: n.label || '', load: n.load || 0, status: n.status || 'up', last_seen: Date.now(), meta: J(n.meta) });
    },
    async listNodes() { return db.prepare('SELECT * FROM nodes ORDER BY last_seen DESC').all().map(nodeRow); },
    async removeStaleNodes(maxAgeMs) {
      db.prepare('DELETE FROM nodes WHERE last_seen < ?').run(Date.now() - maxAgeMs);
    },
    async retentionSweep(days) {
      if (!days) return 0;
      const cutoff = Date.now() - days * 86400000;
      const r = db.prepare('DELETE FROM audit WHERE created_at < ?').run(cutoff);
      return r.changes;
    },

    // 프로젝트 전체 덤프 (백업)
    async dumpProject(pid) {
      return {
        users: db.prepare('SELECT * FROM users WHERE project_id=?').all(pid).map(userRow),
        records: db.prepare('SELECT * FROM records WHERE project_id=?').all(pid).map(recRow),
        files: db.prepare('SELECT * FROM files WHERE project_id=?').all(pid),
      };
    },
  };
}
