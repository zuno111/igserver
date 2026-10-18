// igPlay + ISC 모듈 실동작 검증. 메모리 드라이버로 서버를 띄우고 전체 흐름을 fetch로 돌린다.
// 사용: node test/igplay_demo.js   (스스로 서버를 spawn)
import { spawn } from 'node:child_process';

const PORT = process.env.IGPLAY_TEST_PORT || '8799';
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(method, url, { token, key, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['X-Project-Key'] = key;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

async function waitHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await j('GET', '/healthz'); if (r.status === 200 && r.data.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

// 샘플 레벨(지면 8x4 + 코인 3 + 골)
function sampleLevel(title) {
  const vox = [];
  for (let x = 0; x < 8; x++) for (let z = 0; z < 4; z++) vox.push({ x, y: 0, z, t: 1 });
  vox.push({ x: 2, y: 1, z: 1, t: 3 }, { x: 4, y: 1, z: 1, t: 3 }, { x: 6, y: 1, z: 1, t: 3 });
  vox.push({ x: 7, y: 1, z: 2, t: 4 });
  return { title, genre: '수집', difficulty: '보통', voxels: vox, spawn: { x: 0, y: 1, z: 1 }, desc: '테스트 레벨' };
}

async function run() {
  console.log('=== igPlay + ISC 실동작 검증 ===');
  // 관리자 로그인 → 프로젝트 생성
  let r = await j('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } });
  ok('관리자 로그인', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
  const adminToken = r.data.token;
  r = await j('POST', '/admin/api/projects', { token: adminToken, body: { name: 'igPlay 테스트', slug: 'igplay-test' } });
  ok('프로젝트 생성', r.status === 201 && !!r.data.project?.api_key);
  const key = r.data.project.api_key;
  const secretKey = r.data.project.secret_key;

  // 크리에이터 + 플레이어 가입
  r = await j('POST', '/api/auth/signup', { key, body: { email: `creator_${Date.now()}@t.com`, password: 'pw12345', name: '크리에이터' } });
  const creator = r.data.token;
  r = await j('POST', '/api/auth/signup', { key, body: { email: `player_${Date.now()}@t.com`, password: 'pw12345', name: '플레이어' } });
  const player = r.data.token;
  ok('크리에이터·플레이어 가입', !!creator && !!player);

  // 크리에이터가 레벨 업로드
  r = await j('POST', '/api/igplay/levels', { key, token: creator, body: sampleLevel('테스트 코인러시') });
  ok('레벨 업로드', r.status === 201 && !!r.data.level?.id, JSON.stringify(r.data));
  const levelId = r.data.level?.id;

  // 골 없는 레벨 거부
  r = await j('POST', '/api/igplay/levels', { key, token: creator, body: { title: '불량', voxels: [{ x: 0, y: 0, z: 0, t: 1 }] } });
  ok('골 없는 레벨 거부', r.status === 400);

  // 피드 조회
  r = await j('GET', '/api/igplay/levels', { key });
  ok('레벨 피드 조회', r.status === 200 && r.data.levels.some((l) => l.id === levelId));

  // 메시 프롭(webmax OBJ) 포함 레벨 업로드 → 저장·반환 확인
  const propLvl = sampleLevel('프롭 포함 레벨');
  propLvl.props = [{ verts: [[0,0,0],[1,0,0],[0,1,0]], faces: [0,1,2], pos: { x: 3, y: 1, z: 3 }, scale: 1, color: 11583684, size: { w: 1, h: 1, d: 1 }, collide: true }];
  r = await j('POST', '/api/igplay/levels', { key, token: creator, body: propLvl });
  ok('메시 프롭 레벨 업로드', r.status === 201 && Array.isArray(r.data.level?.props) && r.data.level.props.length === 1, JSON.stringify(r.data.level?.props));
  const propId = r.data.level?.id;
  r = await j('GET', '/api/igplay/levels/' + propId, { key });
  ok('프롭 데이터 보존(verts/faces)', r.status === 200 && r.data.level.props[0].faces.length === 3 && r.data.level.props[0].verts.length === 3, JSON.stringify(r.data.level.props[0]));

  // 플레이어 지갑 초기값(120)
  r = await j('GET', '/api/igplay/wallet', { key, token: player });
  ok('지갑 초기 잔액 120', r.status === 200 && r.data.wallet.balance === 120, JSON.stringify(r.data.wallet));
  const start = r.data.wallet.balance;

  // 플레이 이벤트 → +2 적립 + 크리에이터 +3
  r = await j('POST', '/api/igplay/events', { key, token: player, body: { type: 'play', levelId } });
  ok('플레이 적립 +2', r.status === 200 && r.data.wallet.balance === start + 2, JSON.stringify(r.data));
  // 즉시 재플레이 → 쿨다운으로 추가 적립 없음
  r = await j('POST', '/api/igplay/events', { key, token: player, body: { type: 'play', levelId } });
  ok('플레이 쿨다운(추가 적립 없음)', r.status === 200 && r.data.wallet.balance === start + 2, JSON.stringify(r.data.wallet));
  // 크리에이터 지갑에 플레이 적립(+3) 반영
  r = await j('GET', '/api/igplay/wallet', { key, token: creator });
  ok('크리에이터 플레이 적립 +3', r.data.wallet.balance === 120 + 3, JSON.stringify(r.data.wallet));

  // 클리어 이벤트 → clear 15 + 코인비율 보너스 + 첫클리어 40
  r = await j('POST', '/api/igplay/events', { key, token: player, body: { type: 'clear', levelId, coins: 3, total: 3 } });
  const expectClear = 15 + 10 + 40; // ratio 1.0 → +10, 첫클리어 +40
  ok('클리어 적립(15+10+40)', r.status === 200 && r.data.reward === expectClear && r.data.first === true, JSON.stringify(r.data));
  const afterClear = r.data.wallet.balance;

  // 타임 제출 → 랭킹 반영
  await j('POST', '/api/igplay/times', { key, token: player, body: { levelId, ms: 12340 } });
  r = await j('GET', `/api/igplay/ranking/${levelId}`, { key });
  ok('랭킹 반영', r.status === 200 && r.data.ranking.length === 1 && r.data.ranking[0].ms === 12340);

  // 좋아요 → +1 적립, likes 1
  r = await j('POST', '/api/igplay/like', { key, token: player, body: { levelId } });
  ok('좋아요 +1 적립·likes 1', r.status === 200 && r.data.liked === true && r.data.likes === 1);

  // 댓글
  r = await j('POST', '/api/igplay/comments', { key, token: player, body: { levelId, body: '재밌어요' } });
  ok('댓글 등록', r.status === 201 && r.data.comment?.body === '재밌어요');
  r = await j('GET', `/api/igplay/comments/${levelId}`, { key });
  ok('댓글 조회', r.status === 200 && r.data.comments.length === 1);

  // 상점: 스킨 구매(mint 60) → 잔액 -60, 보유
  r = await j('GET', '/api/igplay/wallet', { key, token: player });
  const bal = r.data.wallet.balance;
  r = await j('POST', '/api/igplay/shop/buy', { key, token: player, body: { skinId: 'mint' } });
  ok('스킨 구매(-60)', r.status === 200 && r.data.wallet.balance === bal - 60 && r.data.wallet.skins.includes('mint'), JSON.stringify(r.data.wallet));
  // 중복 구매 거부
  r = await j('POST', '/api/igplay/shop/buy', { key, token: player, body: { skinId: 'mint' } });
  ok('중복 구매 거부', r.status === 409);
  // 잔액 초과 구매 거부(ice 220)
  r = await j('POST', '/api/igplay/shop/buy', { key, token: player, body: { skinId: 'ice' } });
  ok('잔액 초과 구매 거부(402)', r.status === 402, JSON.stringify(r.data));

  // 후원: 플레이어 → 크리에이터 10
  r = await j('GET', '/api/igplay/wallet', { key, token: creator });
  const creatorBefore = r.data.wallet.balance;
  r = await j('POST', '/api/igplay/tip', { key, token: player, body: { levelId, amount: 10 } });
  ok('후원 차감(플레이어)', r.status === 200);
  r = await j('GET', '/api/igplay/wallet', { key, token: creator });
  ok('후원 적립(크리에이터 +10)', r.data.wallet.balance === creatorBefore + 10, JSON.stringify(r.data.wallet));
  // 본인 레벨 후원 거부
  r = await j('POST', '/api/igplay/tip', { key, token: creator, body: { levelId, amount: 10 } });
  ok('본인 레벨 후원 거부', r.status === 400);

  // 부스트: 크리에이터(owner)만, -50, 피드 상위
  r = await j('POST', '/api/igplay/boost', { key, token: creator, body: { levelId } });
  ok('부스트 적용(owner)', r.status === 200 && r.data.boostedUntil > Date.now());
  // 비owner 부스트 거부
  r = await j('POST', '/api/igplay/boost', { key, token: player, body: { levelId } });
  ok('비owner 부스트 거부', r.status === 403);

  // 광고: 하우스애드 목록(기본 셀프프로모션)
  r = await j('GET', '/api/igplay/ads', { key });
  ok('하우스애드 목록', r.status === 200 && Array.isArray(r.data.ads) && r.data.ads.length > 0 && typeof r.data.rewardAmount === 'number');
  // 일반 유저는 광고 등록 불가
  r = await j('POST', '/api/igplay/ads', { key, token: player, body: { title: '해킹광고', body: 'x' } });
  ok('일반 유저 광고 등록 거부(403)', r.status === 403);
  // 서버키(secret)로 커스텀 광고 등록 → 목록 1순위
  r = await j('POST', '/api/igplay/ads', { key: secretKey, body: { title: 'STUDIO ig 신작', body: '지금 플레이', cta: '시작', color: '#ffb02e' } });
  ok('서버키 커스텀 광고 등록', r.status === 201 && !!r.data.ad?.id, JSON.stringify(r.data));
  const adId = r.data.ad?.id;
  r = await j('GET', '/api/igplay/ads', { key });
  ok('커스텀 광고가 목록 1순위', r.status === 200 && r.data.ads[0].title === 'STUDIO ig 신작');
  // 광고 삭제
  r = await j('DELETE', '/api/igplay/ads/' + adId, { key: secretKey });
  ok('광고 삭제', r.status === 200);
  // 보상형: 너무 짧으면 거부
  r = await j('POST', '/api/igplay/ads/reward', { key, token: player, body: { watchedMs: 1000 } });
  ok('짧은 시청 보상 거부(400)', r.status === 400);
  // 보상형: 정상 시청 → ISC 적립
  r = await j('GET', '/api/igplay/wallet', { key, token: player });
  const beforeAd = r.data.wallet.balance;
  r = await j('POST', '/api/igplay/ads/reward', { key, token: player, body: { watchedMs: 5000 } });
  ok('광고 보상 적립(+20)', r.status === 200 && r.data.reward === 20 && r.data.wallet.balance === beforeAd + 20, JSON.stringify(r.data));
  // 보상형: 쿨다운 즉시 재시청 거부(429)
  r = await j('POST', '/api/igplay/ads/reward', { key, token: player, body: { watchedMs: 5000 } });
  ok('광고 보상 쿨다운(429)', r.status === 429, JSON.stringify(r.data));

  // 보안: 제네릭 /api/data 로 ISC 내부 컬렉션 쓰기 차단
  r = await j('POST', '/api/data/_isc_wallet', { key, token: player, body: { balance: 999999 } });
  ok('내부 컬렉션(_isc_wallet) 쓰기 차단(403)', r.status === 403, JSON.stringify(r.data));
  r = await j('GET', '/api/data/_isc_wallet', { key, token: player });
  ok('내부 컬렉션 읽기 차단(403)', r.status === 403);

  // 지갑 잔액이 음수로 떨어지지 않았는지(원장 정합성 최소 확인)
  r = await j('GET', '/api/igplay/wallet', { key, token: player });
  ok('지갑 잔액 비음수·원장 기록', r.data.wallet.balance >= 0 && Array.isArray(r.data.ledger) && r.data.ledger.length > 0, JSON.stringify(r.data.wallet));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  return fail;
}

// --- 서버 spawn ---
const srv = spawn('node', ['src/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT, HOST: '127.0.0.1', DB_DRIVER: 'memory', NODE_ENV: 'test', RL_AUTH_MAX: '1000', RL_MAX: '5000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });

(async () => {
  const up = await waitHealth();
  if (!up) { console.error('서버 기동 실패:\n' + srvLog); srv.kill('SIGKILL'); process.exit(99); }
  let code = 99;
  try { code = await run(); } catch (e) { console.error('실행 오류:', e); code = 98; }
  srv.kill('SIGKILL');
  await sleep(200);
  process.exit(code);
})();
