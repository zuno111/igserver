// 다중 관리자 + 역할(RBAC) 실동작 검증.
// 사용: node test/rbac_demo.js [base]
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
async function api(method, path, { token, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: d };
}
async function login(email, password) { return (await api('POST', '/admin/api/login', { body: { email, password } })).data; }

async function main() {
  console.log('=== 다중 관리자 + RBAC 실동작 ===');
  // owner 로그인 (기본 계정)
  const owner = await login('admin@studio-ig.local', 'admin1234');
  ok('owner 로그인 (역할 owner)', owner.role === 'owner', JSON.stringify(owner).slice(0, 60));

  // 관리자 추가: admin 1명, viewer 1명
  let r = await api('POST', '/admin/api/admins', { token: owner.token, body: { email: 'manager@ig.local', password: 'manager12', role: 'admin' } });
  ok('owner가 admin 추가', r.status === 201 && r.data.admin.role === 'admin', JSON.stringify(r.data));
  r = await api('POST', '/admin/api/admins', { token: owner.token, body: { email: 'viewer@ig.local', password: 'viewer12', role: 'viewer' } });
  ok('owner가 viewer 추가', r.status === 201);

  // admin 로그인 → 프로젝트 생성 가능
  const admin = await login('manager@ig.local', 'manager12');
  ok('admin 로그인', admin.role === 'admin');
  r = await api('POST', '/admin/api/projects', { token: admin.token, body: { name: 'admin이만든프로젝트' } });
  ok('admin이 프로젝트 생성 가능', r.status === 201, JSON.stringify(r.data));
  // admin은 관리자 추가 불가 (owner 전용)
  r = await api('POST', '/admin/api/admins', { token: admin.token, body: { email: 'x@ig.local', password: 'xxxxxxxx', role: 'admin' } });
  ok('admin은 관리자 추가 거부 (403)', r.status === 403, JSON.stringify(r.data));
  // admin은 관리자 목록 조회는 가능
  r = await api('GET', '/admin/api/admins', { token: admin.token });
  ok('admin은 관리자 목록 조회 가능', r.status === 200 && r.data.admins.length === 3);

  // viewer 로그인 → 조회만 가능
  const viewer = await login('viewer@ig.local', 'viewer12');
  ok('viewer 로그인', viewer.role === 'viewer');
  r = await api('GET', '/admin/api/overview', { token: viewer.token });
  ok('viewer는 overview 조회 가능', r.status === 200);
  r = await api('POST', '/admin/api/projects', { token: viewer.token, body: { name: 'viewer시도' } });
  ok('viewer는 프로젝트 생성 거부 (403)', r.status === 403, JSON.stringify(r.data));
  r = await api('GET', '/admin/api/admins', { token: viewer.token });
  ok('viewer는 관리자 목록 조회 거부 (admin 이상)', r.status === 403);

  // 마지막 owner 보호
  const admins = (await api('GET', '/admin/api/admins', { token: owner.token })).data.admins;
  const ownerId = admins.find((a) => a.role === 'owner').id;
  r = await api('DELETE', `/admin/api/admins/${ownerId}`, { token: owner.token });
  ok('마지막 owner 삭제 방지', r.status === 400 && r.data.error === 'last_owner', JSON.stringify(r.data));

  // viewer를 admin으로 승격
  const viewerId = admins.find((a) => a.role === 'viewer').id;
  r = await api('PATCH', `/admin/api/admins/${viewerId}`, { token: owner.token, body: { role: 'admin' } });
  ok('owner가 viewer→admin 승격', r.status === 200 && r.data.role === 'admin');
  const v2 = await login('viewer@ig.local', 'viewer12');
  r = await api('POST', '/admin/api/projects', { token: v2.token, body: { name: '승격후생성' } });
  ok('승격 후 프로젝트 생성 가능', r.status === 201);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
