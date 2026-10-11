// 웹훅 발송. 데이터 변경 시 프로젝트에 등록된 URL로 서명된 POST를 보낸다.
// 웹훅 정의는 프로젝트 settings.webhooks 에 저장: [{id,url,events,secret,active}]
import crypto from 'node:crypto';
import { log, metrics } from './logger.js';

// 데이터 변경 등에서 호출. 응답을 기다리지 않고 백그라운드로 발송.
export function fireWebhooks(project, event, payload) {
  const hooks = (project?.settings?.webhooks || []).filter(
    (w) => w.active !== false && (!w.events || !w.events.length || w.events.includes(event))
  );
  for (const w of hooks) deliver(w, event, payload, project.id, 0);
}

async function deliver(w, event, payload, projectId, attempt) {
  const body = JSON.stringify({ event, projectId, data: payload, ts: Date.now() });
  const sig = crypto.createHmac('sha256', w.secret || '').update(body).digest('hex');
  try {
    const res = await fetch(w.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IG-Event': event, 'X-IG-Signature': 'sha256=' + sig, 'User-Agent': 'igServer-webhook' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    metrics.webhooksSent = (metrics.webhooksSent || 0) + 1;
    if (!res.ok && attempt < 2) scheduleRetry(w, event, payload, projectId, attempt);
  } catch (e) {
    metrics.webhooksFailed = (metrics.webhooksFailed || 0) + 1;
    if (attempt < 2) scheduleRetry(w, event, payload, projectId, attempt);
    else log('error', 'webhook failed', { url: w.url, event, err: String(e) });
  }
}

function scheduleRetry(w, event, payload, projectId, attempt) {
  const t = setTimeout(() => deliver(w, event, payload, projectId, attempt + 1), 1000 * (attempt + 1));
  t.unref();
}

// 서명 검증 헬퍼 (수신 측에서 쓰라고 제공, 문서용)
export function verifySignature(body, signatureHeader, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected)); } catch { return false; }
}
