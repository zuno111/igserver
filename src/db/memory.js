// 메모리 드라이버. better-sqlite3 설치가 막힌 환경에서도 서버가 뜨게 하는 폴백.
// 재시작하면 데이터가 날아가므로 데모/테스트용. 인터페이스는 sqlite와 동일.
function getField(obj, path) { return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function matchOne(v, op, val) {
  switch (op) {
    case 'eq': return v == val;
    case 'ne': return v != val;
    case 'gt': return v > val;
    case 'gte': return v >= val;
    case 'lt': return v < val;
    case 'lte': return v <= val;
    case 'contains': return String(v ?? '').includes(String(val));
    default: return true;
  }
}
function applyFilters(arr, filters) {
  if (!filters || !filters.length) return arr;
  return arr.filter((r) => filters.every((f) => matchOne(getField(r.data, f.field), f.op, f.value)));
}
function applySort(arr, sort) {
  if (!sort || !sort.field) return arr.sort((a, b) => b.updated_at - a.updated_at);
  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = (r) => (sort.field === 'updated_at' || sort.field === 'created_at') ? r[sort.field] : getField(r.data, sort.field);
  return arr.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -dir : x > y ? dir : 0; });
}

export function createMemoryRepo() {
  const projects = new Map();
  const users = new Map();
  const records = new Map(); // key: project|collection|doc
  const files = new Map();
  const audit = [];
  const history = []; // { seq, project_id, collection, doc_id, op, data, actor_id, created_at }
  let histSeq = 0;
  const nodes = new Map();
  const rk = (p, c, d) => `${p}\u0000${c}\u0000${d}`;

  return {
    driver: 'memory',
    async close() {},

    async createProject(p) { projects.set(p.id, { status: 'active', settings: {}, created_at: Date.now(), ...p }); return projects.get(p.id); },
    async getProject(id) { return projects.get(id) || null; },
    async getProjectByKey(key) { return [...projects.values()].find((p) => p.api_key === key) || null; },
    async getProjectBySecretKey(key) { return [...projects.values()].find((p) => p.secret_key && p.secret_key === key) || null; },
    async getProjectBySlug(slug) { return [...projects.values()].find((p) => p.slug === slug) || null; },
    async listProjects() { return [...projects.values()].sort((a, b) => b.created_at - a.created_at); },
    async updateProject(id, patch) { const c = projects.get(id); if (!c) return null; Object.assign(c, patch); return c; },
    async deleteProject(id) {
      projects.delete(id);
      for (const [k, u] of users) if (u.project_id === id) users.delete(k);
      for (const [k, r] of records) if (r.project_id === id) records.delete(k);
      for (const [k, f] of files) if (f.project_id === id) files.delete(k);
      return true;
    },
    async countUsers(pid) { return [...users.values()].filter((u) => u.project_id === pid).length; },
    async countRecords(pid) { return [...records.values()].filter((r) => r.project_id === pid).length; },
    async sumFileBytes(pid) { return [...files.values()].filter((f) => f.project_id === pid).reduce((a, f) => a + (f.size || 0), 0); },

    async createUser(u) { users.set(u.id, { role: 'user', meta: {}, created_at: Date.now(), ...u }); return users.get(u.id); },
    async getUser(id) { return users.get(id) || null; },
    async getUserByEmail(pid, email) { return [...users.values()].find((u) => u.project_id === pid && u.email === email) || null; },
    async listUsers(pid, { limit = 100, offset = 0 } = {}) {
      return [...users.values()].filter((u) => u.project_id === pid).sort((a, b) => b.created_at - a.created_at).slice(offset, offset + limit);
    },
    async updateUser(id, patch) { const c = users.get(id); if (!c) return null; Object.assign(c, patch); return c; },
    async deleteUser(id) { users.delete(id); return true; },

    async putRecord(r) {
      const k = rk(r.project_id, r.collection, r.doc_id);
      const ex = records.get(k);
      const now = Date.now();
      const rec = { ...r, created_at: ex ? ex.created_at : now, updated_at: now };
      records.set(k, rec); return rec;
    },
    async getRecord(p, c, d) { return records.get(rk(p, c, d)) || null; },
    async queryRecords(p, c, { ownerId, limit = 100, offset = 0, filters, sort, deleted = false, q } = {}) {
      let arr = [...records.values()].filter((r) => r.project_id === p && r.collection === c && !!r.deleted === !!deleted);
      if (ownerId) arr = arr.filter((r) => r.owner_id === ownerId);
      arr = applyFilters(arr, filters);
      if (q) arr = arr.filter((r) => JSON.stringify(r.data).toLowerCase().includes(String(q).toLowerCase()));
      arr = applySort(arr, sort);
      return arr.slice(offset, offset + limit);
    },
    async countCollection(p, c, { ownerId, filters, deleted = false, q } = {}) {
      let arr = [...records.values()].filter((r) => r.project_id === p && r.collection === c && !!r.deleted === !!deleted);
      if (ownerId) arr = arr.filter((r) => r.owner_id === ownerId);
      arr = applyFilters(arr, filters);
      if (q) arr = arr.filter((r) => JSON.stringify(r.data).toLowerCase().includes(String(q).toLowerCase()));
      return arr.length;
    },
    async deleteRecord(p, c, d, { hard = false } = {}) {
      const k = rk(p, c, d); const rec = records.get(k);
      if (hard) records.delete(k);
      else if (rec) { rec.deleted = 1; rec.updated_at = Date.now(); }
      return true;
    },
    async restoreRecord(p, c, d) { const rec = records.get(rk(p, c, d)); if (rec) { rec.deleted = 0; rec.updated_at = Date.now(); } return rec || null; },
    async listCollections(pid) {
      const m = new Map();
      for (const r of records.values()) if (r.project_id === pid && !r.deleted) m.set(r.collection, (m.get(r.collection) || 0) + 1);
      return [...m].map(([collection, count]) => ({ collection, count }));
    },

    async addHistory(h) { history.push({ seq: ++histSeq, project_id: h.project_id, collection: h.collection, doc_id: h.doc_id, op: h.op, data: h.data ?? null, actor_id: h.actor_id ?? null, created_at: Date.now() }); if (history.length > 100000) history.shift(); },
    async listHistory(pid, c, d, { limit = 100 } = {}) {
      return history.filter((h) => h.project_id === pid && h.collection === c && h.doc_id === d)
        .sort((a, b) => b.seq - a.seq).slice(0, limit)
        .map((h) => ({ version: h.seq, op: h.op, data: h.data, actor_id: h.actor_id, created_at: h.created_at }));
    },
    async getHistoryVersion(pid, c, d, version) {
      const h = history.find((x) => x.seq === Number(version) && x.project_id === pid && x.collection === c && x.doc_id === d);
      return h ? { version: h.seq, op: h.op, data: h.data, created_at: h.created_at } : null;
    },

    async aggregate(pid, c, { field, op = 'count', groupBy, filters } = {}) {
      let arr = [...records.values()].filter((r) => r.project_id === pid && r.collection === c && !r.deleted);
      arr = applyFilters(arr, filters);
      const bucket = (r) => groupBy ? getField(r.data, groupBy) : '__all__';
      const groups = new Map();
      for (const r of arr) {
        const k = bucket(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(field ? Number(getField(r.data, field)) : null);
      }
      const calc = (vals) => {
        const nums = vals.filter((v) => typeof v === 'number' && !isNaN(v));
        if (op === 'count') return vals.length;
        if (!nums.length) return null;
        if (op === 'sum') return nums.reduce((a, b) => a + b, 0);
        if (op === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
        if (op === 'min') return Math.min(...nums);
        if (op === 'max') return Math.max(...nums);
        return null;
      };
      if (!groupBy) return { value: calc(groups.get('__all__') || []) };
      return { groups: [...groups].map(([group, vals]) => ({ group, value: calc(vals) })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)) };
    },

    async sweepOldRecords(pid, c, cutoffMs) {
      let n = 0;
      for (const r of records.values()) if (r.project_id === pid && r.collection === c && !r.deleted && r.updated_at < cutoffMs) { r.deleted = 1; r.updated_at = Date.now(); n++; }
      return n;
    },
    async purgeTrash(pid, cutoffMs) {
      let n = 0;
      for (const [k, r] of records) if (r.project_id === pid && r.deleted && r.updated_at < cutoffMs) { records.delete(k); n++; }
      return n;
    },

    async createFile(f) { files.set(f.id, { created_at: Date.now(), ...f }); return files.get(f.id); },
    async getFile(id) { return files.get(id) || null; },
    async listFiles(pid, { limit = 100, offset = 0 } = {}) {
      return [...files.values()].filter((f) => f.project_id === pid).sort((a, b) => b.created_at - a.created_at).slice(offset, offset + limit);
    },
    async deleteFile(id) { files.delete(id); return true; },

    async addAudit(a) { audit.push({ meta: {}, created_at: Date.now(), ...a }); if (audit.length > 50000) audit.shift(); },
    async listAudit({ projectId, limit = 100, offset = 0 } = {}) {
      let arr = audit; if (projectId) arr = arr.filter((a) => a.project_id === projectId);
      return [...arr].reverse().slice(offset, offset + limit);
    },

    async upsertNode(n) { nodes.set(n.id, { label: '', load: 0, status: 'up', meta: {}, ...nodes.get(n.id), ...n, last_seen: Date.now() }); },
    async listNodes() { return [...nodes.values()].sort((a, b) => b.last_seen - a.last_seen); },
    async removeStaleNodes(maxAgeMs) { const cut = Date.now() - maxAgeMs; for (const [k, v] of nodes) if (v.last_seen < cut) nodes.delete(k); },
    async retentionSweep(days) {
      if (!days) return 0;
      const cut = Date.now() - days * 86400000; let n = 0;
      for (let i = audit.length - 1; i >= 0; i--) if (audit[i].created_at < cut) { audit.splice(i, 1); n++; }
      return n;
    },
    async dumpProject(pid) {
      return {
        users: [...users.values()].filter((u) => u.project_id === pid),
        records: [...records.values()].filter((r) => r.project_id === pid),
        files: [...files.values()].filter((f) => f.project_id === pid),
      };
    },
  };
}
