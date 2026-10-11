// 계 운영 엔진 — igServer에 외부 클라이언트로 접속하는 공정한 심판.
// 정원 충원 감지 → 계 시작, 전원 납입 감지 → 수령자 결정(번호계 순번 / 낙찰계 입찰) → 회차 정산.
// 진행 상태는 엔진이 소유하는 gyestate 문서에만 기록한다(계원이 결과를 조작할 수 없음).
// igClient SDK를 수정 없이 그대로 재사용한다.
//
// 실행: node public/apps/gyemoim/gye-engine.js --key=계모임_프로젝트_키 [--base=http://localhost:8787]
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.WebSocket = globalThis.WebSocket || WebSocket;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkCode = readFileSync(path.join(__dirname, '..', '_sdk', 'igclient.js'), 'utf8');
const _mod = { exports: {} };
new Function('module', 'exports', sdkCode)(_mod, _mod.exports);
const igClient = globalThis.igClient || _mod.exports;

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]; }));
const BASE = args.base || process.env.GYE_BASE || 'http://localhost:8787';
const KEY = args.key || process.env.GYE_KEY;
if (!KEY) { console.error('사용법: node gye-engine.js --key=계모임_프로젝트_키 [--base=URL]'); process.exit(1); }

const ig = igClient(BASE, KEY);
const busy = new Set();           // 처리 중인 계 (동시성 가드)
const settled = new Set();        // 이미 정산한 회차 `gyeId:round`

async function main() {
  const email = 'gye-engine@gyemoim.bot';
  try { await ig.login(email, 'gyeengine123'); } catch { await ig.signup(email, 'gyeengine123', '계운영봇'); }
  console.log(`[계 운영 엔진 시작] ${BASE}`);

  // 정원 충원 / 납입 완료를 실시간 감지
  ig.subscribe('data:memberships', (msg) => { if (msg.data?.gyeId) check(msg.data.gyeId); });
  ig.subscribe('data:payments', (msg) => { if (msg.data?.gyeId) check(msg.data.gyeId); });

  // 시작 시 기존 계 한 번 점검
  const gyes = await ig.list('gyes', { limit: 300 }).catch(() => []);
  for (const g of gyes) check(g.id);
  console.log('[대기 중] 계 진행 상황을 지켜봅니다...');
}

async function check(gyeId) {
  if (busy.has(gyeId)) return;
  busy.add(gyeId);
  try { await process_(gyeId); } catch (e) { console.error('처리 오류:', e.message); } finally { busy.delete(gyeId); }
}

async function process_(gyeId) {
  const g = await ig.get('gyes', gyeId); if (!g) return;
  const cfg = g.data;
  const allMems = (await ig.list('memberships', { limit: 500 })).filter((m) => m.data.gyeId === gyeId).map((m) => ({ id: m.id, ...m.data }));

  let gs = await ig.get('gyestate', gyeId).catch(() => null);
  let state = gs?.data;

  // 1) 정원이 차면 계 시작
  if (!state) {
    if (allMems.length >= cfg.members) {
      state = { gyeId, round: 1, status: 'active', receivedUserIds: [], startedAt: Date.now() };
      await ig.put('gyestate', gyeId, state);
      console.log(`[계 시작] "${cfg.name}" — ${cfg.members}명 정원 충족, 1회차 시작`);
    }
    return;
  }
  if (state.status === 'done') return;

  // 2) 현재 회차 전원 납입 완료 → 정산
  const key = `${gyeId}:${state.round}`;
  if (settled.has(key)) return;
  const pays = (await ig.list('payments', { limit: 1000 })).filter((p) => p.data.gyeId === gyeId && p.data.round === state.round).map((p) => p.data);
  const paidUsers = new Set(pays.map((p) => p.userId));
  if (paidUsers.size < allMems.length) return; // 아직 다 안 냄

  settled.add(key);
  const total = cfg.amount * allMems.length;
  const eligible = allMems.filter((m) => !state.receivedUserIds.includes(m.userId)); // 아직 안 받은 계원

  let winner, bidAmount = 0;
  if (cfg.type === 'auction') {
    const bids = (await ig.list('bids', { limit: 1000 })).filter((b) => b.data.gyeId === gyeId && b.data.round === state.round && eligible.some((e) => e.userId === b.data.userId)).map((b) => b.data);
    if (bids.length) { bids.sort((a, b) => b.bidAmount - a.bidAmount); winner = eligible.find((e) => e.userId === bids[0].userId); bidAmount = bids[0].bidAmount; }
    else winner = eligible.sort((a, b) => a.order - b.order)[0]; // 입찰 없으면 순번
  } else {
    // 번호계: 순번대로 (round번째 순번, 없으면 남은 사람 중 최소)
    winner = eligible.find((e) => e.order === state.round) || eligible.sort((a, b) => a.order - b.order)[0];
  }
  if (!winner) return;

  const payout = total - bidAmount;
  await ig.create('rounds', { gyeId, round: state.round, winnerId: winner.userId, winnerName: winner.name, payout, bidAmount, total, settledAt: Date.now() });
  console.log(`[${state.round}회차 정산] "${cfg.name}" → ${winner.name} 님이 ${payout.toLocaleString()}원 수령${bidAmount ? ` (이자 ${bidAmount.toLocaleString()}원 양보)` : ''}`);

  // 상태 갱신
  const nextReceived = [...state.receivedUserIds, winner.userId];
  if (state.round >= allMems.length) {
    state = { ...state, status: 'done', receivedUserIds: nextReceived, finishedAt: Date.now() };
    console.log(`[계 종료] "${cfg.name}" — 전원 수령 완료`);
  } else {
    state = { ...state, round: state.round + 1, receivedUserIds: nextReceived };
  }
  await ig.put('gyestate', gyeId, state);
}

main().catch((e) => { console.error('엔진 실행 오류:', e); process.exit(1); });
