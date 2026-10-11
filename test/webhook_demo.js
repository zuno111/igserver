// 웹훅 실동작 검증. 수신 서버를 띄우고, igServer에 웹훅 등록 후 데이터 변경 → 수신+서명 확인.
// 사용: node test/webhook_demo.js [base]
import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const received = [];
const RECV_PORT = 9899;

async function api(method, path, { token, key, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((d && d.message) || res.status);
  return d;
}

async function main() {
  console.log('=== 웹훅 실동작 검증 ===');
  // 수신 서버
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); });
  });
  await new Promise((r) => server.listen(RECV_PORT, r));
  ok('수신 서버 기동', true);

  // 관리자 로그인 → 프로젝트 생성
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '웹훅테스트' } })).project;
  ok('프로젝트 생성', !!proj.api_key);

  // 웹훅 등록 (data.create 이벤트)
  const hook = (await api('POST', `/admin/api/projects/${proj.id}/webhooks`, { token: adminToken, body: { url: `http://localhost:${RECV_PORT}/hook`, events: ['data.create'] } })).webhook;
  ok('웹훅 등록 (서명 시크릿 발급)', !!hook.id && hook.secret.startsWith('whsec_'));

  // 유저 가입 → 데이터 생성 (웹훅 트리거)
  const userToken = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `u${Date.now()}@wh.test`, password: 'pw12345', name: '사용자' } })).token;
  await api('POST', '/api/data/orders', { key: proj.api_key, token: userToken, body: { product: '커피', price: 4500 } });
  ok('데이터 생성 (웹훅 트리거)', true);

  // 수신 대기
  for (let i = 0; i < 20 && !received.length; i++) await sleep(300);
  ok('웹훅 수신됨', received.length >= 1, `수신 ${received.length}건`);

  if (received.length) {
    const r = received[0];
    const payload = JSON.parse(r.body);
    ok('이벤트 타입 data.create', payload.event === 'data.create' && payload.data.collection === 'orders', JSON.stringify(payload).slice(0, 100));
    ok('페이로드에 데이터 포함', payload.data.data.product === '커피');
    // 서명 검증
    const expected = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(r.body).digest('hex');
    ok('HMAC 서명 유효', r.headers['x-ig-signature'] === expected);
  }

  // 삭제 이벤트는 등록 안 했으니 수신 안 됨 확인
  const before = received.length;
  const o2 = (await api('POST', '/api/data/orders', { key: proj.api_key, token: userToken, body: { product: '차', price: 3000 } }));
  await sleep(1000);
  ok('등록 이벤트만 수신 (create 추가 1건)', received.length === before + 1, `before=${before} now=${received.length}`);

  server.close();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}

main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
