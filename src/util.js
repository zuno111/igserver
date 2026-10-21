// 공용 유틸. 점(.) 경로 접근/설정 + 원자적 증감 적용.
// 드라이버(incRecord)와 라우트(inc API)에서 공통으로 쓴다.

export function getField(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setField(obj, path, val) {
  const ks = String(path).split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (typeof o[ks[i]] !== 'object' || o[ks[i]] == null) o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
  return obj;
}

// incs = { field: delta, ... }  (점 경로 지원). 숫자가 아니면 0에서 시작.
export function applyIncs(data, incs) {
  const out = data && typeof data === 'object' ? data : {};
  for (const [f, d] of Object.entries(incs || {})) {
    const cur = Number(getField(out, f));
    const base = Number.isFinite(cur) ? cur : 0;
    setField(out, f, base + Number(d));
  }
  return out;
}

// 필터/정렬 정규화: 호출부가 객체형({field,op,value}/{field,dir})이든
// 축약형(배열 ['f','op','v'], 문자열 'field:dir')이든 드라이버가 모두 받게 통일한다.
//   filters: [['kind','eq','x']] 또는 [{field:'kind',op:'eq',value:'x'}]
//   sort:    'created_at:desc' 또는 {field:'created_at',dir:'desc'}
export function normalizeFilters(filters) {
  if (!filters) return undefined;
  const arr = Array.isArray(filters) ? filters : [filters];
  const out = [];
  for (const f of arr) {
    if (Array.isArray(f)) { if (f[0]) out.push({ field: f[0], op: f[1] || 'eq', value: f[2] }); }
    else if (f && typeof f === 'object' && f.field) out.push({ field: f.field, op: f.op || 'eq', value: f.value });
  }
  return out;
}
export function normalizeSort(sort) {
  if (!sort) return undefined;
  if (typeof sort === 'string') { const [field, dir] = sort.split(':'); return field ? { field, dir: dir === 'asc' ? 'asc' : 'desc' } : undefined; }
  if (typeof sort === 'object' && sort.field) return { field: sort.field, dir: sort.dir === 'asc' ? 'asc' : 'desc' };
  return undefined;
}

// inc 입력 정규화: {field,by} 또는 {fields:{...}} 또는 {inc:{...}} → {field:delta}
const OK_FIELD = /^[A-Za-z0-9_.]{1,64}$/;
export function normalizeIncs(body) {
  let raw = null;
  if (body && typeof body.fields === 'object' && body.fields) raw = body.fields;
  else if (body && typeof body.inc === 'object' && body.inc) raw = body.inc;
  else if (body && typeof body.field === 'string') raw = { [body.field]: body.by ?? 1 };
  if (!raw) return { error: '증감할 field 또는 fields가 필요합니다.' };
  const incs = {};
  for (const [f, d] of Object.entries(raw)) {
    if (!OK_FIELD.test(f)) return { error: `잘못된 필드명: ${f}` };
    const n = Number(d);
    if (!Number.isFinite(n)) return { error: `${f} 증감값이 숫자가 아닙니다.` };
    incs[f] = n;
  }
  if (!Object.keys(incs).length) return { error: '증감할 필드가 없습니다.' };
  return { incs };
}
