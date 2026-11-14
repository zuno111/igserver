// igPay 시세 자동 갱신 — 무료·무가입 공개 소스에서 외화 환율과 금·은 시세를 가져와 pay_meta.config에 저장.
// 외화: open.er-api.com (USD 기준 환율, 무료/무키) → KRW/단위 로 환산
// 금·은: goldprice.org (USD/트로이온스, 무료/무키) → 위 USD-KRW 로 원/그램 환산
// igCoin(IGC)은 자체 토큰이라 외부 시세가 없어 수동 유지(피드 대상 아님).
import { getRepo } from './db/index.js';
import { log } from './logger.js';

const FX_CCYS = ['USD', 'JPY', 'EUR', 'CNY'];
const OZ_TO_G = 31.1034768; // 1 트로이온스 = 31.1034768 g
// 기본은 무료 공개 소스. 자가호스팅/점검 시 환경변수로 교체 가능.
export const FX_URL = process.env.IGPAY_FX_URL || 'https://open.er-api.com/v6/latest/USD';
export const METAL_URL = process.env.IGPAY_METAL_URL || 'https://data-asg.goldprice.org/dbXRates/USD';

async function fetchJson(url, ms = 12000, extraHeaders = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'igPay-rate-feed/1.0', 'Accept': 'application/json', ...extraHeaders },
    });
    if (!r.ok) throw new Error('http_' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// USD 기준 환율(rates[X] = 1 USD 당 X 단위) → KRW/단위
export async function fetchFxRates(url = FX_URL) {
  const j = await fetchJson(url);
  const rates = j?.rates;
  if (!rates || !(rates.KRW > 0)) throw new Error('fx_no_krw');
  const usdKrw = rates.KRW; // 1 USD = usdKrw KRW
  const out = {};
  for (const c of FX_CCYS) {
    if (c === 'USD') { out.USD = Math.round(usdKrw * 100) / 100; continue; }
    const perUsd = rates[c]; // 1 USD = perUsd (c)
    if (perUsd > 0) out[c] = Math.round((usdKrw / perUsd) * 100) / 100; // 1 (c) 당 KRW
  }
  const at = j?.time_last_update_unix ? j.time_last_update_unix * 1000 : Date.now();
  return { rates: out, usdKrw, src: 'open.er-api.com', at };
}

// 금·은 USD/온스 → KRW/그램 (usdKrw 필요)
export async function fetchMetalKrwPerGram(usdKrw, url = METAL_URL) {
  const j = await fetchJson(url, 12000, { 'Referer': 'https://goldprice.org/' });
  const item = j?.items?.[0];
  if (!item || !(item.xauPrice > 0) || !(item.xagPrice > 0)) throw new Error('metal_bad');
  const gold = Math.round((item.xauPrice * usdKrw) / OZ_TO_G);
  const silver = Math.round((item.xagPrice * usdKrw) / OZ_TO_G);
  return { gold, silver, src: 'goldprice.org', xau: item.xauPrice, xag: item.xagPrice };
}

// 실제 갱신: 설정을 읽어 fxRates / goldPrice / silverPrice / rateFeed 를 저장. 부분 실패 허용.
export async function refreshRates(projectId, opts = {}) {
  const repo = getRepo();
  const rec = await repo.getRecord(projectId, 'pay_meta', 'config');
  const data = { ...(rec?.data || {}) };
  const res = { ok: false, at: Date.now(), fx: null, metal: null, errors: [] };
  let usdKrw = (data.fxRates && data.fxRates.USD) || 1350;
  try {
    const fx = await fetchFxRates(opts.fxUrl || FX_URL);
    data.fxRates = { ...(data.fxRates || {}), ...fx.rates };
    usdKrw = fx.usdKrw;
    res.fx = { rates: fx.rates, src: fx.src };
  } catch (e) { res.errors.push('fx:' + (e?.message || e)); }
  try {
    const m = await fetchMetalKrwPerGram(usdKrw, opts.metalUrl || METAL_URL);
    data.goldPrice = m.gold; data.silverPrice = m.silver;
    res.metal = { gold: m.gold, silver: m.silver, src: m.src };
  } catch (e) { res.errors.push('metal:' + (e?.message || e)); }
  res.ok = !!(res.fx || res.metal);
  data.rateFeed = {
    lastAt: res.at, ok: res.ok,
    fxSrc: res.fx ? res.fx.src : null,
    metalSrc: res.metal ? res.metal.src : null,
    errors: res.errors,
  };
  await repo.putRecord({ project_id: projectId, collection: 'pay_meta', doc_id: 'config', data, owner_id: null });
  res.rateFeed = data.rateFeed;
  return res;
}

let timer = null;
// 서버 기동 시 1회 + 주기 갱신. 설정 rateFeedAuto === false 면 건너뜀(수동 운영).
export function startRateFeed(projectId, intervalMs = 6 * 60 * 60 * 1000) {
  if (!projectId) { log('warn', 'igPay 시세 피드: projectId 없음, 미동작', {}); return null; }
  const run = async () => {
    try {
      const rec = await getRepo().getRecord(projectId, 'pay_meta', 'config');
      if (rec?.data?.rateFeedAuto === false) return; // 운영자가 자동 갱신 끔
      const r = await refreshRates(projectId);
      log('info', 'igPay 시세 자동 갱신', { ok: r.ok, fx: r.rateFeed.fxSrc, metal: r.rateFeed.metalSrc, errors: r.errors });
    } catch (e) { log('warn', 'igPay 시세 갱신 실패', { err: String(e?.message || e) }); }
  };
  setTimeout(run, 10000); // 기동 10초 뒤 최초 1회
  if (timer) clearInterval(timer);
  timer = setInterval(run, intervalMs);
  return timer;
}
