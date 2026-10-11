// 딜러 봇 — igServer에 외부 클라이언트로 접속하는 자동 딜러(= AI 딜러의 실동작).
// 새 요청이 올라오면 하한가까지 경쟁적으로 가격을 인하하며 견적을 던진다.
// igClient SDK를 그대로 재사용한다(브라우저와 동일한 코드).
//
// 실행: node public/apps/dealers/dealer-bot.js --key=딜러스_프로젝트_키 [--base=http://localhost:8787]
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node에는 전역 WebSocket/localStorage가 없으므로 주입 (igClient를 수정 없이 재사용하기 위함)
globalThis.WebSocket = globalThis.WebSocket || WebSocket;

// 브라우저용 igclient.js를 수정 없이 그대로 로드 (동일 코드 재사용)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkCode = readFileSync(path.join(__dirname, '..', '_sdk', 'igclient.js'), 'utf8');
const _mod = { exports: {} };
new Function('module', 'exports', sdkCode)(_mod, _mod.exports);
const igClient = globalThis.igClient || _mod.exports;

// ---- 인자 ----
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]; }));
const BASE = args.base || process.env.DEALERS_BASE || 'http://localhost:8787';
const KEY = args.key || process.env.DEALERS_KEY;
if (!KEY) { console.error('사용법: node dealer-bot.js --key=딜러스_프로젝트_키 [--base=URL]'); process.exit(1); }

// ---- 카테고리별 기준 시장가 비율 (예산 대비). 딜러가 깎아줄 수 있는 폭. ----
const CATEGORY_DISCOUNT = { '전자제품': 0.12, '가구': 0.18, '자동차': 0.08, '여행': 0.22, '인테리어': 0.20, '기타': 0.15 };

// ---- 딜러 프로필: 이름, 공격성(하한 마진이 낮을수록 더 깊게 깎음), 응답 속도 ----
const DEALERS = [
  { name: '베스트딜', aggressive: 0.95, speed: 800, msg: '정품 보장, 당일 발송 가능합니다.' },
  { name: '퀵마켓', aggressive: 0.92, speed: 1400, msg: '최저가 도전! 추가 사은품 드려요.' },
  { name: '프로딜러', aggressive: 0.97, speed: 600, msg: '전문 상담 후 최적 조건으로 제안드립니다.' },
  { name: '알뜰상회', aggressive: 0.90, speed: 2000, msg: '마진 최소화, 끝까지 가격으로 승부합니다.' },
];

const seenRequests = new Set();

async function main() {
  // 각 딜러를 독립 계정으로 로그인(없으면 가입)
  const bots = [];
  for (const d of DEALERS) {
    const ig = igClient(BASE, KEY);
    const email = `dealer_${encodeURIComponent(d.name)}@dealers.bot`;
    try { await ig.login(email, 'dealerbot123'); }
    catch { await ig.signup(email, 'dealerbot123', d.name); }
    bots.push({ ...d, ig });
    console.log(`[딜러 로그인] ${d.name}`);
  }

  // 새 요청 감지: 아무 봇의 WS로 requests 컬렉션 변경 구독
  const watcher = bots[0].ig;
  watcher.subscribe('data:requests', (msg) => {
    if (msg.type === 'data_changed' && msg.op === 'create' && msg.id && !seenRequests.has(msg.id)) {
      seenRequests.add(msg.id);
      handleRequest(bots, msg.id, msg.data).catch((e) => console.error('견적 처리 오류:', e.message));
    }
  });
  console.log(`[대기 중] 새 요청을 기다립니다... (서버 ${BASE})`);

  // 봇 시작 전에 이미 올라온 요청도 한 번 처리
  const existing = await watcher.list('requests', { limit: 100 }).catch(() => []);
  for (const r of existing) {
    if (r.data.status === 'open' && !seenRequests.has(r.id)) { seenRequests.add(r.id); handleRequest(bots, r.id, r.data).catch(() => {}); }
  }
}

// 하나의 요청에 대해 모든 딜러가 경쟁 견적 (라운드마다 인하)
async function handleRequest(bots, reqId, reqData) {
  const budget = Number(reqData.budget) || estimateBudget(reqData);
  const discount = CATEGORY_DISCOUNT[reqData.category] ?? 0.15;
  console.log(`[새 요청] "${reqData.title}" (${reqData.category}, 예산 ${budget.toLocaleString()}원) → 딜러 견적 시작`);

  const state = {}; // dealer -> { quoteId, floor, current }
  for (const d of bots) {
    // 각 딜러의 하한가: 예산에서 할인폭만큼 내린 뒤, 공격성으로 추가 조정
    const maxCut = budget * discount;
    const floor = Math.round((budget - maxCut * (1.1 - d.aggressive) * 3) / 1000) * 1000;
    const first = Math.round((budget - maxCut * 0.4 * Math.random()) / 1000) * 1000;
    state[d.name] = { floor: Math.max(floor, Math.round(budget * 0.5)), current: first };
  }

  // 라운드 3회: 최저가보다 살짝 낮게, 단 하한가 밑으로는 안 감
  for (let round = 0; round < 3; round++) {
    for (const d of bots) {
      await sleep(d.speed * (0.5 + Math.random()));
      // 아직 open인지 확인 (수락되면 중단)
      const live = await d.ig.get('requests', reqId).catch(() => null);
      if (!live || live.data.status !== 'open') return;

      const st = state[d.name];
      const others = Object.entries(state).filter(([n]) => n !== d.name).map(([, s]) => s.current);
      const lowestOther = others.length ? Math.min(...others) : st.current;
      if (round > 0) {
        // 경쟁: 최저가보다 1~3% 낮게, 하한가 클램프
        const target = Math.round((lowestOther * (0.97 + Math.random() * 0.02)) / 1000) * 1000;
        st.current = Math.max(st.floor, Math.min(st.current, target));
      }

      const payload = { requestId: reqId, dealer: d.name, price: st.current, message: d.msg, round, ts: Date.now() };
      if (st.quoteId) await d.ig.put('quotes', st.quoteId, payload).catch(() => {});
      else { const q = await d.ig.create('quotes', payload).catch(() => null); if (q) st.quoteId = q.id; }
      console.log(`  ${d.name}: ${st.current.toLocaleString()}원 (라운드 ${round + 1})`);
    }
  }
  console.log(`[완료] "${reqData.title}" 견적 라운드 종료`);
}

function estimateBudget(r) {
  const base = { '전자제품': 1200000, '가구': 500000, '자동차': 20000000, '여행': 800000, '인테리어': 5000000, '기타': 300000 };
  return base[r.category] || 500000;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error('봇 실행 오류:', e); process.exit(1); });
