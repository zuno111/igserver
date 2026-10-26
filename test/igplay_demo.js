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

  // 레이어룸 커버 이미지(data URL) 저장·반환
  const coverLvl = sampleLevel('커버 포함 레벨');
  coverLvl.cover = 'data:image/jpeg;base64,/9j/TESTCOVER==';
  r = await j('POST', '/api/igplay/levels', { key, token: creator, body: coverLvl });
  ok('커버 이미지 레벨 업로드', r.status === 201 && r.data.level?.cover === coverLvl.cover, JSON.stringify(r.data.level?.cover));

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

  // ===== igMarket (레벨 거래·투자, ISC 공유) =====
  // 판매 매물 등록(크리에이터 자기 레벨)
  r = await j('POST', '/api/igmarket/listings', { key, token: creator, body: { kind: 'level', refId: levelId, title: '테스트 코인러시(판매)', mode: 'sale', price: 50 } });
  ok('마켓 판매 매물 등록', r.status === 201 && r.data.listing?.mode === 'sale' && r.data.listing.price === 50, JSON.stringify(r.data.listing));
  const saleId = r.data.listing?.id;
  // 타인 레벨 등록 거부
  r = await j('POST', '/api/igmarket/listings', { key, token: player, body: { kind: 'level', refId: levelId, title: '탈취', mode: 'sale', price: 10 } });
  ok('타인 레벨 매물 등록 거부(403/409)', r.status === 403 || r.status === 409);
  // 본인 매물 구매 거부
  r = await j('POST', '/api/igmarket/listings/' + saleId + '/buy', { key, token: creator, body: {} });
  ok('본인 매물 구매 거부', r.status === 400);
  // 플레이어가 구매 → 소유권 이전 + 판매자 적립(수수료 5%)
  r = await j('GET', '/api/igplay/wallet', { key, token: creator });
  const sellerBefore = r.data.wallet.balance;
  r = await j('POST', '/api/igmarket/listings/' + saleId + '/buy', { key, token: player, body: {} });
  ok('마켓 구매 성공', r.status === 200, JSON.stringify(r.data));
  r = await j('GET', '/api/igplay/wallet', { key, token: creator });
  ok('판매자 적립(가격-수수료)', r.data.wallet.balance === sellerBefore + Math.round(50 * 0.95), JSON.stringify(r.data.wallet));
  r = await j('GET', '/api/igmarket/listings/' + saleId, { key });
  ok('매물 상태 sold', r.status === 200 && r.data.listing.status === 'sold');
  // 투자 매물 등록 + 투자 (투자자 잔액 범위 내 금액으로)
  r = await j('POST', '/api/igmarket/listings', { key, token: creator, body: { kind: 'project', title: '신작 프로젝트', mode: 'invest', goal: 20 } });
  ok('마켓 투자 매물 등록', r.status === 201 && r.data.listing?.mode === 'invest' && r.data.listing.goal === 20);
  const investId = r.data.listing?.id;
  r = await j('POST', '/api/igmarket/listings/' + investId + '/invest', { key, token: player, body: { amount: 8 } });
  ok('투자 집행(8)', r.status === 200 && r.data.raised === 8 && r.data.status === 'open', JSON.stringify(r.data));
  r = await j('POST', '/api/igmarket/listings/' + investId + '/invest', { key, token: player, body: { amount: 12 } });
  ok('투자 목표 도달 → funded', r.status === 200 && r.data.raised === 20 && r.data.status === 'funded', JSON.stringify(r.data));
  r = await j('GET', '/api/igmarket/myshares', { key, token: player });
  ok('내 지분 조회(누적 20)', r.status === 200 && r.data.shares.some((s) => s.amount === 20));

  // ===== igToken (창작자 커스텀 토큰) =====
  // 잘못된 심볼 거부
  r = await j('POST', '/api/igtoken/tokens', { key, token: creator, body: { symbol: 'isc', name: 'x', priceIsc: 5 } });
  ok('예약어/소문자 심볼 거부', r.status === 400);
  // 토큰 발행
  r = await j('POST', '/api/igtoken/tokens', { key, token: creator, body: { symbol: 'JOON', name: '준호코인', priceIsc: 5, desc: '팬 토큰' } });
  ok('토큰 발행', r.status === 201 && r.data.token?.symbol === 'JOON' && r.data.token.priceIsc === 5, JSON.stringify(r.data.token));
  // 중복 심볼 거부
  r = await j('POST', '/api/igtoken/tokens', { key, token: creator, body: { symbol: 'JOON', name: 'dup', priceIsc: 9 } });
  ok('중복 심볼 거부(409)', r.status === 409);
  // 팬(player)이 토큰 매수 (5 ISC × 3 = 15)
  r = await j('GET', '/api/igplay/wallet', { key, token: player });
  const tbBefore = r.data.wallet.balance;
  r = await j('POST', '/api/igtoken/tokens/JOON/buy', { key, token: player, body: { qty: 3 } });
  ok('토큰 매수(3개)', r.status === 200 && r.data.balance === 3 && r.data.supply === 3, JSON.stringify(r.data));
  r = await j('GET', '/api/igplay/wallet', { key, token: player });
  ok('매수 ISC 차감(15)', r.data.wallet.balance === tbBefore - 15, JSON.stringify(r.data.wallet));
  // 토큰 상세에 내 잔액 반영
  r = await j('GET', '/api/igtoken/tokens/JOON', { key, token: player });
  ok('토큰 보유 잔액 반영', r.status === 200 && r.data.token.myBalance === 3 && r.data.token.holders === 1, JSON.stringify(r.data.token));
  // 내 보유 목록
  r = await j('GET', '/api/igtoken/holdings', { key, token: player });
  ok('내 보유 토큰 목록', r.status === 200 && r.data.holdings.some((h) => h.symbol === 'JOON' && h.amount === 3));
  // 잔액 초과 매수 거부
  r = await j('POST', '/api/igtoken/tokens/JOON/buy', { key, token: player, body: { qty: 100000 } });
  ok('잔액 초과 토큰 매수 거부(402)', r.status === 402);

  // ===== 토큰 게이팅(홀더 전용 레벨) =====
  // 크리에이터가 JOON 3개 이상 홀더 전용 레벨 업로드
  const gated = sampleLevel('홀더 전용 레벨');
  gated.gateSymbol = 'JOON'; gated.gateMin = 3;
  r = await j('POST', '/api/igplay/levels', { key, token: creator, body: gated });
  ok('게이트 레벨 업로드', r.status === 201 && r.data.level?.gateSymbol === 'JOON' && r.data.level.gateMin === 3, JSON.stringify({g:r.data.level?.gateSymbol,m:r.data.level?.gateMin}));
  const gatedId = r.data.level?.id;
  // player는 JOON 3개 보유 → 접근 가능(locked=false, voxels 존재)
  r = await j('GET', '/api/igplay/levels/' + gatedId, { key, token: player });
  ok('홀더(3개 보유) 접근 허용', r.status === 200 && r.data.level.locked === false && r.data.level.voxels.length > 0, JSON.stringify({locked:r.data.level.locked, vox:r.data.level.voxels.length}));
  // 새 유저(미보유)는 잠금
  r = await j('POST', '/api/auth/signup', { key, body: { email: `nohold_${Date.now()}@t.com`, password: 'pw12345', name: '미보유' } });
  const noholder = r.data.token;
  r = await j('GET', '/api/igplay/levels/' + gatedId, { key, token: noholder });
  ok('미보유자 잠금(locked·voxels 숨김)', r.status === 200 && r.data.level.locked === true && r.data.level.voxels.length === 0, JSON.stringify({locked:r.data.level.locked, vox:r.data.level.voxels.length}));
  // 미보유자 플레이 이벤트 차단(403)
  r = await j('POST', '/api/igplay/events', { key, token: noholder, body: { type: 'play', levelId: gatedId } });
  ok('미보유자 플레이 차단(403)', r.status === 403);
  // 제작자 본인은 게이트 무관 접근
  r = await j('GET', '/api/igplay/levels/' + gatedId, { key, token: creator });
  ok('제작자 본인 접근 허용', r.status === 200 && r.data.level.locked === false);

  // 홀더 혜택: 창작자가 게시(최소 보유 5)
  r = await j('POST', '/api/igtoken/tokens/JOON/perks', { key, token: creator, body: { minHold: 5, title: '비밀 레벨 코드', body: 'SECRET-123', kind: 'code' } });
  ok('홀더 혜택 게시', r.status === 201 && r.data.perk?.minHold === 5, JSON.stringify(r.data));
  // 타인은 혜택 게시 불가
  r = await j('POST', '/api/igtoken/tokens/JOON/perks', { key, token: player, body: { minHold: 1, title: 'x', body: 'y' } });
  ok('비창작자 혜택 게시 거부(403)', r.status === 403);
  // player는 3개 보유 → 혜택 잠금(내용 null)
  r = await j('GET', '/api/igtoken/tokens/JOON/perks', { key, token: player });
  ok('보유 부족 시 혜택 잠금', r.status === 200 && r.data.perks[0].unlocked === false && r.data.perks[0].body === null, JSON.stringify(r.data.perks[0]));
  // player가 2개 더 매수 → 5개 → 혜택 해제
  r = await j('POST', '/api/igtoken/tokens/JOON/buy', { key, token: player, body: { qty: 2 } });
  ok('추가 매수(총 5)', r.status === 200 && r.data.balance === 5);
  r = await j('GET', '/api/igtoken/tokens/JOON/perks', { key, token: player });
  ok('보유 충족 시 혜택 해제(내용 노출)', r.status === 200 && r.data.perks[0].unlocked === true && r.data.perks[0].body === 'SECRET-123', JSON.stringify(r.data.perks[0]));
  // 홀더 티어
  r = await j('GET', '/api/igtoken/tokens/JOON/tier', { key, token: player });
  ok('홀더 티어 계산(5개→BRONZE)', r.status === 200 && r.data.tier === 'BRONZE', JSON.stringify(r.data));

  // ===================== igStore 통합 콘텐츠 마켓 =====================
  console.log('--- igStore(통합 콘텐츠 마켓) ---');
  // 1) 무료 이미지 발행 → 플레이어가 받기 → 다운로드
  r = await j('POST', '/api/igstore/catalog', { key, token: creator, body: { kind: 'image', title: '무료 배경 이미지', access: 'free', externalUrl: 'https://example.com/bg.png', tags: ['배경', '무료'] } });
  ok('무료 콘텐츠 발행', r.status === 201 && r.data.item?.kind === 'image' && r.data.item.mine === true, JSON.stringify(r.data));
  const freeId = r.data.item?.id;
  // 지원하지 않는 종류 거부
  r = await j('POST', '/api/igstore/catalog', { key, token: creator, body: { kind: 'nope', title: 'x' } });
  ok('잘못된 종류 발행 거부(400)', r.status === 400);
  // 받기 전 다운로드 차단
  r = await j('GET', '/api/igstore/catalog/' + freeId + '/download', { key, token: player });
  ok('미소유 다운로드 차단(403)', r.status === 403);
  // 무료 받기 → 소유권
  r = await j('POST', '/api/igstore/catalog/' + freeId + '/claim', { key, token: player });
  ok('무료 받기 성공', r.status === 200 && r.data.via === 'free', JSON.stringify(r.data));
  r = await j('GET', '/api/igstore/catalog/' + freeId + '/download', { key, token: player });
  ok('소유 후 다운로드 페이로드 수령', r.status === 200 && r.data.externalUrl === 'https://example.com/bg.png');

  // 2) 유료 3D에셋 발행 → 구매(ISC 결제) → 창작자 적립
  let wc = (await j('GET', '/api/igplay/wallet', { key, token: creator })).data.wallet.balance;
  let wp = (await j('GET', '/api/igplay/wallet', { key, token: player })).data.wallet.balance;
  r = await j('POST', '/api/igstore/catalog', { key, token: creator, body: { kind: 'asset3d', title: '유료 로봇 모델', access: 'paid', price: 20, externalUrl: 'https://example.com/robot.glb' } });
  ok('유료 콘텐츠 발행', r.status === 201 && r.data.item.access === 'paid' && r.data.item.price === 20);
  const paidId = r.data.item.id;
  // 미소유자 목록에서 페이로드 숨김
  r = await j('GET', '/api/igstore/catalog/' + paidId, { key, token: player });
  ok('미소유자에게 페이로드 숨김', r.status === 200 && r.data.item.hasPayload === true && r.data.item.externalUrl === undefined, JSON.stringify(r.data.item));
  // 본인 구매 금지
  r = await j('POST', '/api/igstore/catalog/' + paidId + '/buy', { key, token: creator });
  ok('본인 콘텐츠 구매 금지(400)', r.status === 400);
  // 구매
  r = await j('POST', '/api/igstore/catalog/' + paidId + '/buy', { key, token: player });
  ok('유료 구매 성공', r.status === 200 && r.data.via === 'paid', JSON.stringify(r.data));
  let wp2 = (await j('GET', '/api/igplay/wallet', { key, token: player })).data.wallet.balance;
  let wc2 = (await j('GET', '/api/igplay/wallet', { key, token: creator })).data.wallet.balance;
  ok('구매자 20 ISC 차감', wp2 === wp - 20, `${wp}->${wp2}`);
  ok('창작자 수수료 5% 제외 적립(+19)', wc2 === wc + 19, `${wc}->${wc2}`);
  // 중복 구매 차단
  r = await j('POST', '/api/igstore/catalog/' + paidId + '/buy', { key, token: player });
  ok('중복 구매 차단(409)', r.status === 409);

  // 3) 광고 해제 영상 발행 → 짧은 시청 거부 → 끝까지 시청 후 해제
  r = await j('POST', '/api/igstore/catalog', { key, token: creator, body: { kind: 'video', title: '광고보고 받는 영상', access: 'ad', externalUrl: 'https://example.com/clip.mp4' } });
  const adItemId = r.data.item.id;
  ok('광고 해제 콘텐츠 발행', r.status === 201 && r.data.item.access === 'ad');
  r = await j('POST', '/api/igstore/catalog/' + adItemId + '/adview', { key, token: player, body: { watchedMs: 500 } });
  ok('짧은 광고 시청 거부(400)', r.status === 400);
  r = await j('POST', '/api/igstore/catalog/' + adItemId + '/adview', { key, token: player, body: { watchedMs: 5000 } });
  ok('광고 끝까지 시청 후 해제', r.status === 200 && r.data.via === 'ad');

  // 4) 토큰 홀더 게이팅 발행(JOON 3개 이상) → 보유자 받기 / 미보유자 차단
  r = await j('POST', '/api/igstore/catalog', { key, token: creator, body: { kind: 'doc', title: '홀더 전용 프리셋', access: 'token', gateSymbol: 'JOON', gateMin: 3, externalUrl: 'https://example.com/preset.json' } });
  const tokId = r.data.item.id;
  ok('토큰 게이팅 콘텐츠 발행', r.status === 201 && r.data.item.gateSymbol === 'JOON' && r.data.item.gateMin === 3);
  // player는 JOON 5개 보유 → 획득 성공
  r = await j('POST', '/api/igstore/catalog/' + tokId + '/claim', { key, token: player });
  ok('홀더 획득 성공', r.status === 200 && r.data.via === 'token', JSON.stringify(r.data));
  // noholder는 0개 → 차단
  r = await j('POST', '/api/igstore/catalog/' + tokId + '/claim', { key, token: noholder });
  ok('미보유자 토큰 게이팅 차단(403)', r.status === 403 && r.data.error === 'need_token', JSON.stringify(r.data));

  // 5) 둘러보기(종류 필터·검색)
  r = await j('GET', '/api/igstore/catalog?kind=asset3d', { key });
  ok('종류 필터(asset3d)', r.status === 200 && r.data.items.length >= 1 && r.data.items.every((i) => i.kind === 'asset3d'));
  r = await j('GET', '/api/igstore/catalog?q=' + encodeURIComponent('배경'), { key });
  ok('검색(태그/제목)', r.status === 200 && r.data.items.some((i) => i.id === freeId));

  // 6) 내 라이브러리(획득 + 발행)
  r = await j('GET', '/api/igstore/library', { key, token: player });
  ok('내 라이브러리(획득 4건)', r.status === 200 && r.data.owned.length === 4, JSON.stringify(r.data.owned.map((o) => o.title)));
  r = await j('GET', '/api/igstore/library', { key, token: creator });
  ok('내 발행 목록(4건)', r.status === 200 && r.data.published.length === 4);

  // 6.5) SDK 실제 경로: 파일 업로드 → externalUrl로 발행 → 받기 → 다운로드(=publishFile 흐름)
  {
    const up = await fetch(BASE + '/api/files?filename=model.glb', { method: 'POST', headers: { 'X-Project-Key': key, Authorization: 'Bearer ' + creator, 'Content-Type': 'model/gltf-binary' }, body: Buffer.from('glTF-binary-bytes-demo') });
    const upj = await up.json();
    ok('파일 업로드(SDK upload)', up.status === 201 && !!upj.file?.url, JSON.stringify(upj));
    r = await j('POST', '/api/igstore/catalog', { key, token: creator, body: { kind: 'asset3d', title: '업로드한 모델', access: 'free', externalUrl: upj.file.url } });
    ok('업로드 파일로 발행(publishFile)', r.status === 201 && r.data.item.hasPayload === true);
    const upId = r.data.item.id;
    await j('POST', '/api/igstore/catalog/' + upId + '/claim', { key, token: player });
    r = await j('GET', '/api/igstore/catalog/' + upId + '/download', { key, token: player });
    ok('업로드 파일 다운로드 링크 수령', r.status === 200 && r.data.externalUrl === upj.file.url, JSON.stringify(r.data));
  }

  // 7) igMarket에 카탈로그 콘텐츠 매물 등록 → 거래로 소유권 이전
  r = await j('POST', '/api/igmarket/listings', { key, token: creator, body: { kind: 'asset3d', refId: paidId, title: '로봇 모델 판매', mode: 'sale', price: 5 } });
  ok('카탈로그 콘텐츠 마켓 등록', r.status === 201 && r.data.listing.kind === 'asset3d', JSON.stringify(r.data));
  const mkId = r.data.listing.id;
  r = await j('POST', '/api/igmarket/listings/' + mkId + '/buy', { key, token: player });
  ok('카탈로그 매물 구매(소유권 이전)', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  r = await j('GET', '/api/igstore/catalog/' + paidId, { key, token: player });
  ok('구매 후 카탈로그 소유자=구매자', r.status === 200 && r.data.item.mine === true, JSON.stringify({mine:r.data.item.mine}));

  // ===================== igGame (게임 공용) =====================
  console.log('--- igGame(리더보드·세이브·룸) ---');
  r = await j('POST', '/api/iggame/scores', { key, token: player, body: { game: 'smashearth', score: 1500 } });
  ok('점수 제출(최초=경신)', r.status === 200 && r.data.improved === true && r.data.best === 1500, JSON.stringify(r.data));
  r = await j('POST', '/api/iggame/scores', { key, token: player, body: { game: 'smashearth', score: 900 } });
  ok('낮은 점수는 미경신', r.status === 200 && r.data.improved === false && r.data.best === 1500);
  r = await j('POST', '/api/iggame/scores', { key, token: creator, body: { game: 'smashearth', score: 3000 } });
  ok('타 유저 점수 제출', r.status === 200 && r.data.improved === true);
  r = await j('GET', '/api/iggame/scores/smashearth', { key, token: player });
  ok('리더보드 정렬(1위=3000)', r.status === 200 && r.data.leaderboard[0].score === 3000 && r.data.leaderboard[1].score === 1500 && r.data.me.rank === 2, JSON.stringify({top:r.data.leaderboard[0],me:r.data.me}));
  r = await j('PUT', '/api/iggame/saves/smashearth', { key, token: player, body: { data: { level: 7, hp: 80 }, slot: 0 } });
  ok('클라우드 세이브 저장', r.status === 200 && r.data.ok === true);
  r = await j('GET', '/api/iggame/saves/smashearth?slot=0', { key, token: player });
  ok('세이브 불러오기', r.status === 200 && r.data.save.data.level === 7);
  r = await j('POST', '/api/iggame/rooms', { key, token: creator, body: { game: 'smashearth', title: '같이 부수기', max: 4 } });
  ok('멀티 룸 생성', r.status === 201 && r.data.room.players.length === 1 && r.data.wsRoom === 'game:' + r.data.room.id, JSON.stringify(r.data.wsRoom));
  const roomId = r.data.room.id;
  r = await j('POST', '/api/iggame/rooms/' + roomId + '/join', { key, token: player });
  ok('룸 참가(2명)', r.status === 200 && r.data.room.players.length === 2);
  r = await j('GET', '/api/iggame/rooms?game=smashearth', { key });
  ok('열린 룸 목록', r.status === 200 && r.data.rooms.some((x) => x.id === roomId));
  r = await j('POST', '/api/iggame/rooms/' + roomId + '/leave', { key, token: creator });
  ok('방장 퇴장 시 룸 닫힘', r.status === 200 && r.data.status === 'closed');

  // ===================== igVideo (영상 제작 공용) =====================
  console.log('--- igVideo(프로젝트·렌더잡) ---');
  r = await j('POST', '/api/igvideo/projects', { key, token: creator, body: { title: '컷룸 프로젝트1', tool: 'cutroom', data: { clips: [1, 2, 3] } } });
  ok('영상 프로젝트 저장', r.status === 201 && !!r.data.project.id);
  const vpId = r.data.project.id;
  r = await j('PUT', '/api/igvideo/projects/' + vpId, { key, token: creator, body: { data: { clips: [1, 2, 3, 4] } } });
  ok('프로젝트 수정', r.status === 200);
  r = await j('GET', '/api/igvideo/projects/' + vpId, { key, token: creator });
  ok('프로젝트 불러오기(편집상태)', r.status === 200 && r.data.project.data.clips.length === 4);
  r = await j('GET', '/api/igvideo/projects/' + vpId, { key, token: player });
  ok('타인 프로젝트 접근 차단(404)', r.status === 404);
  r = await j('POST', '/api/igvideo/jobs', { key, token: creator, body: { projectId: vpId, tool: 'cutroom' } });
  ok('렌더 잡 제출(queued)', r.status === 201 && r.data.job.status === 'queued');
  const vjId = r.data.job.id;
  r = await j('POST', '/api/igvideo/jobs/' + vjId + '/status', { key, token: creator, body: { status: 'processing', progress: 50 } });
  ok('잡 진행 보고(processing 50%)', r.status === 200 && r.data.job.status === 'processing' && r.data.job.progress === 50);
  r = await j('POST', '/api/igvideo/jobs/' + vjId + '/status', { key, token: creator, body: { status: 'done', progress: 100, outputFileId: 'f_demo123' } });
  ok('잡 완료(outputFileId 연결)', r.status === 200 && r.data.job.status === 'done' && r.data.job.outputFileId === 'f_demo123');

  // ===================== igSocial (SNS 공용) =====================
  console.log('--- igSocial(피드·팔로우·멀티발행) ---');
  r = await j('POST', '/api/igsocial/posts', { key, token: creator, body: { text: '첫 포스트입니다' } });
  ok('포스트 작성', r.status === 201 && r.data.post.mine === true);
  const poId = r.data.post.id;
  r = await j('POST', '/api/igsocial/posts/' + poId + '/like', { key, token: player });
  ok('좋아요', r.status === 200 && r.data.liked === true && r.data.likes === 1);
  r = await j('POST', '/api/igsocial/posts/' + poId + '/like', { key, token: player });
  ok('좋아요 취소(토글)', r.status === 200 && r.data.liked === false && r.data.likes === 0);
  r = await j('POST', '/api/igsocial/posts/' + poId + '/comments', { key, token: player, body: { text: '멋지네요' } });
  ok('댓글 작성', r.status === 201);
  r = await j('GET', '/api/igsocial/posts/' + poId + '/comments', { key });
  ok('댓글 조회', r.status === 200 && r.data.comments.length === 1 && r.data.comments[0].text === '멋지네요');
  // creator uid 알아내기: 포스트 author
  const creatorUid = (await j('GET', '/api/igsocial/feed', { key })).data.posts.find((p) => p.id === poId).author;
  r = await j('POST', '/api/igsocial/follow/' + creatorUid, { key, token: player });
  ok('팔로우', r.status === 200 && typeof r.data.following === 'boolean', JSON.stringify(r.data));
  r = await j('GET', '/api/igsocial/feed?scope=following', { key, token: player });
  ok('팔로잉 피드(팔로우한 사람 글 포함)', r.status === 200 && r.data.posts.some((p) => p.id === poId), JSON.stringify(r.data.posts.map((p) => p.id)));
  r = await j('POST', '/api/igsocial/publish', { key, token: creator, body: { postId: poId, text: '멀티발행 테스트', platforms: ['instagram', 'x', 'nope'] } });
  ok('멀티발행 예약(유효 플랫폼만)', r.status === 201 && r.data.publish.targets.length === 2 && r.data.publish.targets.every((t) => t.status === 'pending'), JSON.stringify(r.data.publish.targets));
  const spId = r.data.publish.id;
  r = await j('POST', '/api/igsocial/publish/' + spId + '/result', { key, token: creator, body: { platform: 'instagram', status: 'posted', ref: 'ig_abc' } });
  ok('플랫폼 결과 보고(posted)', r.status === 200 && r.data.targets.find((t) => t.platform === 'instagram').status === 'posted');

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
  env: { ...process.env, PORT, HOST: '127.0.0.1', DB_DRIVER: 'memory', NODE_ENV: 'test', RL_AUTH_MAX: '1000', RL_MAX: '5000', PLAN_RATE_MAX: '100000' },
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
