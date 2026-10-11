// 쿼터/플랜 실동작 검증. 한도를 작게 설정하고 초과 거부를 확인.
// 사용: node test/quota_demo.js [base]
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
  console.log('=== 쿼터/플랜 실동작 검증 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '쿼터테스트' } })).data.project;
  ok('기본 플랜 free', proj.plan === 'free');

  // 한도 작게: 레코드 3, 유저 2
  await api('PATCH', `/admin/api/projects/${proj.id}`, { token: adminToken, body: { limits: { maxRecords: 3, maxUsers: 2 } } });
  ok('개별 한도 설정', true);

  // 유저 가입 (2명까지)
  const t1 = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `a${Date.now()}@q.test`, password: 'pw12345', name: 'A' } })).data.token;
  const r2 = await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `b${Date.now()}@q.test`, password: 'pw12345', name: 'B' } });
  ok('유저 2명 가입 성공', !!t1 && !!r2.data.token);
  // 3번째 가입 거부
  const r3 = await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `c${Date.now()}@q.test`, password: 'pw12345', name: 'C' } });
  ok('유저 한도 초과 거부 (402)', r3.status === 402 && r3.data.kind === 'users', JSON.stringify(r3.data));

  // 레코드 3개까지 OK
  for (let i = 0; i < 3; i++) { const r = await api('POST', '/api/data/items', { key: proj.api_key, token: t1, body: { n: i } }); if (r.status !== 201) ok('레코드 생성 실패', false, JSON.stringify(r.data)); }
  ok('레코드 3개 생성 성공', true);
  // 4번째 거부
  const r4 = await api('POST', '/api/data/items', { key: proj.api_key, token: t1, body: { n: 4 } });
  ok('레코드 한도 초과 거부 (402)', r4.status === 402 && r4.data.kind === 'records', JSON.stringify(r4.data));

  // 사용량 조회
  const usage = (await api('GET', '/api/project/usage', { key: proj.api_key })).data;
  ok('사용량 조회', usage.records === 3 && usage.users === 2 && usage.limits.maxRecords === 3, JSON.stringify(usage));
  ok('사용률 계산 (레코드 100%)', usage.pct.records === 100);

  // 플랜 pro로 변경 → 한도 늘어남 (단 개별 limits 오버라이드가 우선이므로 제거)
  await api('PATCH', `/admin/api/projects/${proj.id}`, { token: adminToken, body: { plan: 'pro', limits: {} } });
  const r5 = await api('POST', '/api/data/items', { key: proj.api_key, token: t1, body: { n: 5 } });
  ok('플랜 업그레이드 후 생성 성공', r5.status === 201, JSON.stringify(r5.data));
  const usage2 = (await api('GET', '/api/project/usage', { key: proj.api_key })).data;
  ok('pro 플랜 한도 반영', usage2.plan === 'pro' && usage2.limits.maxRecords === 100000, JSON.stringify(usage2.limits));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
