// 계모임 낙찰계 실동작 검증. 서버와 엔진이 이미 떠 있는 상태에서 fetch로 전체 흐름을 돌린다.
// 사용: node test/gye_demo.js <프로젝트키> [base]
const KEY = process.argv[2];
const BASE = process.argv[3] || 'http://localhost:8787';
if (!KEY) { console.error('키 필요'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}) {
  const headers = { 'X-Project-Key': KEY };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((d && d.message) || res.status);
  return d;
}

async function signup(name) {
  const email = `${name}_${Date.now()}@gye.test`;
  const r = await api('POST', '/api/auth/signup', { body: { email, password: 'pw12345', name } });
  return { token: r.token, id: r.user.id, name };
}

async function main() {
  console.log('=== 계모임 낙찰계 실동작 검증 ===');
  // 4명 가입
  const A = await signup('계주김'), B = await signup('이계원'), C = await signup('박계원'), D = await signup('최계원');
  ok('계원 4명 가입', A.id && B.id && C.id && D.id);

  // 계주가 낙찰계 개설 (4명, 월 10만원)
  const gye = (await api('POST', '/api/data/gyes', { token: A.token, body: { name: '우리동네 낙찰계', members: 4, amount: 100000, type: 'auction', inviteCode: 'GYE001', ownerId: A.id, ownerName: A.name, createdAt: Date.now() } })).item;
  await api('POST', '/api/data/memberships', { token: A.token, body: { gyeId: gye.id, userId: A.id, name: A.name, order: 1, joinedAt: Date.now() } });
  ok('낙찰계 개설 + 계주 참여', !!gye.id);

  // B, C, D 참여
  let order = 2;
  for (const u of [B, C, D]) {
    await api('POST', '/api/data/memberships', { token: u.token, body: { gyeId: gye.id, userId: u.id, name: u.name, order: order++, joinedAt: Date.now() } });
  }
  ok('계원 3명 추가 참여 (정원 4 충족)', true);

  // 엔진이 정원 감지 → 계 시작 대기
  let state = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const gs = await api('GET', `/api/data/gyestate/${gye.id}`, { token: A.token }).catch(() => null);
    if (gs && gs.item) { state = gs.item.data; break; }
  }
  ok('엔진이 정원 충족 감지 → 1회차 시작', state && state.status === 'active' && state.round === 1, JSON.stringify(state));

  // 1회차: 4명 전원 납입
  for (const u of [A, B, C, D]) {
    await api('POST', '/api/data/payments', { token: u.token, body: { gyeId: gye.id, round: 1, userId: u.id, name: u.name, amount: 100000, paidAt: Date.now() } });
  }
  ok('1회차 전원 납입', true);

  // 입찰: 이계원이 가장 많이 양보(1만원) → 낙찰 예상
  await api('POST', '/api/data/bids', { token: A.token, body: { gyeId: gye.id, round: 1, userId: A.id, name: A.name, bidAmount: 5000, ts: Date.now() } });
  await api('POST', '/api/data/bids', { token: B.token, body: { gyeId: gye.id, round: 1, userId: B.id, name: B.name, bidAmount: 10000, ts: Date.now() } });
  await api('POST', '/api/data/bids', { token: C.token, body: { gyeId: gye.id, round: 1, userId: C.id, name: C.name, bidAmount: 8000, ts: Date.now() } });
  await api('POST', '/api/data/bids', { token: D.token, body: { gyeId: gye.id, round: 1, userId: D.id, name: D.name, bidAmount: 3000, ts: Date.now() } });
  ok('4명 입찰 (A5천 B1만 C8천 D3천)', true);

  // 엔진 정산 대기
  let round1 = null, state2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const rounds = (await api('GET', '/api/data/rounds', { token: A.token })).items.map((x) => x.data).filter((r) => r.gyeId === gye.id);
    round1 = rounds.find((r) => r.round === 1);
    const gs = await api('GET', `/api/data/gyestate/${gye.id}`, { token: A.token }).catch(() => null);
    state2 = gs?.item?.data;
    if (round1) break;
  }
  ok('엔진 자동 정산 완료', !!round1, JSON.stringify(round1));
  ok('최고 입찰자(이계원) 낙찰', round1 && round1.winnerName === '이계원', round1 && `낙찰=${round1.winnerName}`);
  ok('수령액 = 곗돈 40만 - 양보 1만 = 39만', round1 && round1.payout === 390000, round1 && `payout=${round1.payout}`);
  ok('2회차로 진행', state2 && state2.round === 2, JSON.stringify(state2));
  ok('수령자 기록됨', state2 && state2.receivedUserIds.includes(B.id));

  if (round1) console.log(`\n  → 1회차: ${round1.winnerName} 님이 ${round1.payout.toLocaleString()}원 수령 (이자 ${round1.bidAmount.toLocaleString()}원 양보)`);
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}

main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
