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
