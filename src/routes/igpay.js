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
    res.json({ ok: true, uid: m.uid, name: m.name, wallet: w, tx });
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
    const pay = await getRepo().putRecord({ project_id: PID(req), collection: 'pay_payment', doc_id: randomId('pm_'), data: { uid: m.uid, name: m.name, merchant, amount, memo: b.memo || null, ts: now() }, owner_id: m.uid });
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
    res.json({ ok: true, stats: {
      members, totalBalance, walletCount: wallets.length,
      charge: agg.charge, transfer: agg.transfer_out, withdraw: agg.withdraw, pay: agg.pay,
      txCount: tx.length,
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

export default router;
