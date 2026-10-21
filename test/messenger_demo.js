// 메신저 실동작 검증: 가입없는 기기 등록·신원복원, DM/그룹 전송, 실시간 수신, 히스토리, 파일첨부, 개인함 알림.
// 사용: node test/messenger_demo.js [base]
import { WebSocket } from 'ws';
const BASE = process.argv[2] || 'http://localhost:8787';
const WSB = BASE.replace('http', 'ws');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, { token, key, body, raw, ct } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = ct || 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const t = (res.headers.get('content-type') || '');
  const d = t.includes('json') ? await res.json() : (t.includes('text') ? await res.text() : Buffer.from(await res.arrayBuffer()));
  return { status: res.status, data: d };
}
function connect(key, token) {
  const ws = new WebSocket(`${WSB}/ws?key=${key}&token=${token}`);
  ws.events = [];
  ws.on('message', (b) => { try { ws.events.push(JSON.parse(b.toString())); } catch {} });
  return new Promise((res) => { ws.on('open', () => res(ws)); ws.on('error', () => res(ws)); });
}
const sub = (ws, room) => ws.send(JSON.stringify({ type: 'subscribe', room }));

async function main() {
  console.log('=== 메신저 (가입 없음) ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '메신저테스트' } })).data.project;
  const key = proj.api_key;

  // 1) 가입 없이 기기 등록 (deviceId 미지정 → 서버 발급)
  let rA = (await api('POST', '/api/messenger/register', { key, body: { name: '내폰' } })).data;
  const B = (await api('POST', '/api/messenger/register', { key, body: { name: '친구PC' } })).data;
  ok('기기 A 가입없이 등록', !!rA.token && !!rA.deviceId && !!rA.user?.id, JSON.stringify(rA));
  ok('기기 B 등록', !!B.token && B.deviceId !== rA.deviceId);

  // 2) 신원 복원: 같은 deviceId로 재등록 → 같은 유저 id
  const rA2 = (await api('POST', '/api/messenger/register', { key, body: { deviceId: rA.deviceId } })).data;
  ok('deviceId로 신원 복원(같은 유저)', rA2.user.id === rA.user.id, `${rA2.user.id} vs ${rA.user.id}`);
  rA = rA2;

  // 3) B가 A와 DM 열기
  const dm = (await api('POST', '/api/messenger/dm', { token: B.token, key, body: { peerDeviceId: rA.deviceId } })).data.room;
  ok('DM 방 생성', dm?.kind === 'dm' && dm.members.length === 2, JSON.stringify(dm));

  // 4) A가 방 구독(실시간) + 개인함 구독, B가 메시지 전송 → A 실시간 수신
  const wsA = await connect(key, rA.token);
  sub(wsA, dm.room);
  sub(wsA, 'u:' + rA.user.id);
  await sleep(300); wsA.events = [];
  await api('POST', '/api/messenger/send', { token: B.token, key, body: { room: dm.room, text: '안녕! 메신저 테스트' } });
  await sleep(400);
  const got = wsA.events.find((e) => e.type === 'message');
  ok('A가 실시간으로 메시지 수신', got?.text === '안녕! 메신저 테스트', JSON.stringify(got));
  ok('A 개인함(inbox) 알림 수신', wsA.events.some((e) => e.type === 'inbox' && e.room === dm.room), JSON.stringify(wsA.events.map((e) => e.type)));

  // 5) 히스토리
  let r = await api('GET', `/api/messenger/history?room=${encodeURIComponent(dm.room)}`, { token: rA.token, key });
  ok('히스토리에 메시지 보임', r.data.messages?.length === 1 && r.data.messages[0].text === '안녕! 메신저 테스트', JSON.stringify(r.data.messages));

  // 6) 파일 첨부 전송: A가 파일 업로드 후 메시지로 전송
  const up = (await api('POST', '/api/files?filename=' + encodeURIComponent('사진.txt'), { token: rA.token, key, raw: Buffer.from('파일내용', 'utf8') })).data.file;
  await api('POST', '/api/messenger/send', { token: rA.token, key, body: { room: dm.room, text: '파일 보냄', file: { id: up.id, name: up.filename, size: up.size, mime: up.mime } } });
  r = await api('GET', `/api/messenger/history?room=${encodeURIComponent(dm.room)}`, { token: rA.token, key });
  const fileMsg = r.data.messages.find((m) => m.file);
  ok('파일 첨부 메시지 저장', fileMsg?.file?.id === up.id && fileMsg.file.name === '사진.txt', JSON.stringify(fileMsg?.file));
  // 첨부 파일 실제 다운로드
  r = await api('GET', `/api/files/${up.id}?key=${key}`, { key });
  ok('첨부 파일 다운로드 내용 일치', r.data.toString?.('utf8') === '파일내용', String(r.data));

  // 7) 그룹 방 생성 + 목록
  const grp = (await api('POST', '/api/messenger/rooms', { token: rA.token, key, body: { title: '우리팀' } })).data.room;
  await api('POST', '/api/messenger/send', { token: rA.token, key, body: { room: grp.room, text: '팀 공지' } });
  r = await api('GET', '/api/messenger/rooms', { token: rA.token, key });
  ok('내 방 목록에 DM+그룹 보임', r.data.rooms?.some((x) => x.room === dm.room) && r.data.rooms?.some((x) => x.room === grp.room), JSON.stringify(r.data.rooms?.map((x) => x.title)));
  ok('방 목록에 마지막 메시지 표시', r.data.rooms.find((x) => x.room === grp.room)?.lastText === '팀 공지');

  // 8) DM 상대 이름 표시(A 입장에서 상대=친구PC)
  ok('DM 제목이 상대 이름', r.data.rooms.find((x) => x.room === dm.room)?.title === '친구PC', JSON.stringify(r.data.rooms.find((x) => x.room === dm.room)));

  wsA.close();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
