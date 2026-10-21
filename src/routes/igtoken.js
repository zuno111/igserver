// 창작자 커스텀 토큰 모듈 (ISC 생태계 발행 레이어).
// 채널(창작자)이 자기 토큰(심볼)을 발행 → 팬이 ISC로 매수(본딩형 고정가) → 토큰으로 창작자 전용 혜택.
// ISC는 공용 [[isc]] 레이어로 차감/적립. 토큰 잔액은 서버만 변경한다.
//   tokens      : 발행 토큰 {symbol, name, ownerId, ownerName, priceIsc(1토큰당 ISC), supply, holders}
//   _tok_bal    : 보유 잔액 (doc_id = symbol:uid)
//   _tok_ledger : 토큰 거래 원장(append-only)
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';
import { credit, debit } from '../isc.js';

const router = Router();
const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,9}$/; // 2~10자 대문자/숫자, 첫 글자 알파벳
const RESERVED = ['ISC', 'IG', 'IGPLAY', 'ADMIN'];
const FEE_RATE = 0.03; // 매수 시 창작자에게 가는 비율 외 플랫폼 수수료(토큰 환매 대비 간단화)

async function getToken(pid, symbol) {
  return getRepo().getRecord(pid, 'tokens', symbol);
}
function tokenPublic(rec) {
  if (!rec) return null;
  const d = rec.data || {};
  return { symbol: rec.doc_id, name: d.name, ownerId: rec.owner_id, ownerName: d.ownerName || '',
    priceIsc: d.priceIsc | 0, supply: d.supply | 0, holders: d.holders | 0, desc: d.desc || '', created_at: rec.created_at };
}
async function getBal(pid, symbol, uid) {
  const r = await getRepo().getRecord(pid, '_tok_bal', symbol + ':' + uid);
  return r?.data?.amount || 0;
}
async function setBal(pid, symbol, uid, amount) {
  await getRepo().putRecord({ project_id: pid, collection: '_tok_bal', doc_id: symbol + ':' + uid, data: { symbol, uid, amount }, owner_id: uid });
}

// 발행 토큰 목록
router.get('/tokens', optionalUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, 'tokens', { limit: 200, sort: 'created_at:desc' });
    res.json({ tokens: rows.map(tokenPublic) });
  } catch (e) { next(e); }
});
// 단건
router.get('/tokens/:symbol', optionalUser, async (req, res, next) => {
  try {
    const rec = await getToken(req.project.id, String(req.params.symbol || '').toUpperCase());
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const out = tokenPublic(rec);
    if (req.user) out.myBalance = await getBal(req.project.id, out.symbol, req.user.uid);
    res.json({ token: out });
  } catch (e) { next(e); }
});
// 토큰 발행 (1인 1심볼 권장: 심볼 중복 금지)
router.post('/tokens', requireUser, async (req, res, next) => {
  try {
    const symbol = String((req.body && req.body.symbol) || '').toUpperCase();
    const { name, priceIsc, desc } = req.body || {};
    if (!SYMBOL_RE.test(symbol) || RESERVED.includes(symbol)) return res.status(400).json({ error: 'bad_symbol', message: '심볼은 2~10자 영문 대문자/숫자이며 예약어가 아니어야 합니다.' });
    const price = Math.max(1, priceIsc | 0);
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    if (await getToken(pid, symbol)) return res.status(409).json({ error: 'symbol_taken', message: '이미 발행된 심볼입니다.' });
    const data = { name: String(name || symbol).slice(0, 40), ownerName: req.user.name || '익명', priceIsc: price, supply: 0, holders: 0, desc: String(desc || '').slice(0, 300) };
    const rec = await repo.putRecord({ project_id: pid, collection: 'tokens', doc_id: symbol, data, owner_id: uid });
    broadcast(pid, 'igtoken:tokens', { type: 'token_new', symbol, name: data.name, ts: Date.now() });
    res.status(201).json({ token: tokenPublic(rec) });
  } catch (e) { next(e); }
});
// 매수: ISC 차감 → 토큰 발행(민트)·잔액 증가, 창작자에게 ISC 적립(수수료 제외)
router.post('/tokens/:symbol/buy', requireUser, async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const qty = Math.round((req.body && req.body.qty) || 0);
    if (qty < 1) return res.status(400).json({ error: 'bad_qty' });
    const pid = req.project.id, uid = req.user.uid, repo = getRepo();
    const rec = await getToken(pid, symbol); if (!rec) return res.status(404).json({ error: 'not_found' });
    const cost = (rec.data.priceIsc | 0) * qty;
    const after = await debit(pid, uid, cost, 'token_buy', symbol);
    if (!after) return res.status(402).json({ error: 'insufficient', message: 'ISC가 부족합니다.' });
    // 창작자에게 수수료 제외 적립(본인 토큰 매수면 자기 지갑으로 되돌아가되 수수료만큼 소각)
    const creatorGet = Math.round(cost * (1 - FEE_RATE));
    await credit(pid, rec.owner_id, creatorGet, 'token_sold', symbol);
    // 잔액/공급 갱신
    const prev = await getBal(pid, symbol, uid);
    if (!prev) rec.data.holders = (rec.data.holders | 0) + 1;
    await setBal(pid, symbol, uid, prev + qty);
    rec.data.supply = (rec.data.supply | 0) + qty;
    await repo.putRecord({ project_id: pid, collection: 'tokens', doc_id: symbol, data: rec.data, owner_id: rec.owner_id });
    await repo.putRecord({ project_id: pid, collection: '_tok_ledger', doc_id: randomId('tk_'), data: { symbol, uid, qty, cost, ts: Date.now() }, owner_id: uid });
    broadcast(pid, `igtoken:${symbol}`, { type: 'token_buy', supply: rec.data.supply, holders: rec.data.holders, ts: Date.now() });
    res.json({ ok: true, wallet: after, balance: prev + qty, supply: rec.data.supply });
  } catch (e) { next(e); }
});
// 내 보유 토큰 목록
router.get('/holdings', requireUser, async (req, res, next) => {
  try {
    const rows = await getRepo().queryRecords(req.project.id, '_tok_bal', { ownerId: req.user.uid, limit: 100 });
    res.json({ holdings: rows.map((r) => r.data).filter((d) => d.amount > 0) });
  } catch (e) { next(e); }
});

// ===================== 홀더 혜택 (토큰 효용) =====================
// 창작자가 "N개 이상 보유 시 열람" 혜택(공지/코드/링크 등)을 게시 → 팬은 보유량 충족 시 열람.
//   _tok_perk : 혜택 {symbol, minHold, title, body(혜택 내용), kind:'post'|'code'|'link'}
async function requireTokenOwner(req, symbol) {
  const rec = await getToken(req.project.id, symbol);
  if (!rec) return { err: 404 };
  if (rec.owner_id !== req.user.uid) return { err: 403 };
  return { rec };
}
// 혜택 게시 (창작자 전용)
router.post('/tokens/:symbol/perks', requireUser, async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const chk = await requireTokenOwner(req, symbol);
    if (chk.err) return res.status(chk.err).json({ error: chk.err === 404 ? 'not_found' : 'not_owner' });
    const { minHold, title, body, kind } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'bad_perk', message: '제목과 내용이 필요합니다.' });
    const id = randomId('pk_');
    const data = { symbol, minHold: Math.max(1, minHold | 0), title: String(title).slice(0, 80), body: String(body).slice(0, 1000), kind: ['post', 'code', 'link'].includes(kind) ? kind : 'post', ts: Date.now() };
    await getRepo().putRecord({ project_id: req.project.id, collection: '_tok_perk', doc_id: id, data, owner_id: req.user.uid });
    res.status(201).json({ perk: { id, symbol: data.symbol, minHold: data.minHold, title: data.title, kind: data.kind } });
  } catch (e) { next(e); }
});
// 혜택 목록 (보유량에 따라 잠금/해제. 내용은 충족 시에만 반환)
router.get('/tokens/:symbol/perks', requireUser, async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const pid = req.project.id, uid = req.user.uid;
    const myBal = await getBal(pid, symbol, uid);
    const rows = await getRepo().queryRecords(pid, '_tok_perk', { limit: 100, sort: 'created_at:desc', filters: [['symbol', 'eq', symbol]] });
    const perks = rows.map((r) => {
      const d = r.data; const unlocked = myBal >= (d.minHold | 0);
      return { id: r.doc_id, title: d.title, minHold: d.minHold, kind: d.kind, unlocked, body: unlocked ? d.body : null };
    });
    res.json({ perks, myBalance: myBal });
  } catch (e) { next(e); }
});
// 홀더 티어(배지) 계산: 보유량 → 티어명
function tierOf(bal) {
  if (bal >= 100) return 'DIAMOND';
  if (bal >= 30) return 'GOLD';
  if (bal >= 10) return 'SILVER';
  if (bal >= 1) return 'BRONZE';
  return null;
}
// 특정 토큰에서 내 홀더 티어
router.get('/tokens/:symbol/tier', requireUser, async (req, res, next) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const bal = await getBal(req.project.id, symbol, req.user.uid);
    res.json({ symbol, balance: bal, tier: tierOf(bal) });
  } catch (e) { next(e); }
});

export default router;
