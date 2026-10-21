// 고도화 검증 2: 실시간 구독 ACL. 비공개(_acl) 레코드 변경은 권한자에게만, 공개는 전체에게.
// 사용: node test/realtime_acl_demo.js [base]
import { WebSocket } from 'ws';
const BASE = process.argv[2] || 'http://localhost:8787';
const WSB = BASE.replace('http', 'ws');
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
function connect(key, token) {
  const ws = new WebSocket(`${WSB}/ws?key=${key}${token ? '&token=' + token : ''}`);
  ws.events = [];
  ws.on('message', (b) => { try { ws.events.push(JSON.parse(b.toString())); } catch {} });
  return new Promise((res) => { ws.on('open', () => res(ws)); ws.on('error', () => res(ws)); });
}
const sub = (ws, room) => ws.send(JSON.stringify({ type: 'subscribe', room }));
const changes = (ws) => ws.events.filter((e) => e.type === 'data_changed');

async function main() {
  console.log('=== 실시간 구독 ACL ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: 'ACL브로드캐스트' } })).data.project;
  const key = proj.api_key;
  const A = (await api('POST', '/api/auth/signup', { key, body: { email: `a${Date.now()}@acl.test`, password: 'pw12345', name: '소유자A' } })).data;
  const C = (await api('POST', '/api/auth/signup', { key, body: { email: `c${Date.now()}@acl.test`, password: 'pw12345', name: '타인C' } })).data;

  // A(소유자)와 C(타인) 둘 다 data:secret 컬렉션 구독
  const wsA = await connect(key, A.token);
  const wsC = await connect(key, C.token);
  sub(wsA, 'data:secret'); sub(wsC, 'data:secret');
  await sleep(300);
  wsA.events = []; wsC.events = [];

  // A가 비공개 레코드 생성 (_acl.public=false)
  await api('POST', '/api/data/secret', { key, token: A.token, body: { memo: '비밀', _acl: { public: false, readers: [], writers: [] } } });
  await sleep(400);
  ok('비공개 생성 → 소유자 A는 수신', changes(wsA).length === 1, 'A=' + changes(wsA).length);
  ok('비공개 생성 → 타인 C는 미수신(유출 차단)', changes(wsC).length === 0, 'C=' + changes(wsC).length);

  // A가 공개 레코드 생성 (_acl 없음 = 공개)
  wsA.events = []; wsC.events = [];
  await api('POST', '/api/data/secret', { key, token: A.token, body: { memo: '공개글' } });
  await sleep(400);
  ok('공개 생성 → 소유자 A 수신', changes(wsA).length === 1, 'A=' + changes(wsA).length);
  ok('공개 생성 → 타인 C도 수신', changes(wsC).length === 1, 'C=' + changes(wsC).length);
  ok('공개 이벤트에 data 포함', changes(wsA)[0]?.data?.memo === '공개글', JSON.stringify(changes(wsA)[0]));

  // C를 readers에 넣은 비공개 레코드 → C도 수신
  wsA.events = []; wsC.events = [];
  await api('POST', '/api/data/secret', { key, token: A.token, body: { memo: 'C공유', _acl: { public: false, readers: [C.user.id], writers: [] } } });
  await sleep(400);
  ok('readers에 포함된 C는 비공개도 수신', changes(wsC).length === 1, 'C=' + changes(wsC).length);

  wsA.close(); wsC.close();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
