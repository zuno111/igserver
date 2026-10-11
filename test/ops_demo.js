// 배치 + 전문검색 + 비밀번호 재설정 실동작 검증. 비번 토큰은 웹훅 수신 서버로 받는다.
// 사용: node test/ops_demo.js [base]
import http from 'node:http';
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, { token, key, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: d };
}

async function main() {
  console.log('=== 배치 + 검색 + 비번재설정 실동작 ===');
  const received = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { received.push(JSON.parse(b || '{}')); res.end('ok'); }); });
  await new Promise((r) => server.listen(9811, r));

  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '운영기능테스트' } })).data.project;
  // 비번재설정 웹훅 등록
  await api('POST', `/admin/api/projects/${proj.id}/webhooks`, { token: adminToken, body: { url: 'http://localhost:9811/hook', events: ['auth.password_reset'] } });
  const t = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: 'user@ops.test', password: 'pw12345', name: '유저' } })).data.token;

  // --- 배치 생성 ---
  let r = await api('POST', '/api/data/items/_batch', { key: proj.api_key, token: t, body: { ops: [
    { op: 'create', data: { name: '사과', cat: '과일', price: 1000 } },
    { op: 'create', data: { name: '바나나', cat: '과일', price: 1500 } },
    { op: 'create', data: { name: '당근', cat: '채소', price: 800 } },
    { op: 'create', data: { name: '사과주스', cat: '음료', price: 2500 } },
  ] } });
  ok('배치 생성 4건', r.status === 200 && r.data.ok === 4 && r.data.failed === 0, JSON.stringify(r.data).slice(0, 80));
  const ids = r.data.results.map((x) => x.id);

  // --- 배치 수정 + 삭제 혼합 ---
  r = await api('POST', '/api/data/items/_batch', { key: proj.api_key, token: t, body: { ops: [
    { op: 'update', id: ids[0], data: { name: '사과', cat: '과일', price: 1200 } },
    { op: 'delete', id: ids[2] },
  ] } });
  ok('배치 수정+삭제 혼합', r.status === 200 && r.data.ok === 2);

  // --- 전문 검색 ---
  r = await api('GET', '/api/data/items?q=사과', { key: proj.api_key });
  ok('전문 검색 "사과" (2건: 사과, 사과주스)', r.data.items.length === 2, JSON.stringify(r.data.items.map((x) => x.data.name)));
  r = await api('GET', '/api/data/items?q=과일', { key: proj.api_key });
  ok('검색 "과일" (당근 삭제 후 2건)', r.data.items.length === 2, JSON.stringify(r.data.items.map((x) => x.data.name)));
  // 검색 + 필터 조합
  r = await api('GET', '/api/data/items?q=사과&filter=price:gte:2000', { key: proj.api_key });
  ok('검색+필터 조합 (사과주스만)', r.data.items.length === 1 && r.data.items[0].data.name === '사과주스', JSON.stringify(r.data.items.map((x) => x.data.name)));

  // --- 비밀번호 재설정 ---
  r = await api('POST', '/api/auth/request-reset', { key: proj.api_key, body: { email: 'user@ops.test' } });
  ok('재설정 요청 (항상 200)', r.status === 200);
  // 존재하지 않는 이메일도 200 (노출 방지)
  r = await api('POST', '/api/auth/request-reset', { key: proj.api_key, body: { email: 'nobody@ops.test' } });
  ok('미존재 이메일도 200 (노출 방지)', r.status === 200);

  await sleep(800);
  const resetHook = received.find((x) => x.event === 'auth.password_reset');
  ok('재설정 토큰 웹훅 수신', !!resetHook && !!resetHook.data.token, JSON.stringify(received.map((x) => x.event)));

  if (resetHook) {
    // 토큰으로 새 비번 설정
    r = await api('POST', '/api/auth/reset', { key: proj.api_key, body: { token: resetHook.data.token, newPassword: 'newpass99' } });
    ok('비번 재설정 실행', r.status === 200);
    // 새 비번으로 로그인
    r = await api('POST', '/api/auth/login', { key: proj.api_key, body: { email: 'user@ops.test', password: 'newpass99' } });
    ok('새 비번 로그인 성공', r.status === 200 && !!r.data.token);
    // 옛 비번은 실패
    r = await api('POST', '/api/auth/login', { key: proj.api_key, body: { email: 'user@ops.test', password: 'pw12345' } });
    ok('옛 비번 로그인 거부', r.status === 401);
  }
  // 잘못된 토큰 거부
  r = await api('POST', '/api/auth/reset', { key: proj.api_key, body: { token: 'invalid', newPassword: 'xxxxxx' } });
  ok('잘못된 토큰 거부', r.status === 401);

  server.close();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
