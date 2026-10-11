// 실시간 presence 상세 검증. WS 2명 접속 → 방 presence 이벤트 + REST 조회.
// 사용: node test/presence_demo.js [base]
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
const send = (ws, o) => ws.send(JSON.stringify(o));

async function main() {
  console.log('=== 실시간 presence 상세 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: 'presence테스트' } })).data.project;
  const key = proj.api_key;
  const A = (await api('POST', '/api/auth/signup', { key, body: { email: `a${Date.now()}@p.test`, password: 'pw12345', name: '앨리스' } })).data;
  const B = (await api('POST', '/api/auth/signup', { key, body: { email: `b${Date.now()}@p.test`, password: 'pw12345', name: '밥' } })).data;

  // A 접속 + room1 구독
  const wsA = await connect(key, A.token);
  send(wsA, { type: 'subscribe', room: 'room1' });
  await sleep(400);
  ok('A 구독 응답에 본인 포함', wsA.events.some((e) => e.type === 'subscribed' && e.members?.some((m) => m.name === '앨리스')), JSON.stringify(wsA.events.slice(-1)));

  // B 접속 + room1 구독 → A가 presence 이벤트로 B 입장 감지
  wsA.events = [];
  const wsB = await connect(key, B.token);
  send(wsB, { type: 'subscribe', room: 'room1' });
  await sleep(500);
  const aPres = wsA.events.filter((e) => e.type === 'presence').slice(-1)[0];
  ok('B 입장 시 A에게 presence 이벤트', !!aPres && aPres.members.length === 2, JSON.stringify(aPres));
  ok('명단에 앨리스+밥', aPres && aPres.members.some((m) => m.name === '앨리스') && aPres.members.some((m) => m.name === '밥'));

  // 관리자 presence 조회 → 2명
  let r = await api('GET', `/admin/api/projects/${proj.id}/presence`, { token: adminToken });
  ok('관리자 presence 조회 2명', r.data.online.length === 2, JSON.stringify(r.data.online.map((u) => u.name)));
  ok('접속자 room1 포함', r.data.online.every((u) => u.rooms.includes('room1')));

  // 앱 REST presence
  r = await api('GET', '/api/project/presence', { key });
  ok('앱 REST presence 2명', r.data.online.length === 2);

  // who 질의
  wsB.events = [];
  send(wsB, { type: 'who', room: 'room1' });
  await sleep(300);
  ok('who 질의 응답', wsB.events.some((e) => e.type === 'presence' && e.members.length === 2));

  // B 퇴장 → A가 presence 갱신(1명)
  wsA.events = [];
  wsB.close();
  await sleep(500);
  const aPres2 = wsA.events.filter((e) => e.type === 'presence').slice(-1)[0];
  ok('B 퇴장 시 presence 1명으로 갱신', !!aPres2 && aPres2.members.length === 1, JSON.stringify(aPres2));

  // 관리자 조회도 1명
  r = await api('GET', `/admin/api/projects/${proj.id}/presence`, { token: adminToken });
  ok('퇴장 후 관리자 조회 1명', r.data.online.length === 1, JSON.stringify(r.data.online.map((u) => u.name)));

  wsA.close();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
