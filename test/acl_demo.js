// 레코드 단위 공유 권한(ACL) 실동작 검증.
// 사용: node test/acl_demo.js [base]
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
  console.log('=== 레코드 ACL 실동작 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: 'ACL테스트' } })).data.project;
  const key = proj.api_key;

  // 유저 A, B, C
  const A = (await api('POST', '/api/auth/signup', { key, body: { email: `a${Date.now()}@acl.test`, password: 'pw12345', name: 'A' } })).data;
  const B = (await api('POST', '/api/auth/signup', { key, body: { email: `b${Date.now()}@acl.test`, password: 'pw12345', name: 'B' } })).data;
  const C = (await api('POST', '/api/auth/signup', { key, body: { email: `c${Date.now()}@acl.test`, password: 'pw12345', name: 'C' } })).data;
  ok('유저 3명 가입', A.token && B.token && C.token);

  // A가 비공개 문서 생성 (_acl.public=false)
  let r = await api('POST', '/api/data/notes', { key, token: A.token, body: { text: '비밀', _acl: { public: false } } });
  const id = r.data.item.id;
  ok('A가 비공개 문서 생성', r.status === 201);

  // B는 못 읽음
  r = await api('GET', `/api/data/notes/${id}`, { key, token: B.token });
  ok('B는 비공개 문서 조회 거부(403)', r.status === 403, JSON.stringify(r.data));
  // A는 읽음
  r = await api('GET', `/api/data/notes/${id}`, { key, token: A.token });
  ok('소유자 A는 조회 OK', r.status === 200);

  // A가 B에게 읽기 공유
  r = await api('POST', `/api/data/notes/${id}/share`, { key, token: A.token, body: { public: false, readers: [B.user.id] } });
  ok('A가 B에게 읽기 공유', r.status === 200);
  r = await api('GET', `/api/data/notes/${id}`, { key, token: B.token });
  ok('B는 이제 읽기 OK', r.status === 200);
  // B는 쓰기는 불가
  r = await api('PUT', `/api/data/notes/${id}`, { key, token: B.token, body: { text: 'B수정시도' } });
  ok('B는 쓰기 거부(403)', r.status === 403, JSON.stringify(r.data));

  // A가 C에게 쓰기 공유
  await api('POST', `/api/data/notes/${id}/share`, { key, token: A.token, body: { readers: [B.user.id], writers: [C.user.id] } });
  r = await api('PUT', `/api/data/notes/${id}`, { key, token: C.token, body: { text: 'C수정', _acl: { readers: [B.user.id], writers: [C.user.id] } } });
  ok('C는 쓰기 OK', r.status === 200 && r.data.item.data.text === 'C수정', JSON.stringify(r.data).slice(0, 80));

  // C가 ACL을 바꾸려 해도(소유자 아님) 무시됨 — writers에서 자기 안 빠짐
  r = await api('PUT', `/api/data/notes/${id}`, { key, token: C.token, body: { text: 'C재수정', _acl: { public: true, writers: [] } } });
  const afterAcl = r.data.item.data._acl;
  ok('비소유자의 ACL 변경 무시', afterAcl && afterAcl.public !== true && afterAcl.writers.includes(C.user.id), JSON.stringify(afterAcl));

  // B(읽기전용)는 삭제 불가
  r = await api('DELETE', `/api/data/notes/${id}`, { key, token: B.token });
  ok('읽기공유자 B는 삭제 거부(403)', r.status === 403);
  // 소유자 A는 삭제 OK
  r = await api('DELETE', `/api/data/notes/${id}`, { key, token: A.token });
  ok('소유자 A는 삭제 OK', r.status === 200);

  // public=true 문서는 익명(키만)으로도 읽힘
  r = await api('POST', '/api/data/posts', { key, token: A.token, body: { text: '공개글', _acl: { public: true } } });
  const pid = r.data.item.id;
  r = await api('GET', `/api/data/posts/${pid}`, { key }); // 토큰 없음
  ok('public 문서는 익명 조회 OK', r.status === 200);

  // _acl 없는 기존 문서는 공개 읽기 유지 (하위호환)
  r = await api('POST', '/api/data/posts', { key, token: A.token, body: { text: '일반글' } });
  const nid = r.data.item.id;
  r = await api('GET', `/api/data/posts/${nid}`, { key, token: B.token });
  ok('_acl 없는 문서 공개 읽기 유지', r.status === 200);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
