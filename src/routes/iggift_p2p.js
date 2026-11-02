// igGift P2P 거래소 — 회원끼리 상품권을 사고파는 P2P 매칭 + 본사 봇 자동매매 + 입금문자 파싱 + 지갑(충전/환전) + QR결제 + 이상거래 탐지.
// igGift(기프트카드 인프라)와 같은 프로젝트(slug=iggift) 유저 풀을 공유한다. 회원 토큰은 라우터 내부에서 verifyToken으로 식별.
// 저장 컬렉션(project_id=iggift):
//   p2p_wallet(doc_id=uid)   : { krw, locked }                 — 회원 원화 지갑
//   p2p_order(doc_id=ord_*)  : 주문(구매/판매). status open→matched→funded→completed/cancelled
//   p2p_trade(doc_id=trd_*)  : 매칭된 거래 1건(원장 포함)
//   p2p_deposit(doc_id=dep_*): 입금문자 파싱 기록
//   p2p_merchant(doc_id)     : QR 가맹점
//   p2p_payment(doc_id=pay_*): QR결제 기록
//   p2p_flag(doc_id=flg_*)   : 이상거래 플래그
//   _p2p_ledger              : 전역 거래원장(append-only)
//   p2p_meta(doc_id=config)  : 운영 설정(수수료율, 봇 on/off 등)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { verifyToken } from '../auth.js';
import { randomId } from '../config.js';

const router = Router();

// ---- 회원 식별 ----
// 공개키 호출이라 resolveProject로 req.project는 있지만 req.user는 없음.
// Authorization: Bearer <회원토큰> 을 직접 파싱해 회원을 식별한다. 시크릿키면 운영자.
function who(req) {
  if (req.projectAuth === 'secret') return { uid: '__server__', role: 'admin', name: '운영자', admin: true };
  const auth = req.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const p = verifyToken(auth.slice(7));
    if (p && (!p.pid || p.pid === req.project.id)) return { uid: p.uid, role: p.role || 'user', name: p.name || '회원', admin: false };
  }
  return null;
}
function requireMember(req, res) {
  const m = who(req);
  if (!m) { res.status(401).json({ error: 'login_required', message: '로그인이 필요합니다.' }); return null; }
  return m;
}
function requireAdmin(req, res) {
  const m = who(req);
  if (!m || !m.admin) { res.status(403).json({ error: 'admin_only', message: '운영자(시크릿) 키가 필요합니다.' }); return null; }
  return m;
}

const PID = (req) => req.project.id;
const now = () => Date.now();

// ---- 운영 설정 ----
const DEFAULT_CFG = {
  feeRate: 0.01, botEnabled: true, botName: 'P2P 자동봇', minAmount: 1000, maxAmount: 10000000,
  // 결제수단별 설정. live=true + 키가 있으면 실 API, 아니면 내장 샌드박스로 전 플로우 실동작.
  providers: {
    wallet:   { label: '계좌이체', enabled: true,  live: false },
    kakaopay: { label: '카카오페이', enabled: true, live: false, cid: '', secretKey: '' },
    naverpay: { label: '네이버페이', enabled: true, live: false, clientId: '', clientSecret: '', chainId: '' },
    paypal:   { label: 'PayPal', enabled: true,    live: false, clientId: '', clientSecret: '', env: 'sandbox' },
    global:   { label: '글로벌페이', enabled: true, live: false },
  },
};
async function getCfg(req) {
  const rec = await getRepo().getRecord(PID(req), 'p2p_meta', 'config');
  return { ...DEFAULT_CFG, ...(rec?.data || {}) };
}
async function setCfg(req, patch) {
  const cur = await getCfg(req);
  const data = { ...cur, ...patch };
  await getRepo().putRecord({ project_id: PID(req), collection: 'p2p_meta', doc_id: 'config', data, owner_id: null });
  return data;
}

// ---- 지갑 ----
async function getWallet(req, uid) {
  const repo = getRepo();
  let rec = await repo.getRecord(PID(req), 'p2p_wallet', uid);
  if (!rec) rec = await repo.putRecord({ project_id: PID(req), collection: 'p2p_wallet', doc_id: uid, data: { krw: 0, locked: 0 }, owner_id: uid });
  return rec.data;
}
async function saveWallet(req, uid, data) {
  await getRepo().putRecord({ project_id: PID(req), collection: 'p2p_wallet', doc_id: uid, data, owner_id: uid });
  return data;
}
async function ledger(req, entry) {
  await getRepo().putRecord({ project_id: PID(req), collection: '_p2p_ledger', doc_id: randomId('pl_'), data: { ...entry, ts: now() }, owner_id: null });
}

// ---- 상품권 발급(기프트카드 인프라 재사용) ----
// P2P 거래 성사 시 구매자 지갑으로 실제 기프트카드를 발급한다(gift_cards 컬렉션 = igGift와 동일).
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function rnd(n) { let o = ''; const buf = new Uint8Array(n); (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(buf); for (let i = 0; i < n; i++) o += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length]; return o; }
function newCardCode() { return [rnd(4), rnd(4), rnd(4), rnd(4)].join('-').replace(/-/g, ''); }
async function issueCardTo(req, ownerUid, amount, currency = 'KRW', memo = 'P2P 거래') {
  const repo = getRepo(), pid = PID(req);
  let code = newCardCode();
  for (let t = 0; t < 5 && await repo.getRecord(pid, 'gift_cards', code); t++) code = newCardCode();
  const data = { status: 'active', balance: amount, initial: amount, currency, recipient: null, memo, owner_uid: ownerUid, source: 'p2p' };
  await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: code, data, owner_id: ownerUid });
  await repo.putRecord({ project_id: pid, collection: '_gift_ledger', doc_id: randomId('gl_'), data: { type: 'issue', code, amount, currency, src: 'p2p', ts: now() }, owner_id: null });
  return code;
}

// ---- 이상거래 탐지 ----
// 최근 2분 내 동일 회원의 거래 건수/합계가 임계치를 넘으면 플래그.
async function antiFraud(req, uid, amount) {
  const repo = getRepo(), pid = PID(req), since = now() - 120000;
  const recent = await repo.queryRecords(pid, '_p2p_ledger', { limit: 200, sort: 'created_at:desc' });
  const mine = recent.filter((r) => r.data?.uid === uid && r.data?.ts >= since && r.data?.type === 'trade');
  const cnt = mine.length, sum = mine.reduce((a, r) => a + (r.data?.amount || 0), 0) + amount;
  if (cnt >= 8 || sum >= 5000000) {
    await repo.putRecord({ project_id: pid, collection: 'p2p_flag', doc_id: randomId('flg_'), data: { uid, reason: cnt >= 8 ? '단시간 다수 거래' : '단시간 고액 거래', count: cnt + 1, sum, ts: now(), resolved: false }, owner_id: null });
    return true;
  }
  return false;
}

// ================= 헬스 =================
router.get('/health', (_req, res) => res.json({ ok: true, service: 'iggift-p2p', version: '1.0.0' }));

// ================= 내 지갑 =================
router.get('/me', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const w = await getWallet(req, m.uid);
    // 내 상품권(지갑에 든 기프트카드)
    const cards = (await getRepo().queryRecords(PID(req), 'gift_cards', { ownerId: m.uid, limit: 200, sort: 'created_at:desc' }))
      .map((r) => ({ code: r.doc_id, balance: r.data.balance | 0, currency: r.data.currency || 'KRW', status: r.data.status, memo: r.data.memo }));
    res.json({ ok: true, uid: m.uid, name: m.name, wallet: w, cards });
  } catch (e) { next(e); }
});

// ================= 충전 =================
// 데모: 계좌이체 입금을 가정하고 즉시 반영(실서비스에서는 입금문자 파싱/PG로 대체).
// POST /charge { amount }
router.post('/charge', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const amount = Math.floor(Number((req.body || {}).amount));
    const cfg = await getCfg(req);
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount', message: '충전 금액을 확인하세요.' });
    if (amount > cfg.maxAmount) return res.status(400).json({ error: 'over_max', message: `1회 최대 ${cfg.maxAmount.toLocaleString()}원까지 가능합니다.` });
    const w = await getWallet(req, m.uid);
    w.krw = (w.krw | 0) + amount;
    await saveWallet(req, m.uid, w);
    await ledger(req, { type: 'charge', uid: m.uid, amount, balance: w.krw });
    res.json({ ok: true, wallet: w });
  } catch (e) { next(e); }
});

// ================= 환전(출금) =================
// POST /withdraw { amount, bank?, account? }
router.post('/withdraw', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const amount = Math.floor(Number(b.amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const w = await getWallet(req, m.uid);
    if (amount > (w.krw | 0)) return res.status(402).json({ error: 'insufficient', message: '잔액이 부족합니다.', balance: w.krw | 0 });
    w.krw = (w.krw | 0) - amount;
    await saveWallet(req, m.uid, w);
    const rec = await getRepo().putRecord({ project_id: PID(req), collection: 'p2p_withdraw', doc_id: randomId('wd_'), data: { uid: m.uid, amount, bank: b.bank || null, account: b.account || null, status: 'done', ts: now() }, owner_id: m.uid });
    await ledger(req, { type: 'withdraw', uid: m.uid, amount, balance: w.krw });
    res.json({ ok: true, wallet: w, withdrawId: rec.doc_id });
  } catch (e) { next(e); }
});

// ================= P2P 주문 등록 + 자동매칭 =================
// POST /orders { side:'buy'|'sell', amount, cardCode?(sell일 때 보유 상품권) }
//  buy  = 현금 내고 상품권을 산다(구매자). 지갑 krw 필요.
//  sell = 보유 상품권을 팔아 현금을 받는다(판매자). cardCode 필요(미지정 시 즉시 발급분으로 간주).
router.post('/orders', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const side = b.side === 'sell' ? 'sell' : 'buy';
    const amount = Math.floor(Number(b.amount));
    const cfg = await getCfg(req);
    const repo = getRepo(), pid = PID(req);
    if (!(amount >= cfg.minAmount)) return res.status(400).json({ error: 'bad_amount', message: `최소 ${cfg.minAmount.toLocaleString()}원부터 거래할 수 있습니다.` });
    if (amount > cfg.maxAmount) return res.status(400).json({ error: 'over_max', message: `1회 최대 ${cfg.maxAmount.toLocaleString()}원까지 가능합니다.` });

    // 구매자는 현금 lock, 판매자는 상품권 보유 확인
    const w = await getWallet(req, m.uid);
    let sellCardCode = null;
    if (side === 'buy') {
      if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: '지갑 잔액이 부족합니다. 먼저 충전하세요.', balance: w.krw | 0 });
      w.krw -= amount; w.locked = (w.locked | 0) + amount; await saveWallet(req, m.uid, w);
    } else {
      // 판매자: 지정 상품권이 있으면 그 카드를 매물로 묶는다. 없으면 보유 카드에서 금액 충당.
      const myCards = await repo.queryRecords(pid, 'gift_cards', { ownerId: m.uid, limit: 200, sort: 'created_at:desc' });
      const usable = myCards.filter((c) => c.data.status === 'active' && (c.data.balance | 0) >= amount);
      if (b.cardCode) {
        const hit = usable.find((c) => c.doc_id === String(b.cardCode).toUpperCase().replace(/[^0-9A-Z]/g, ''));
        if (!hit) return res.status(400).json({ error: 'no_card', message: '해당 상품권을 찾을 수 없거나 잔액이 부족합니다.' });
        sellCardCode = hit.doc_id;
      } else if (usable.length) {
        sellCardCode = usable[0].doc_id;
      } else {
        return res.status(400).json({ error: 'no_card', message: '판매할 상품권이 없습니다. 먼저 상품권을 보유하세요.' });
      }
      // 매물 카드 잠금
      const cardRec = await repo.getRecord(pid, 'gift_cards', sellCardCode);
      cardRec.data.status = 'locked'; await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: sellCardCode, data: cardRec.data, owner_id: m.uid });
    }

    const order = await repo.putRecord({
      project_id: pid, collection: 'p2p_order', doc_id: randomId('ord_'),
      data: { side, uid: m.uid, name: m.name, amount, cardCode: sellCardCode, status: 'open', counterId: null, counterName: null, isBot: false, tradeId: null, createdAt: now() },
      owner_id: m.uid,
    });

    // 자동 매칭: 반대 side의 open 주문 중 금액 일치 최우선
    const opp = side === 'buy' ? 'sell' : 'buy';
    const openOpp = (await repo.queryRecords(pid, 'p2p_order', { limit: 200, sort: 'created_at:asc' }))
      .filter((o) => o.data.side === opp && o.data.status === 'open' && o.data.amount === amount && o.data.uid !== m.uid);
    let match = openOpp[0] || null;
    let botUsed = false;

    if (!match && cfg.botEnabled) {
      // 매물/구매자 부족 → 본사 봇이 반대편으로 자동 참여
      const botCard = opp === 'sell' ? await issueCardTo(req, '__bot__', amount, 'KRW', 'P2P 봇 매물') : null;
      match = await repo.putRecord({
        project_id: pid, collection: 'p2p_order', doc_id: randomId('ord_'),
        data: { side: opp, uid: '__bot__', name: cfg.botName, amount, cardCode: botCard, status: 'open', counterId: null, counterName: null, isBot: true, tradeId: null, createdAt: now() },
        owner_id: null,
      });
      botUsed = true;
    }

    if (!match) {
      // 봇도 꺼져 있고 상대도 없으면 대기(open)
      return res.status(201).json({ ok: true, order: order.data, orderId: order.doc_id, matched: false, message: '등록 완료. 상대를 기다립니다.' });
    }

    // 매칭 성사 → 거래 생성 및 즉시 정산
    const trade = await settleTrade(req, { a: order, b: match, amount, cfg });
    res.status(201).json({ ok: true, order: order.data, orderId: order.doc_id, matched: true, bot: botUsed, trade });
  } catch (e) { next(e); }
});

// 매칭된 두 주문을 정산한다. buy쪽 lock된 현금 → seller에게(수수료 차감), seller 매물카드 → buyer 지갑으로 이전.
async function settleTrade(req, { a, b, amount, cfg }) {
  const repo = getRepo(), pid = PID(req);
  const buyOrder = a.data.side === 'buy' ? a : b;
  const sellOrder = a.data.side === 'sell' ? a : b;
  const buyerId = buyOrder.data.uid, sellerId = sellOrder.data.uid;
  const fee = Math.round(amount * cfg.feeRate);
  const sellerNet = amount - fee;
  const tid = randomId('trd_');
  const log = [];

  // 1) 구매자 lock 해제(이미 주문시 lock). 봇 구매자면 스킵.
  if (buyerId !== '__bot__') {
    const bw = await getWallet(req, buyerId);
    bw.locked = Math.max(0, (bw.locked | 0) - amount);
    await saveWallet(req, buyerId, bw);
    log.push({ at: now(), who: 'buyer', action: 'lock_release', amount });
  }
  // 2) 판매자에게 현금 지급(수수료 차감). 봇 판매자면 스킵.
  if (sellerId !== '__bot__') {
    const sw = await getWallet(req, sellerId);
    sw.krw = (sw.krw | 0) + sellerNet;
    await saveWallet(req, sellerId, sw);
    log.push({ at: now(), who: 'seller', action: 'payout', amount: sellerNet, fee });
  }
  // 3) 상품권을 구매자 지갑으로 이전. 판매자 매물 카드가 있으면 소유권 이전, 없으면(봇) 새 발급.
  let cardCode = sellOrder.data.cardCode;
  if (cardCode) {
    const cardRec = await repo.getRecord(pid, 'gift_cards', cardCode);
    if (cardRec) {
      cardRec.data.status = 'active';
      cardRec.data.owner_uid = buyerId;
      cardRec.data.memo = 'P2P 구매';
      await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: cardCode, data: cardRec.data, owner_id: buyerId === '__bot__' ? null : buyerId });
    }
  } else {
    cardCode = await issueCardTo(req, buyerId === '__bot__' ? '__bot__' : buyerId, amount, 'KRW', 'P2P 구매');
  }
  log.push({ at: now(), who: 'system', action: 'card_transfer', code: cardCode, to: buyerId });

  // 4) 주문 상태 완료
  for (const o of [buyOrder, sellOrder]) {
    o.data.status = 'completed'; o.data.tradeId = tid;
    o.data.counterId = o === buyOrder ? sellerId : buyerId;
    o.data.counterName = o === buyOrder ? sellOrder.data.name : buyOrder.data.name;
    await repo.putRecord({ project_id: pid, collection: 'p2p_order', doc_id: o.doc_id, data: o.data, owner_id: o.data.uid === '__bot__' ? null : o.data.uid });
  }

  const trade = await repo.putRecord({
    project_id: pid, collection: 'p2p_trade', doc_id: tid,
    data: { buyOrderId: buyOrder.doc_id, sellOrderId: sellOrder.doc_id, buyerId, buyerName: buyOrder.data.name, sellerId, sellerName: sellOrder.data.name, amount, fee, sellerNet, cardCode, bot: buyerId === '__bot__' || sellerId === '__bot__', status: 'completed', ledger: log, createdAt: now() },
    owner_id: null,
  });

  // 거래 원장 + 이상거래 탐지
  await ledger(req, { type: 'trade', tradeId: tid, buyerId, sellerId, amount, fee });
  if (buyerId !== '__bot__') await antiFraud(req, buyerId, amount);
  if (sellerId !== '__bot__') await antiFraud(req, sellerId, amount);

  return trade.data;
}

// ================= 내 주문/거래 내역 =================
router.get('/orders/mine', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rows = await getRepo().queryRecords(PID(req), 'p2p_order', { ownerId: m.uid, limit: 100, sort: 'created_at:desc' });
    res.json({ ok: true, orders: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.get('/trades/mine', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const all = await getRepo().queryRecords(PID(req), 'p2p_trade', { limit: 300, sort: 'created_at:desc' });
    const mine = all.filter((r) => r.data.buyerId === m.uid || r.data.sellerId === m.uid);
    res.json({ ok: true, trades: mine.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});

// 주문 취소(open 상태만)
router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const repo = getRepo(), pid = PID(req);
    const rec = await repo.getRecord(pid, 'p2p_order', req.params.id);
    if (!rec || rec.data.uid !== m.uid) return res.status(404).json({ error: 'not_found' });
    if (rec.data.status !== 'open') return res.status(409).json({ error: 'not_open', message: '이미 체결됐거나 취소할 수 없는 주문입니다.' });
    rec.data.status = 'cancelled';
    await repo.putRecord({ project_id: pid, collection: 'p2p_order', doc_id: rec.doc_id, data: rec.data, owner_id: m.uid });
    // 잠금 해제: 구매자 현금 / 판매자 카드
    if (rec.data.side === 'buy') {
      const w = await getWallet(req, m.uid); w.locked = Math.max(0, (w.locked | 0) - rec.data.amount); w.krw = (w.krw | 0) + rec.data.amount; await saveWallet(req, m.uid, w);
    } else if (rec.data.cardCode) {
      const c = await repo.getRecord(pid, 'gift_cards', rec.data.cardCode); if (c) { c.data.status = 'active'; await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: rec.data.cardCode, data: c.data, owner_id: m.uid }); }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ================= 입금문자 파싱 =================
// POST /parse-deposit { text }  — "[KB] 홍길동 100,000원 입금" 류 문자에서 송금자·금액·은행 추출.
const BANK_RX = /\[?\s*(KB|국민|신한|우리|하나|농협|NH|기업|IBK|카카오|토스|새마을|SC|씨티|부산|대구|광주|전북|경남|수협|우체국)\s*\]?/i;
function parseDeposit(text) {
  const t = String(text || '');
  const bank = (t.match(BANK_RX) || [])[1] || null;
  const amtM = t.match(/([0-9][0-9,]{2,})\s*원/);
  const amount = amtM ? parseInt(amtM[1].replace(/,/g, ''), 10) : null;
  // 금액/은행 토큰을 제거하고 남은 한글 이름 후보 추출
  let rest = t.replace(BANK_RX, ' ').replace(/[0-9][0-9,]*\s*원/g, ' ').replace(/입금|출금|잔액|이체|송금/g, ' ');
  const nameM = rest.match(/[가-힣]{2,4}/);
  const sender = nameM ? nameM[0] : null;
  return { bank, amount, sender };
}
router.post('/parse-deposit', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const parsed = parseDeposit((req.body || {}).text);
    const rec = await getRepo().putRecord({ project_id: PID(req), collection: 'p2p_deposit', doc_id: randomId('dep_'), data: { ...parsed, raw: String((req.body || {}).text || '').slice(0, 300), by: m.uid, ts: now() }, owner_id: null });
    // 파싱된 금액을 본인 지갑에 충전 반영(입금 확인 자동화 데모)
    let charged = false;
    if (parsed.amount > 0) {
      const w = await getWallet(req, m.uid); w.krw = (w.krw | 0) + parsed.amount; await saveWallet(req, m.uid, w);
      await ledger(req, { type: 'charge', uid: m.uid, amount: parsed.amount, balance: w.krw, src: 'deposit_parse' });
      charged = true;
    }
    res.json({ ok: true, parsed, depositId: rec.doc_id, charged });
  } catch (e) { next(e); }
});

// ================= QR 간편결제 =================
// 가맹점 등록(회원 누구나 가맹점 개설 가능) → QR 토큰 발급
router.post('/merchant', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const name = String((req.body || {}).name || '').slice(0, 60) || `${m.name} 가맹점`;
    const token = randomId('qr_');
    const rec = await getRepo().putRecord({ project_id: PID(req), collection: 'p2p_merchant', doc_id: token, data: { name, ownerUid: m.uid, createdAt: now() }, owner_id: m.uid });
    res.status(201).json({ ok: true, merchant: { token, name }, qr: token });
  } catch (e) { next(e); }
});
router.get('/merchant/mine', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rows = await getRepo().queryRecords(PID(req), 'p2p_merchant', { ownerId: m.uid, limit: 50, sort: 'created_at:desc' });
    res.json({ ok: true, merchants: rows.map((r) => ({ token: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
// QR 결제 실행: 구매자 지갑에서 차감 → 가맹점 소유자 지갑으로 정산(수수료 차감)
// POST /pay { qr, amount }
router.post('/pay', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const amount = Math.floor(Number(b.amount));
    const repo = getRepo(), pid = PID(req);
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    const merch = await repo.getRecord(pid, 'p2p_merchant', String(b.qr || ''));
    if (!merch) return res.status(404).json({ error: 'no_merchant', message: '가맹점 QR을 찾을 수 없습니다.' });
    const w = await getWallet(req, m.uid);
    if ((w.krw | 0) < amount) return res.status(402).json({ error: 'insufficient', message: '잔액이 부족합니다.', balance: w.krw | 0 });
    const cfg = await getCfg(req);
    const fee = Math.round(amount * cfg.feeRate), net = amount - fee;
    w.krw -= amount; await saveWallet(req, m.uid, w);
    const mw = await getWallet(req, merch.data.ownerUid); mw.krw = (mw.krw | 0) + net; await saveWallet(req, merch.data.ownerUid, mw);
    const pay = await repo.putRecord({ project_id: pid, collection: 'p2p_payment', doc_id: randomId('pay_'), data: { qr: merch.doc_id, merchant: merch.data.name, payerUid: m.uid, payerName: m.name, amount, fee, net, ts: now() }, owner_id: m.uid });
    await ledger(req, { type: 'pay', uid: m.uid, merchant: merch.data.name, amount, fee });
    res.json({ ok: true, paid: amount, merchant: merch.data.name, wallet: w, paymentId: pay.doc_id });
  } catch (e) { next(e); }
});

// ================= 공개 오더북(대기 주문) =================
router.get('/orderbook', async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(PID(req), 'p2p_order', { limit: 100, sort: 'created_at:desc' });
    const open = rows.filter((r) => r.data.status === 'open');
    res.json({ ok: true, buy: open.filter((r) => r.data.side === 'buy').map(fmtOrder), sell: open.filter((r) => r.data.side === 'sell').map(fmtOrder) });
  } catch (e) { next(e); }
});
function fmtOrder(r) { return { id: r.doc_id, side: r.data.side, amount: r.data.amount, name: r.data.isBot ? r.data.name : maskName(r.data.name), isBot: r.data.isBot, createdAt: r.data.createdAt }; }
function maskName(n) { const s = String(n || ''); return s.length <= 1 ? s : s[0] + '*'.repeat(Math.max(1, s.length - 1)); }

// ================= 운영자: 통계·목록·설정 =================
router.get('/admin/stats', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = PID(req);
    const trades = await repo.queryRecords(pid, 'p2p_trade', { limit: 5000, sort: 'created_at:desc' });
    const orders = await repo.queryRecords(pid, 'p2p_order', { limit: 5000, sort: 'created_at:desc' });
    const flags = await repo.queryRecords(pid, 'p2p_flag', { limit: 500, sort: 'created_at:desc' });
    const vol = trades.reduce((a, t) => a + (t.data.amount || 0), 0);
    const feeSum = trades.reduce((a, t) => a + (t.data.fee || 0), 0);
    const botCnt = trades.filter((t) => t.data.bot).length;
    res.json({ ok: true, stats: {
      trades: trades.length, volume: vol, fee: feeSum, botTrades: botCnt,
      openOrders: orders.filter((o) => o.data.status === 'open').length,
      flags: flags.filter((f) => !f.data.resolved).length,
    } });
  } catch (e) { next(e); }
});
router.get('/admin/trades', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(PID(req), 'p2p_trade', { limit: 200, sort: 'created_at:desc' });
    res.json({ ok: true, trades: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.get('/admin/orders', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(PID(req), 'p2p_order', { limit: 200, sort: 'created_at:desc' });
    res.json({ ok: true, orders: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.get('/admin/flags', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(PID(req), 'p2p_flag', { limit: 200, sort: 'created_at:desc' });
    res.json({ ok: true, flags: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.get('/admin/config', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return; res.json({ ok: true, config: await getCfg(req) }); } catch (e) { next(e); }
});
router.post('/admin/config', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const b = req.body || {}; const patch = {};
    if (b.feeRate != null) patch.feeRate = Math.max(0, Math.min(0.2, Number(b.feeRate)));
    if (b.botEnabled != null) patch.botEnabled = !!b.botEnabled;
    if (b.botName) patch.botName = String(b.botName).slice(0, 40);
    if (b.minAmount != null) patch.minAmount = Math.max(0, Math.floor(Number(b.minAmount)));
    if (b.maxAmount != null) patch.maxAmount = Math.max(1000, Math.floor(Number(b.maxAmount)));
    res.json({ ok: true, config: await setCfg(req, patch) });
  } catch (e) { next(e); }
});

// ================= 결제(충전) 연동 — 카카오페이·네이버페이·PayPal·글로벌·계좌이체 =================
// 키가 없으면 내장 샌드박스로 결제준비→승인→충전까지 실제로 동작. 키가 들어오면 그 수단만 실 API로 전환.
const PROVIDER_META = { wallet:'계좌이체', kakaopay:'카카오페이', naverpay:'네이버페이', paypal:'PayPal', global:'글로벌페이' };
async function providerCfg(req, name) { const cfg = await getCfg(req); return (cfg.providers || {})[name] || null; }
function originOf(req) { return (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host'); }

// PayPal 실 API (키가 설정된 경우에만 호출). sandbox/live 환경 선택.
function paypalBase(pc) { return (pc.env === 'live') ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken(pc) {
  const r = await fetch(paypalBase(pc) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + Buffer.from(`${pc.clientId}:${pc.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('paypal_auth_failed');
  return (await r.json()).access_token;
}
async function paypalCreateOrder(pc, { amount, returnUrl, cancelUrl }) {
  const tok = await paypalToken(pc);
  const r = await fetch(paypalBase(pc) + '/v2/checkout/orders', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: (amount / 1300).toFixed(2) }, custom_id: 'iggift_charge' }], application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', brand_name: 'igGift' } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('paypal_order_failed');
  const approve = (j.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  return { orderId: j.id, approveUrl: approve ? approve.href : null };
}
async function paypalCapture(pc, orderId) {
  const tok = await paypalToken(pc);
  const r = await fetch(paypalBase(pc) + `/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  return { ok: r.ok && j.status === 'COMPLETED', status: j.status };
}

// 결제 시작: payin(pending) 생성 → 승인 URL 반환
// POST /payin/start { provider, amount }
router.post('/payin/start', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const provider = PROVIDER_META[b.provider] ? b.provider : null;
    const amount = Math.floor(Number(b.amount));
    const cfg = await getCfg(req);
    if (!provider) return res.status(400).json({ error: 'bad_provider', message: '지원하지 않는 결제수단입니다.' });
    if (!(amount >= 1000)) return res.status(400).json({ error: 'bad_amount', message: '최소 1,000원부터 충전할 수 있습니다.' });
    if (amount > cfg.maxAmount) return res.status(400).json({ error: 'over_max', message: `1회 최대 ${cfg.maxAmount.toLocaleString()}원까지 가능합니다.` });
    const pc = cfg.providers[provider] || {};
    if (pc.enabled === false) return res.status(400).json({ error: 'disabled', message: '현재 사용할 수 없는 결제수단입니다.' });

    const repo = getRepo(), pid = PID(req), piId = randomId('pi_');
    const origin = originOf(req);
    let approveUrl, providerRef = null, sandbox = true, live = false;

    // 실 API 분기: PayPal 키가 모두 있으면 실제 주문 생성
    if (provider === 'paypal' && pc.live && pc.clientId && pc.clientSecret) {
      try {
        const returnUrl = `${origin}/app/iggift/pay-return.html?pi=${piId}`;
        const cancelUrl = `${origin}/app/iggift/pay-return.html?pi=${piId}&cancel=1`;
        const o = await paypalCreateOrder(pc, { amount, returnUrl, cancelUrl });
        approveUrl = o.approveUrl; providerRef = o.orderId; sandbox = false; live = true;
      } catch (e) {
        return res.status(502).json({ error: 'provider_error', message: 'PayPal 주문 생성에 실패했습니다. 키 설정을 확인하세요.' });
      }
    } else {
      // 내장 샌드박스: 실제 승인 페이지로 이동 → 승인 시 충전까지 동작(키 꽂으면 실 결제로 교체)
      approveUrl = `${origin}/app/iggift/pay-approve.html?pi=${piId}&provider=${provider}&amount=${amount}`;
    }

    await repo.putRecord({ project_id: pid, collection: 'p2p_payin', doc_id: piId, data: {
      uid: m.uid, name: m.name, provider, label: PROVIDER_META[provider], amount, status: 'pending', providerRef, sandbox, live, createdAt: now(),
    }, owner_id: m.uid });
    res.status(201).json({ ok: true, payinId: piId, provider, label: PROVIDER_META[provider], approveUrl, sandbox });
  } catch (e) { next(e); }
});

// 결제 확정: 승인 페이지(샌드박스) 또는 PayPal 리턴 후 호출 → 검증·충전
// POST /payin/confirm { pi, result? }
router.post('/payin/confirm', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const b = req.body || {};
    const repo = getRepo(), pid = PID(req);
    const rec = await repo.getRecord(pid, 'p2p_payin', String(b.pi || ''));
    if (!rec || rec.data.uid !== m.uid) return res.status(404).json({ error: 'not_found', message: '결제 요청을 찾을 수 없습니다.' });
    if (rec.data.status !== 'pending') return res.json({ ok: rec.data.status === 'approved', status: rec.data.status, already: true });
    const d = rec.data;

    let paid = false;
    if (d.live && d.provider === 'paypal' && d.providerRef) {
      const pc = await providerCfg(req, 'paypal');
      const cap = await paypalCapture(pc, d.providerRef);
      paid = cap.ok;
      if (!paid) { d.status = 'failed'; await repo.putRecord({ project_id: pid, collection: 'p2p_payin', doc_id: rec.doc_id, data: d, owner_id: m.uid }); return res.status(402).json({ error: 'capture_failed', message: 'PayPal 결제 승인에 실패했습니다.', status: cap.status }); }
    } else {
      // 샌드박스: 승인 페이지에서 success 전달 시 충전
      paid = (b.result === 'success' || b.result === undefined);
    }

    if (paid) {
      const w = await getWallet(req, m.uid);
      w.krw = (w.krw | 0) + d.amount;
      await saveWallet(req, m.uid, w);
      d.status = 'approved'; d.approvedAt = now();
      await repo.putRecord({ project_id: pid, collection: 'p2p_payin', doc_id: rec.doc_id, data: d, owner_id: m.uid });
      await ledger(req, { type: 'charge', uid: m.uid, amount: d.amount, balance: w.krw, src: 'payin:' + d.provider });
      return res.json({ ok: true, status: 'approved', amount: d.amount, wallet: w, label: d.label });
    }
    d.status = 'failed';
    await repo.putRecord({ project_id: pid, collection: 'p2p_payin', doc_id: rec.doc_id, data: d, owner_id: m.uid });
    res.json({ ok: false, status: 'failed' });
  } catch (e) { next(e); }
});

// 사용 가능한 결제수단 목록(공개 — 프론트 충전 화면용). ':id'보다 먼저 등록해야 'methods'가 id로 안 잡힌다.
router.get('/payin/methods', async (req, res, next) => {
  try {
    const cfg = await getCfg(req);
    const methods = Object.entries(cfg.providers || {})
      .filter(([, v]) => v.enabled !== false)
      .map(([k, v]) => ({ key: k, label: v.label || PROVIDER_META[k] || k, live: !!v.live }));
    res.json({ ok: true, methods });
  } catch (e) { next(e); }
});

// 결제 상태 조회
router.get('/payin/:id', async (req, res, next) => {
  try {
    const m = requireMember(req, res); if (!m) return;
    const rec = await getRepo().getRecord(PID(req), 'p2p_payin', req.params.id);
    if (!rec || rec.data.uid !== m.uid) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, payin: { id: rec.doc_id, ...rec.data } });
  } catch (e) { next(e); }
});

// 운영자: 결제수단 목록(상세) 및 설정
router.get('/admin/payin', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const cfg = await getCfg(req);
    // 시크릿 값은 설정 여부만 노출
    const providers = Object.fromEntries(Object.entries(cfg.providers || {}).map(([k, v]) => [k, {
      label: v.label, enabled: v.enabled !== false, live: !!v.live,
      hasClientId: !!v.clientId, hasSecret: !!(v.secretKey || v.clientSecret), env: v.env || null,
    }]));
    const rows = await getRepo().queryRecords(PID(req), 'p2p_payin', { limit: 100, sort: 'created_at:desc' });
    res.json({ ok: true, providers, recent: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});
router.post('/admin/payin/config', async (req, res, next) => {
  try { if (!requireAdmin(req, res)) return;
    const b = req.body || {}; const cfg = await getCfg(req);
    const providers = { ...(cfg.providers || {}) };
    const p = String(b.provider || '');
    if (!providers[p]) return res.status(400).json({ error: 'bad_provider' });
    const cur = { ...providers[p] };
    if (b.enabled != null) cur.enabled = !!b.enabled;
    if (b.live != null) cur.live = !!b.live;
    for (const k of ['cid', 'secretKey', 'clientId', 'clientSecret', 'chainId', 'env']) if (b[k] != null) cur[k] = String(b[k]);
    providers[p] = cur;
    await setCfg(req, { providers });
    res.json({ ok: true, provider: p, live: cur.live, enabled: cur.enabled !== false });
  } catch (e) { next(e); }
});

export default router;
