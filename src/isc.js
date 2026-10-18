// ISC(IndieStreamCoin) 공용 지갑 레이어.
// igPlay·igMarket 등 여러 모듈이 같은 지갑/원장을 공유한다. 잔액은 서버만 변경한다.
// 저장(서버 전용 컬렉션): _isc_wallet(doc=uid), _isc_ledger(append-only)
import { getRepo } from './db/index.js';
import { broadcast } from './realtime.js';
import { randomId } from './config.js';

export const START_ISC = 120;

export async function getWallet(pid, uid) {
  const rec = await getRepo().getRecord(pid, '_isc_wallet', uid);
  if (rec && rec.data) return { balance: rec.data.balance | 0, skins: rec.data.skins || ['classic'], skin: rec.data.skin || 'classic' };
  return { balance: START_ISC, skins: ['classic'], skin: 'classic' };
}
export async function putWallet(pid, uid, w) {
  await getRepo().putRecord({ project_id: pid, collection: '_isc_wallet', doc_id: uid, data: w, owner_id: uid });
  return w;
}
export async function ledger(pid, uid, delta, reason, ref) {
  await getRepo().putRecord({
    project_id: pid, collection: '_isc_ledger', doc_id: randomId('l_'),
    data: { uid, delta, reason, ref: ref || null, ts: Date.now() }, owner_id: uid,
  });
}
// 적립: 지갑 반영 + 원장 기록 + 실시간 알림
export async function credit(pid, uid, amount, reason, ref) {
  if (!uid || amount <= 0) return null;
  const w = await getWallet(pid, uid);
  w.balance += amount;
  await putWallet(pid, uid, w);
  await ledger(pid, uid, amount, reason, ref);
  broadcast(pid, `isc:${uid}`, { type: 'isc_changed', balance: w.balance, delta: amount, reason, ts: Date.now() });
  return w;
}
// 차감: 잔액 부족이면 null
export async function debit(pid, uid, amount, reason, ref) {
  const w = await getWallet(pid, uid);
  if (w.balance < amount) return null;
  w.balance -= amount;
  await putWallet(pid, uid, w);
  await ledger(pid, uid, -amount, reason, ref);
  broadcast(pid, `isc:${uid}`, { type: 'isc_changed', balance: w.balance, delta: -amount, reason, ts: Date.now() });
  return w;
}
