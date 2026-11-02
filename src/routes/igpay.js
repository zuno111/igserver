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
  if (!rec) rec = await repo.putRecord({ project_id: PID(req), collection: 'pay_wallet', doc_id: uid, data: { krw: 0, coin: 0 }, owner_id: uid });
  if (rec.data.coin == null) rec.data.coin = 0; // 기존 지갑 호환
  if (rec.data.goldG == null) rec.data.goldG = 0;
  if (rec.data.silverG == null) rec.data.silverG = 0;
  return rec.data;
}
// 금·은 시세(1g당 원). 기본값은 데모용 — 운영에서 실시세로 설정.
const DEFAULT_METAL = { gold: 110000, silver: 1300 };
async function getMetalPrice(req, metal) {
  const rec = await getRepo().getRecord(PID(req), 'pay_meta', 'config');
  const p = rec?.data?.[metal === 'gold' ? 'goldPrice' : 'silverPrice'];
  return (typeof p === 'number' && p > 0) ? p : DEFAULT_METAL[metal];
}
function roundGram(g) { return Math.round((g + Number.EPSILON) * 10000) / 10000; }
function metalField(metal) { return metal === 'gold' ? 'goldG' : 'silverG'; }
// 코인 시세: 1 IGC = N원 (운영 설정). 기본 1000원.
const DEFAULT_COIN_RATE = 1000;
async function getCoinRate(req) {
  const rec = await getRepo().getRecord(PID(req), 'pay_meta', 'config');
  const r = rec?.data?.coinRate;
  return (typeof r === 'number' && r > 0) ? r : DEFAULT_COIN_RATE;
}
function roundCoin(c) { return Math.round((c + Number.EPSILON) * 10000) / 10000; } // 소수 4자리
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
    const cardRate = await getCardCashbackRate(req);
    const cardRec = await getRepo().getRecord(PID(req), 'pay_card', m.uid);
    const card = (cardRec && cardRec.data.status === 'active') ? cardPublic(cardRec.data, cardRate) : null;
    const coinRate = await getCoinRate(req);
    const goldP = await getMetalPrice(req, 'gold'), silverP = await getMetalPrice(req, 'silver');
    const metals = {
      prices: { gold: goldP, silver: silverP },
      gold: { grams: roundGram(w.goldG || 0), valueKrw: Math.floor((w.goldG || 0) * goldP) },
      silver: { grams: roundGram(w.silverG || 0), valueKrw: Math.floor((w.silverG || 0) * silverP) },
    };
    res.json({ ok: true, uid: m.uid, name: m.name, wallet: { krw: w.krw | 0, coin: roundCoin(w.coin || 0) }, savings, card, cardCashbackRate: cardRate, coinRate, metals, tx });
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

// ================= 코인(IGC) 환전 =================
// 원화 지갑으로 코인을 사고(환전) 팔 수 있다. 시세는 운영 설정. 코인으로 가맹 결제 가능.
router.get('/coin', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rate = await getCoinRate(req);
    const w = await getWallet(req, m.uid);
    res.json({ ok: true, rate, coin: roundCoin(w.coin || 0), krw: w.krw | 0, coinValueKrw: Math.floor((w.coin || 0) * rate) });
  } catch (e) { next(e); }
});
// 코인 구매(원화→코인)
router.post('/coin/buy', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const krw = Math.floor(Number((req.body || {}).krw));
    if (!(krw > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < krw) return res.status(402).json({ error: 'insufficient', message: '지갑 잔액이 부족합니다.', balance: w.krw | 0 });
    const rate = await getCoinRate(req);
    const got = roundCoin(krw / rate);
    w.krw -= krw; w.coin = roundCoin((w.coin || 0) + got);
    await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'coin_buy', amount: krw, balance: w.krw, memo: `코인 구매 +${got} IGC` });
    res.json({ ok: true, wallet: { krw: w.krw | 0, coin: w.coin }, bought: got, rate });
  } catch (e) { next(e); }
});
// 코인 판매(코인→원화)
router.post('/coin/sell', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const coin = roundCoin(Number((req.body || {}).coin));
    if (!(coin > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w.coin || 0) < coin) return res.status(402).json({ error: 'insufficient', message: '코인 잔액이 부족합니다.', balance: w.coin || 0 });
    const rate = await getCoinRate(req);
    const krw = Math.floor(coin * rate);
    w.coin = roundCoin((w.coin || 0) - coin); w.krw = (w.krw | 0) + krw;
    await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'coin_sell', amount: krw, balance: w.krw, memo: `코인 판매 -${coin} IGC` });
    res.json({ ok: true, wallet: { krw: w.krw | 0, coin: w.coin }, sold: coin, krw, rate });
  } catch (e) { next(e); }
});

// ================= 금·은 실물 거래 =================
// 원화로 금/은을 그램 단위로 사고 팔고, 보유분을 실물(바/코인)로 인출 신청한다.
const METALS = ['gold', 'silver'];
const METAL_KO = { gold: '금', silver: '은' };
router.get('/metal', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const w = await getWallet(req, m.uid);
    const goldP = await getMetalPrice(req, 'gold'), silverP = await getMetalPrice(req, 'silver');
    res.json({ ok: true, prices: { gold: goldP, silver: silverP },
      holdings: {
        gold: { grams: roundGram(w.goldG || 0), valueKrw: Math.floor((w.goldG || 0) * goldP) },
        silver: { grams: roundGram(w.silverG || 0), valueKrw: Math.floor((w.silverG || 0) * silverP) },
      },
      krw: w.krw | 0 });
  } catch (e) { next(e); }
});
// 매수(원화→금/은)
router.post('/metal/buy', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const metal = METALS.includes(b.metal) ? b.metal : null;
    const krw = Math.floor(Number(b.krw));
    if (!metal) return res.status(400).json({ error: 'bad_metal' });
    if (!(krw > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < krw) return res.status(402).json({ error: 'insufficient', message: '지갑 잔액이 부족합니다.', balance: w.krw | 0 });
    const price = await getMetalPrice(req, metal);
    const grams = roundGram(krw / price);
    w.krw -= krw; w[metalField(metal)] = roundGram((w[metalField(metal)] || 0) + grams);
    await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'metal_buy', amount: krw, balance: w.krw, memo: `${METAL_KO[metal]} 매수 +${grams}g` });
    res.json({ ok: true, metal, bought: grams, price, wallet: { krw: w.krw | 0, grams: w[metalField(metal)] } });
  } catch (e) { next(e); }
});
// 매도(금/은→원화)
router.post('/metal/sell', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const metal = METALS.includes(b.metal) ? b.metal : null;
    const grams = roundGram(Number(b.grams));
    if (!metal) return res.status(400).json({ error: 'bad_metal' });
    if (!(grams > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if ((w[metalField(metal)] || 0) < grams) return res.status(402).json({ error: 'insufficient', message: `${METAL_KO[metal]} 보유량이 부족합니다.`, balance: w[metalField(metal)] || 0 });
    const price = await getMetalPrice(req, metal);
    const krw = Math.floor(grams * price);
    w[metalField(metal)] = roundGram((w[metalField(metal)] || 0) - grams); w.krw = (w.krw | 0) + krw;
    await saveWallet(req, m.uid, w);
    await addTx(req, m.uid, { type: 'metal_sell', amount: krw, balance: w.krw, memo: `${METAL_KO[metal]} 매도 -${grams}g` });
    res.json({ ok: true, metal, sold: grams, krw, price, wallet: { krw: w.krw | 0, grams: w[metalField(metal)] } });
  } catch (e) { next(e); }
});
// 실물 인출 신청(보유 금/은을 실물 배송으로)
router.post('/metal/deliver', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const metal = METALS.includes(b.metal) ? b.metal : null;
    const grams = roundGram(Number(b.grams));
    if (!metal) return res.status(400).json({ error: 'bad_metal' });
    if (!(grams > 0)) return res.status(400).json({ error: 'bad_amount' });
    if (!b.name || !b.phone || !b.address) return res.status(400).json({ error: 'bad_addr', message: '수령인·연락처·주소를 입력하세요.' });
    const w = await getWallet(req, m.uid);
    if ((w[metalField(metal)] || 0) < grams) return res.status(402).json({ error: 'insufficient', message: `${METAL_KO[metal]} 보유량이 부족합니다.`, balance: w[metalField(metal)] || 0 });
    w[metalField(metal)] = roundGram((w[metalField(metal)] || 0) - grams);
    await saveWallet(req, m.uid, w);
    const rec = await getRepo().putRecord({ project_id: PID(req), collection: 'pay_metal_delivery', doc_id: randomId('md_'), data: {
      uid: m.uid, name: m.name, metal, metalKo: METAL_KO[metal], grams,
      recipient: String(b.name).slice(0, 40), phone: String(b.phone).slice(0, 30), address: String(b.address).slice(0, 200),
      status: 'requested', ts: now(),
    }, owner_id: m.uid });
    await addTx(req, m.uid, { type: 'metal_deliver', amount: 0, balance: w.krw, memo: `${METAL_KO[metal]} 실물 인출 신청 ${grams}g` });
    res.json({ ok: true, deliveryId: rec.doc_id, metal, grams, status: 'requested', wallet: { grams: w[metalField(metal)] } });
  } catch (e) { next(e); }
});
// 내 실물 인출 내역
router.get('/metal/deliveries', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rows = await getRepo().queryRecords(PID(req), 'pay_metal_delivery', { ownerId: m.uid, limit: 50, sort: 'created_at:desc' });
    res.json({ ok: true, deliveries: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
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
    const amount = Math.floor(Number(b.amount)); // 결제 금액은 항상 원화 기준
    const merchant = String(b.merchant || '가맹점').slice(0, 40);
    const payBy = b.payBy === 'coin' ? 'coin' : 'krw';
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    const source = b.source ? String(b.source).slice(0, 40) : null;

    // ---- 코인 결제 ----
    if (payBy === 'coin') {
      const rate = await getCoinRate(req);
      const coinNeeded = roundCoin(amount / rate);
      if ((w.coin || 0) < coinNeeded) return res.status(402).json({ error: 'insufficient', message: 'igPay 코인 잔액이 부족합니다.', balance: w.coin || 0, needed: coinNeeded });
      w.coin = roundCoin((w.coin || 0) - coinNeeded);
      await saveWallet(req, m.uid, w);
      const pay = await getRepo().putRecord({ project_id: PID(req), collection: 'pay_payment', doc_id: randomId('pm_'), data: { uid: m.uid, name: m.name, merchant, source, amount, payBy: 'coin', coin: coinNeeded, cashback: 0, memo: b.memo || null, ts: now() }, owner_id: m.uid });
      await addTx(req, m.uid, { type: 'pay', amount, balance: w.krw, counter: merchant, memo: (b.memo || (merchant + ' 결제')) + ` (코인 ${coinNeeded} IGC)` });
      return res.json({ ok: true, paid: amount, merchant, wallet: { krw: w.krw | 0, coin: w.coin }, paymentId: pay.doc_id, cashback: 0, payBy: 'coin', coin: coinNeeded });
    }

    // ---- 원화 결제 ----
    if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: 'igPay 잔액이 부족합니다.', balance: w.krw | 0 });
    w.krw -= amount;
    // 체크카드 보유 시 캐시백 적립(지갑으로 즉시)
    const card = await getRepo().getRecord(PID(req), 'pay_card', m.uid);
    let cashback = 0;
    if (card && card.data.status === 'active') {
      const rate = await getCardCashbackRate(req);
      cashback = Math.floor(amount * rate);
      if (cashback > 0) {
        w.krw += cashback;
        card.data.cashbackTotal = (card.data.cashbackTotal || 0) + cashback;
        await getRepo().putRecord({ project_id: PID(req), collection: 'pay_card', doc_id: m.uid, data: card.data, owner_id: m.uid });
      }
    }
    await saveWallet(req, m.uid, w);
    const pay = await getRepo().putRecord({ project_id: PID(req), collection: 'pay_payment', doc_id: randomId('pm_'), data: { uid: m.uid, name: m.name, merchant, source, amount, payBy: 'krw', cashback, memo: b.memo || null, ts: now() }, owner_id: m.uid });
    await addTx(req, m.uid, { type: 'pay', amount, balance: w.krw, counter: merchant, memo: b.memo || (merchant + ' 결제') });
    if (cashback > 0) await addTx(req, m.uid, { type: 'cashback', amount: cashback, balance: w.krw, counter: merchant, memo: '카드 캐시백' });
    res.json({ ok: true, paid: amount, merchant, wallet: w, paymentId: pay.doc_id, cashback });
  } catch (e) { next(e); }
});

// ================= 체크카드(가상) + 캐시백 =================
// 발급하면 가상 카드번호가 생기고, 이후 가맹 결제 시 캐시백이 지갑으로 적립된다.
const DEFAULT_CASHBACK = 0.005; // 0.5%
async function getCardCashbackRate(req) {
  const rec = await getRepo().getRecord(PID(req), 'pay_meta', 'config');
  const r = rec?.data?.cardCashbackRate;
  return (typeof r === 'number' && r >= 0 && r <= 0.05) ? r : DEFAULT_CASHBACK;
}
function newCardNumber() {
  let n = '';
  const buf = new Uint8Array(16); (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(buf);
  for (let i = 0; i < 16; i++) n += (buf[i] % 10);
  return n; // 16자리
}
function maskCard(n) { return n ? n.slice(0, 4) + ' •••• •••• ' + n.slice(12) : null; }
function cardPublic(d, rate) {
  return { number: maskCard(d.number), status: d.status, cashbackTotal: d.cashbackTotal || 0, cashbackRate: rate, issuedAt: d.issuedAt };
}
// 내 카드 조회
router.get('/card', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rate = await getCardCashbackRate(req);
    const rec = await getRepo().getRecord(PID(req), 'pay_card', m.uid);
    res.json({ ok: true, card: rec && rec.data.status === 'active' ? cardPublic(rec.data, rate) : null, cashbackRate: rate });
  } catch (e) { next(e); }
});
// 발급
router.post('/card/issue', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const repo = getRepo(), pid = PID(req);
    const ex = await repo.getRecord(pid, 'pay_card', m.uid);
    if (ex && ex.data.status === 'active') return res.status(409).json({ error: 'exists', message: '이미 발급된 카드가 있습니다.' });
    const data = { number: newCardNumber(), status: 'active', cashbackTotal: (ex?.data?.cashbackTotal) || 0, issuedAt: now() };
    await repo.putRecord({ project_id: pid, collection: 'pay_card', doc_id: m.uid, data, owner_id: m.uid });
    const rate = await getCardCashbackRate(req);
    res.status(201).json({ ok: true, card: cardPublic(data, rate) });
  } catch (e) { next(e); }
});
// 해지
router.post('/card/close', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rec = await getRepo().getRecord(PID(req), 'pay_card', m.uid);
    if (!rec || rec.data.status !== 'active') return res.status(404).json({ error: 'no_card' });
    rec.data.status = 'closed';
    await getRepo().putRecord({ project_id: PID(req), collection: 'pay_card', doc_id: m.uid, data: rec.data, owner_id: m.uid });
    res.json({ ok: true });
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
// 금·은 시세 설정(1g당 원)
router.post('/admin/metal-price', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = PID(req), b = req.body || {};
    const rec = await repo.getRecord(pid, 'pay_meta', 'config');
    const data = { ...(rec?.data || {}) };
    if (b.gold != null) { const g = Math.floor(Number(b.gold)); if (!(g > 0)) return res.status(400).json({ error: 'bad_gold' }); data.goldPrice = g; }
    if (b.silver != null) { const s = Math.floor(Number(b.silver)); if (!(s > 0)) return res.status(400).json({ error: 'bad_silver' }); data.silverPrice = s; }
    await repo.putRecord({ project_id: pid, collection: 'pay_meta', doc_id: 'config', data, owner_id: null });
    res.json({ ok: true, goldPrice: data.goldPrice || DEFAULT_METAL.gold, silverPrice: data.silverPrice || DEFAULT_METAL.silver });
  } catch (e) { next(e); }
});
// 금·은 실물 인출 신청 목록(운영)
router.get('/admin/metal-deliveries', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(PID(req), 'pay_metal_delivery', { limit: 300, sort: 'created_at:desc' });
    res.json({ ok: true, deliveries: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
// 코인 시세 설정(1 IGC = N원)
router.post('/admin/coin-rate', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = PID(req);
    const rate = Math.floor(Number((req.body || {}).rate));
    if (!(rate > 0 && rate <= 100000000)) return res.status(400).json({ error: 'bad_rate', message: '시세는 1원 이상이어야 합니다.' });
    const rec = await repo.getRecord(pid, 'pay_meta', 'config');
    const data = { ...(rec?.data || {}), coinRate: rate };
    await repo.putRecord({ project_id: pid, collection: 'pay_meta', doc_id: 'config', data, owner_id: null });
    res.json({ ok: true, coinRate: rate });
  } catch (e) { next(e); }
});
// 카드 캐시백율 설정
router.post('/admin/card-cashback', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = PID(req);
    const rate = Number((req.body || {}).rate);
    if (!(rate >= 0 && rate <= 0.05)) return res.status(400).json({ error: 'bad_rate', message: '캐시백율은 0~5% 사이여야 합니다.' });
    const rec = await repo.getRecord(pid, 'pay_meta', 'config');
    const data = { ...(rec?.data || {}), cardCashbackRate: rate };
    await repo.putRecord({ project_id: pid, collection: 'pay_meta', doc_id: 'config', data, owner_id: null });
    res.json({ ok: true, cardCashbackRate: rate });
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
