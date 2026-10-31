// igGift — 글로벌 기프트카드 발급·잔액·사용 API (B2B).
// Vercel 서버리스 + @vercel/blob(단일 JSON Blob: {users,cards,gifts,ledger}) 버전을 igServer 레코드 스토어로 이식.
// 저장: 컬렉션 'gift_cards'(doc_id=카드코드), '_gift_ledger'(append-only 거래원장).
// 인증: 공개 호출은 프로젝트 공개키(api_key). 운영자/정산 호출은 시크릿키(req.projectAuth==='secret').
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { randomId } from '../config.js';

const router = Router();

// ---- 유틸 ----
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 혼동 문자 제외(원본 rnd와 동일 알파벳)
function rnd(n) {
  let o = '';
  const buf = new Uint8Array(n);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(buf);
  for (let i = 0; i < n; i++) o += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return o;
}
function newCode() {
  // 4-4-4-4 형식의 사람이 읽기 쉬운 코드
  return [rnd(4), rnd(4), rnd(4), rnd(4)].join('-');
}
function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
const CURRENCIES = ['KRW', 'USD', 'EUR', 'JPY', 'GBP', 'CNY', 'INR', 'CAD', 'AUD'];
function isAdmin(req) { return req.projectAuth === 'secret'; }
function requireAdmin(req, res) {
  if (!isAdmin(req)) { res.status(403).json({ error: 'admin_only', message: '운영자(시크릿) 키가 필요합니다.' }); return false; }
  return true;
}

function cardPublic(rec) {
  if (!rec) return null;
  const d = rec.data || {};
  return {
    code: rec.doc_id, status: d.status || 'active', balance: d.balance | 0, initial: d.initial | 0,
    currency: d.currency || 'KRW', recipient: d.recipient || null, memo: d.memo || null,
    created_at: rec.created_at, expires_at: d.expires_at || null,
  };
}
function cardKey(code) { return normCode(code); }
async function appendLedger(repo, pid, entry) {
  await repo.putRecord({ project_id: pid, collection: '_gift_ledger', doc_id: randomId('gl_'), data: { ...entry, ts: Date.now() }, owner_id: null });
}

// ---- 헬스/정보 ----
router.get('/health', (_req, res) => res.json({ ok: true, service: 'iggift-api', version: '1.2.0', host: 'igserver' }));

// ---- 카드 발급 (운영자) ----
// POST /cards { amount, currency?, recipient?, memo?, expires_at?, count? }
router.post('/cards', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const b = req.body || {};
    const amount = Math.floor(Number(b.amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount', message: '금액(amount)은 1 이상이어야 합니다.' });
    const currency = CURRENCIES.includes(String(b.currency || '').toUpperCase()) ? String(b.currency).toUpperCase() : 'KRW';
    const count = Math.min(1000, Math.max(1, Math.floor(Number(b.count) || 1)));
    const repo = getRepo(), pid = req.project.id;
    const out = [];
    for (let i = 0; i < count; i++) {
      let code = cardKey(newCode());
      // 코드 충돌 방지(희박하지만 확인)
      for (let t = 0; t < 5 && await repo.getRecord(pid, 'gift_cards', code); t++) code = cardKey(newCode());
      const data = {
        status: 'active', balance: amount, initial: amount, currency,
        recipient: b.recipient ? String(b.recipient).slice(0, 120) : null,
        memo: b.memo ? String(b.memo).slice(0, 300) : null,
        expires_at: b.expires_at ? String(b.expires_at).slice(0, 40) : null,
      };
      const rec = await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: code, data, owner_id: null });
      await appendLedger(repo, pid, { type: 'issue', code, amount, currency });
      out.push(cardPublic(rec));
    }
    res.status(201).json(count === 1 ? { ok: true, card: out[0] } : { ok: true, cards: out });
  } catch (e) { next(e); }
});

// ---- 잔액 조회 (공개) ----
// GET /cards/:code
router.get('/cards/:code', async (req, res, next) => {
  try {
    const rec = await getRepo().getRecord(req.project.id, 'gift_cards', cardKey(req.params.code));
    if (!rec) return res.status(404).json({ error: 'not_found', message: '존재하지 않는 카드입니다.' });
    res.json({ ok: true, card: cardPublic(rec) });
  } catch (e) { next(e); }
});

// ---- 사용(차감) (공개) ----
// POST /cards/:code/redeem { amount, ref? }
router.post('/cards/:code/redeem', async (req, res, next) => {
  try {
    const repo = getRepo(), pid = req.project.id, code = cardKey(req.params.code);
    const rec = await repo.getRecord(pid, 'gift_cards', code);
    if (!rec) return res.status(404).json({ error: 'not_found', message: '존재하지 않는 카드입니다.' });
    const d = rec.data || {};
    if (d.status !== 'active') return res.status(409).json({ error: 'inactive', message: `카드 상태: ${d.status}` });
    if (d.expires_at && Date.now() > Date.parse(d.expires_at)) {
      d.status = 'expired';
      await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: code, data: d, owner_id: null });
      return res.status(409).json({ error: 'expired', message: '만료된 카드입니다.' });
    }
    const amount = Math.floor(Number((req.body || {}).amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    if (amount > (d.balance | 0)) return res.status(402).json({ error: 'insufficient', message: '잔액이 부족합니다.', balance: d.balance | 0 });
    d.balance = (d.balance | 0) - amount;
    if (d.balance === 0) d.status = 'used';
    await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: code, data: d, owner_id: null });
    await appendLedger(repo, pid, { type: 'redeem', code, amount, ref: (req.body || {}).ref || null, balance: d.balance });
    res.json({ ok: true, redeemed: amount, balance: d.balance, status: d.status });
  } catch (e) { next(e); }
});

// ---- 충전(가맹 재적립) (운영자) ----
// POST /cards/:code/load { amount }
router.post('/cards/:code/load', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id, code = cardKey(req.params.code);
    const rec = await repo.getRecord(pid, 'gift_cards', code);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const d = rec.data || {};
    const amount = Math.floor(Number((req.body || {}).amount));
    if (!(amount > 0)) return res.status(400).json({ error: 'bad_amount' });
    d.balance = (d.balance | 0) + amount;
    if (d.status === 'used') d.status = 'active';
    await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: code, data: d, owner_id: null });
    await appendLedger(repo, pid, { type: 'load', code, amount, balance: d.balance });
    res.json({ ok: true, balance: d.balance, status: d.status });
  } catch (e) { next(e); }
});

// ---- 무효화 (운영자) ----
// POST /cards/:code/void
router.post('/cards/:code/void', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const repo = getRepo(), pid = req.project.id, code = cardKey(req.params.code);
    const rec = await repo.getRecord(pid, 'gift_cards', code);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    const d = rec.data || {};
    d.status = 'void';
    await repo.putRecord({ project_id: pid, collection: 'gift_cards', doc_id: code, data: d, owner_id: null });
    await appendLedger(repo, pid, { type: 'void', code });
    res.json({ ok: true, status: d.status });
  } catch (e) { next(e); }
});

// ---- 목록 (운영자) ----
// GET /cards?limit=&offset=
router.get('/cards', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const rows = await getRepo().queryRecords(req.project.id, 'gift_cards', { limit, sort: 'created_at:desc' });
    res.json({ ok: true, cards: rows.map(cardPublic) });
  } catch (e) { next(e); }
});

// ---- 거래원장 (운영자) ----
// GET /ledger?limit=
router.get('/ledger', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(1000, parseInt(req.query.limit || '200', 10));
    const rows = await getRepo().queryRecords(req.project.id, '_gift_ledger', { limit, sort: 'created_at:desc' });
    res.json({ ok: true, ledger: rows.map((r) => ({ id: r.doc_id, ...r.data })) });
  } catch (e) { next(e); }
});

// ---- 통계 (운영자) ----
// GET /stats
router.get('/stats', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const rows = await getRepo().queryRecords(req.project.id, 'gift_cards', { limit: 5000, sort: 'created_at:desc' });
    const s = { total: rows.length, active: 0, used: 0, void: 0, expired: 0, issued_amount: 0, outstanding: 0, by_currency: {} };
    for (const r of rows) {
      const d = r.data || {};
      s[d.status] = (s[d.status] || 0) + 1;
      s.issued_amount += d.initial | 0;
      s.outstanding += (d.status === 'active' || d.status === 'used') ? (d.balance | 0) : 0;
      const c = d.currency || 'KRW';
      s.by_currency[c] = (s.by_currency[c] || 0) + (d.balance | 0);
    }
    res.json({ ok: true, stats: s });
  } catch (e) { next(e); }
});

export default router;
