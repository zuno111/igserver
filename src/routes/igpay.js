// igPay — STUDIO ig 자체 핀테크 지갑(X Money형). 송금·충전·출금·거래내역 + 외부 가맹 결제(igGift 등이 igPay로 결제받기).
// igGift P2P 지갑 패턴 재사용. slug=igpay 프로젝트의 독립 유저 풀. 회원 토큰은 라우터 내부 verifyToken으로 식별.
// 저장(project_id=igpay): pay_wallet(doc_id=uid){krw}, pay_tx(거래내역), pay_payment(가맹 결제 기록)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { verifyToken } from '../auth.js';
import { randomId } from '../config.js';

const router = Router();
const now = () => Date.now();
const PID = (req) => req.project.id;

function who(req) {
  if (req.projectAuth === 'secret') return { uid: '__server__', role: 'admin', name: '운영자', admin: true };
  const auth = req.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const p = verifyToken(auth.slice(7));
    if (p && (!p.pid || p.pid === req.project.id)) return { uid: p.uid, role: p.role || 'user', name: p.name || '회원', admin: false };
  }
  return null;
}
function requireMember(req, res) { const m = who(req); if (!m) { res.status(401).json({ error: 'login_required', message: '로그인이 필요합니다.' }); return null; } return m; }
function requireAdmin(req, res) { const m = who(req); if (!m || !m.admin) { res.status(403).json({ error: 'admin_only', message: '운영자(시크릿) 키가 필요합니다.' }); return null; } return m; }

async function getWallet(req, uid) {
  const repo = getRepo();
  let rec = await repo.getRecord(PID(req), 'pay_wallet', uid);
  if (!rec) rec = await repo.putRecord({ project_id: PID(req), collection: 'pay_wallet', doc_id: uid, data: { krw: 0 }, owner_id: uid });
  return rec.data;
}
async function saveWallet(req, uid, data) { await getRepo().putRecord({ project_id: PID(req), collection: 'pay_wallet', doc_id: uid, data, owner_id: uid }); return data; }
async function addTx(req, uid, entry) {
  await getRepo().putRecord({ project_id: PID(req), collection: 'pay_tx', doc_id: randomId('tx_'), data: { uid, ...entry, ts: now() }, owner_id: uid });
}

router.get('/health', (_req, res) => res.json({ ok: true, service: 'igpay', version: '1.0.0' }));

// 내 지갑 + 최근 내역
router.get('/me', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const w = await getWallet(req, m.uid);
    const tx = (await getRepo().queryRecords(PID(req), 'pay_tx', { ownerId: m.uid, limit: 30, sort: 'created_at:desc' })).map((r) => ({ id: r.doc_id, ...r.data }));
    const apr = await getSavingsCfg(req);
    const s = await accrue(req, m.uid, apr);
    const savings = { principal: s.principal | 0, interest: Math.floor(s.accrued || 0), total: (s.principal | 0) + Math.floor(s.accrued || 0), apr };
    res.json({ ok: true, uid: m.uid, name: m.name, wallet: w, savings, tx });
  } catch (e) { next(e); }
});

// 충전(계좌이체 가정 — 데모 즉시 반영)
router.post('/charge', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const amount = Math.floor(Number((req.body || {}).amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount', message: '충전 금액을 확인하세요.' });
    const w = await getWallet(req, m.uid); w.krw = (w.krw | 0) + amount; await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'charge', amount, balance: w.krw, memo: '충전' });
    res.json({ ok: true, wallet: w });
  } catch (e) { next(e); }
});

// 송금(수취인 이메일로)
router.post('/transfer', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const amount = Math.floor(Number(b.amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const repo = getRepo(), pid = PID(req);
    const to = await repo.getUserByEmail(pid, String(b.toEmail || '').trim());
    if (!to) return res.status(404).json({ error: 'no_recipient', message: '수취인을 찾을 수 없습니다. (igPay 가입 이메일)' });
    if (to.id === m.uid) return res.status(400).json({ error: 'self', message: '본인에게는 송금할 수 없습니다.' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: '잔액이 부족합니다.', balance: w.krw | 0 });
    w.krw -= amount; await saveWallet(req, m.uid, w);
    const rw = await getWallet(req, to.id); rw.krw = (rw.krw | 0) + amount; await saveWallet(req, to.id, rw);
    await addTx(req, m.uid, { type: 'transfer_out', amount, balance: w.krw, counter: to.name || to.email, memo: b.memo || '송금' });
    await addTx(req, to.id, { type: 'transfer_in', amount, balance: rw.krw, counter: m.name, memo: b.memo || '송금 수신' });
    res.json({ ok: true, wallet: w });
  } catch (e) { next(e); }
});

// 출금
router.post('/withdraw', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const amount = Math.floor(Number(b.amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: '잔액이 부족합니다.', balance: w.krw | 0 });
    w.krw -= amount; await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'withdraw', amount, balance: w.krw, bank: b.bank || null, memo: '출금' });
    res.json({ ok: true, wallet: w });
  } catch (e) { next(e); }
});

// ================= 예치(이자 붙는 보관) =================
// 지갑에서 예치 계좌로 넣으면 연이율로 일할 이자가 붙는다. 이자는 조회·입출금 시점에 경과일만큼 정산.
// 저장: pay_savings(doc_id=uid) { principal, accrued, lastAt } / 운영 설정: pay_meta.config.savingsApr
const DAY_MS = 86400000;
const DEFAULT_APR = 0.03; // 연 3% 기본
async function getSavingsCfg(req) {
  const rec = await getRepo().getRecord(PID(req), 'pay_meta', 'config');
  const apr = rec?.data?.savingsApr;
  return (typeof apr === 'number' && apr >= 0 && apr <= 0.2) ? apr : DEFAULT_APR;
}
async function getSavings(req, uid) {
  const repo = getRepo();
  let rec = await repo.getRecord(PID(req), 'pay_savings', uid);
  if (!rec) rec = await repo.putRecord({ project_id: PID(req), collection: 'pay_savings', doc_id: uid, data: { principal: 0, accrued: 0, lastAt: now() }, owner_id: uid });
  return rec.data;
}
// 경과 시간만큼 이자를 누적(단리, 원금 기준 일할). 반환 전에 항상 호출.
async function accrue(req, uid, apr) {
  const s = await getSavings(req, uid);
  const t = now();
  const elapsed = Math.max(0, t - (s.lastAt || t));
  if ((s.principal | 0) > 0 && elapsed > 0) {
    const interest = (s.principal) * apr * (elapsed / (365 * DAY_MS));
    s.accrued = (s.accrued || 0) + interest;
  }
  s.lastAt = t;
  await getRepo().putRecord({ project_id: PID(req), collection: 'pay_savings', doc_id: uid, data: s, owner_id: uid });
  return s;
}
// 예치 현황
router.get('/savings', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const apr = await getSavingsCfg(req);
    const s = await accrue(req, m.uid, apr);
    res.json({ ok: true, apr, savings: { principal: s.principal | 0, interest: Math.floor(s.accrued || 0), total: (s.principal | 0) + Math.floor(s.accrued || 0) } });
  } catch (e) { next(e); }
});
// 예치하기(지갑→예치)
router.post('/savings/deposit', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const amount = Math.floor(Number((req.body || {}).amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: '지갑 잔액이 부족합니다.', balance: w.krw | 0 });
    const apr = await getSavingsCfg(req);
    const s = await accrue(req, m.uid, apr);
    w.krw -= amount; await saveWallet(req, m.uid, w);
    s.principal = (s.principal | 0) + amount;
    await getRepo().putRecord({ project_id: PID(req), collection: 'pay_savings', doc_id: m.uid, data: s, owner_id: m.uid });
    await addTx(req, m.uid, { type: 'save_in', amount, balance: w.krw, memo: '예치' });
    res.json({ ok: true, wallet: w, savings: { principal: s.principal | 0, interest: Math.floor(s.accrued || 0) } });
  } catch (e) { next(e); }
});
// 찾기(예치→지갑). 이자부터 차감 후 원금. 전액이면 이자 포함 모두.
router.post('/savings/withdraw', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const apr = await getSavingsCfg(req);
    const s = await accrue(req, m.uid, apr);
    const avail = (s.principal | 0) + Math.floor(s.accrued || 0);
    let amount = b.all ? avail : Math.floor(Number(b.amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    if (amount > avail) return res.status(402).json({ error: 'insufficient', message: '예치 잔액이 부족합니다.', balance: avail });
    // 이자분 먼저 사용
    const interestInt = Math.floor(s.accrued || 0);
    const fromInterest = Math.min(interestInt, amount);
    s.accrued = (s.accrued || 0) - fromInterest;
    const fromPrincipal = amount - fromInterest;
    s.principal = (s.principal | 0) - fromPrincipal;
    await getRepo().putRecord({ project_id: PID(req), collection: 'pay_savings', doc_id: m.uid, data: s, owner_id: m.uid });
    const w = await getWallet(req, m.uid); w.krw = (w.krw | 0) + amount; await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'save_out', amount, balance: w.krw, memo: '예치 찾기' + (fromInterest ? ` (이자 ${fromInterest.toLocaleString()}원 포함)` : '') });
    res.json({ ok: true, wallet: w, savings: { principal: s.principal | 0, interest: Math.floor(s.accrued || 0) } });
  } catch (e) { next(e); }
});

// 거래 내역
router.get('/tx', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const tx = (await getRepo().queryRecords(PID(req), 'pay_tx', { ownerId: m.uid, limit: 100, sort: 'created_at:desc' })).map((r) => ({ id: r.doc_id, ...r.data }));
    res.json({ ok: true, tx });
  } catch (e) { next(e); }
});

// 가맹 결제: 외부 서비스(igGift 등)가 igPay로 결제받기 — 회원이 igPay 잔액에서 결제
// POST /pay { amount, merchant, memo }
router.post('/pay', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const amount = Math.floor(Number(b.amount));
    const merchant = String(b.merchant || '가맹점').slice(0, 40);
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: 'igPay 잔액이 부족합니다.', balance: w.krw | 0 });
    w.krw -= amount; await saveWallet(req, m.uid, w);
    const source = b.source ? String(b.source).slice(0, 40) : null;
    const pay = await getRepo().putRecord({ project_id: PID(req), collection: 'pay_payment', doc_id: randomId('pm_'), data: { uid: m.uid, name: m.name, merchant, source, amount, memo: b.memo || null, ts: now() }, owner_id: m.uid });
    await addTx(req, m.uid, { type: 'pay', amount, balance: w.krw, counter: merchant, memo: b.memo || (merchant + ' 결제') });
    res.json({ ok: true, paid: amount, merchant, wallet: w, paymentId: pay.doc_id });
  } catch (e) { next(e); }
});

// ================= 운영자: 통계·내역 =================
router.get('/admin/stats', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = PID(req);
    const members = await repo.countUsers(pid);
    const wallets = await repo.queryRecords(pid, 'pay_wallet', { limit: 100000, sort: 'created_at:desc' });
    const totalBalance = wallets.reduce((a, w) => a + ((w.data.krw | 0)), 0);
    const tx = await repo.queryRecords(pid, 'pay_tx', { limit: 100000, sort: 'created_at:desc' });
    const agg = { charge: { cnt: 0, sum: 0 }, transfer_out: { cnt: 0, sum: 0 }, withdraw: { cnt: 0, sum: 0 }, pay: { cnt: 0, sum: 0 } };
    for (const t of tx) { const k = t.data.type; if (agg[k]) { agg[k].cnt++; agg[k].sum += (t.data.amount | 0); } }
    // 가맹 결제 출처(앱)별 집계
    const payments = await repo.queryRecords(pid, 'pay_payment', { limit: 100000, sort: 'created_at:desc' });
    const bySourceMap = {};
    for (const p of payments) { const s = p.data.source || p.data.merchant || '기타'; if (!bySourceMap[s]) bySourceMap[s] = { source: s, cnt: 0, sum: 0 }; bySourceMap[s].cnt++; bySourceMap[s].sum += (p.data.amount | 0); }
    const bySource = Object.values(bySourceMap).sort((a, b) => b.sum - a.sum);
    // 예치 총액 + 적용 연이율
    const savings = await repo.queryRecords(pid, 'pay_savings', { limit: 100000, sort: 'created_at:desc' });
    const savingsTotal = savings.reduce((a, s) => a + ((s.data.principal | 0) + Math.floor(s.data.accrued || 0)), 0);
    const savingsApr = await getSavingsCfg(req);
    res.json({ ok: true, stats: {
      members, totalBalance, walletCount: wallets.length,
      charge: agg.charge, transfer: agg.transfer_out, withdraw: agg.withdraw, pay: agg.pay,
      txCount: tx.length, bySource, savingsTotal, savingsApr,
    } });
  } catch (e) { next(e); }
});
router.get('/admin/tx', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const limit = Math.min(500, parseInt(req.query.limit || '200', 10));
    const rows = await getRepo().queryRecords(PID(req), 'pay_tx', { limit, sort: 'created_at:desc' });
    res.json({ ok: true, tx: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.get('/admin/payments', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(PID(req), 'pay_payment', { limit: 300, sort: 'created_at:desc' });
    res.json({ ok: true, payments: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
// 예치 연이율 설정
router.post('/admin/savings-apr', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = PID(req);
    const apr = Number((req.body || {}).apr);
    if (!(apr >= 0 && apr <= 0.2)) return res.status(400).json({ error: 'bad_apr', message: '연이율은 0~20% 사이여야 합니다.' });
    const rec = await repo.getRecord(pid, 'pay_meta', 'config');
    const data = { ...(rec?.data || {}), savingsApr: apr };
    await repo.putRecord({ project_id: pid, collection: 'pay_meta', doc_id: 'config', data, owner_id: null });
    res.json({ ok: true, savingsApr: apr });
  } catch (e) { next(e); }
});

export default router;
