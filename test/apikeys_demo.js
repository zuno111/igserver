// 다중 API 키 + 범위 제한 실동작 검증.
// 사용: node test/apikeys_demo.js [base]
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
async function api(method, path, { token, key, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: d };
}

async function main() {
  console.log('=== 다중 API 키 + 범위 제한 실동작 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '키테스트' } })).data.project;

  // 읽기전용 키 발급
  let r = await api('POST', `/admin/api/projects/${proj.id}/keys`, { token: adminToken, body: { label: '읽기전용', mode: 'read' } });
  ok('읽기전용 키 발급', r.status === 201 && r.data.key.mode === 'read', JSON.stringify(r.data).slice(0, 80));
  const readKey = r.data.key.key;

  // posts 컬렉션만 허용하는 쓰기 키
  r = await api('POST', `/admin/api/projects/${proj.id}/keys`, { token: adminToken, body: { label: 'posts전용', mode: 'write', collections: ['posts'] } });
  ok('컬렉션 제한 키 발급', r.status === 201 && r.data.key.collections[0] === 'posts');
  const postsKey = r.data.key.key;

  // 만료 키 (과거로 만료 못 만드니 0.00001일 ≈ 거의 즉시 → 대신 expiresInDays 음수 테스트는 생략, 발급만)
  r = await api('POST', `/admin/api/projects/${proj.id}/keys`, { token: adminToken, body: { label: '만료키', expiresInDays: 30 } });
  ok('만료 기한 키 발급', r.status === 201 && r.data.key.expiresAt > Date.now());

  // 기본 공개키로 데이터 하나 만들어둠 (읽기 대상)
  const t = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `u${Date.now()}@k.test`, password: 'pw12345', name: 'U' } })).data.token;
  await api('POST', '/api/data/posts', { key: proj.api_key, token: t, body: { title: '글1' } });

  // 읽기전용 키: 읽기 OK
  r = await api('GET', '/api/data/posts', { key: readKey });
  ok('읽기전용 키로 조회 OK', r.status === 200 && r.data.items.length >= 1, JSON.stringify(r.data).slice(0, 80));
  // 읽기전용 키: 쓰기 거부
  r = await api('POST', '/api/data/posts', { key: readKey, body: { title: '막힘' } });
  ok('읽기전용 키로 쓰기 거부 (403)', r.status === 403 && r.data.error === 'read_only_key', JSON.stringify(r.data));

  // 컬렉션 제한 키: posts 쓰기 OK
  r = await api('POST', '/api/data/posts', { key: postsKey, body: { title: 'posts글' } });
  ok('컬렉션 제한 키로 허용 컬렉션 쓰기 OK', r.status === 201, JSON.stringify(r.data).slice(0, 80));
  // 컬렉션 제한 키: 다른 컬렉션 거부
  r = await api('POST', '/api/data/comments', { key: postsKey, body: { text: '막힘' } });
  ok('컬렉션 제한 키로 타 컬렉션 거부 (403)', r.status === 403 && r.data.error === 'collection_not_allowed', JSON.stringify(r.data));
  // 컬렉션 제한 키: 허용 컬렉션 읽기 OK
  r = await api('GET', '/api/data/posts', { key: postsKey });
  ok('컬렉션 제한 키로 허용 컬렉션 읽기 OK', r.status === 200);

  // 키 목록
  r = await api('GET', `/admin/api/projects/${proj.id}/keys`, { token: adminToken });
  ok('키 목록 3개', r.data.keys.length === 3);

  // 키 삭제 → 무효화
  const delId = r.data.keys[0].id;
  const delKeyVal = r.data.keys[0].key;
  await api('DELETE', `/admin/api/projects/${proj.id}/keys/${delId}`, { token: adminToken });
  r = await api('GET', '/api/data/posts', { key: delKeyVal });
  ok('삭제한 키 무효화 (401)', r.status === 401, JSON.stringify(r.data));

  // 기본 공개키·비밀키는 그대로 동작
  r = await api('GET', '/api/data/posts', { key: proj.api_key });
  ok('기본 공개키 정상 유지', r.status === 200);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
