// JSON 구조화 로그 + Prometheus 메트릭 (/metrics)
const t0 = Date.now();

export const metrics = {
  requests: 0,
  requestsByStatus: {}, // 2xx/4xx/5xx
  errors: 0,
  wsConnections: 0,
  wsActive: 0,
  broadcasts: 0,
  rateLimited: 0,
  latencies: [], // 최근 샘플 (p50/p95/p99 계산용), 최대 1000개
};

// 분당 요청 시계열 (최근 30분)
const series = [];
function bumpSeries() {
  const m = Math.floor(Date.now() / 60000);
  if (!series.length || series[series.length - 1].m !== m) { series.push({ m, c: 0 }); while (series.length > 30) series.shift(); }
  series[series.length - 1].c++;
}
export function requestSeries() {
  const now = Math.floor(Date.now() / 60000);
  // 최근 30분을 빈 분까지 0으로 채워 반환
  const map = Object.fromEntries(series.map((s) => [s.m, s.c]));
  const out = [];
  for (let i = 29; i >= 0; i--) out.push({ minuteAgo: i, count: map[now - i] || 0 });
  return out;
}

export function log(level, msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// 요청 로깅 + 지연 측정 미들웨어
export function requestLogger() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const rid = Math.random().toString(36).slice(2, 10);
    req.rid = rid;
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      metrics.requests++;
      bumpSeries();
      const bucket = `${Math.floor(res.statusCode / 100)}xx`;
      metrics.requestsByStatus[bucket] = (metrics.requestsByStatus[bucket] || 0) + 1;
      if (res.statusCode >= 500) metrics.errors++;
      metrics.latencies.push(ms);
      if (metrics.latencies.length > 1000) metrics.latencies.shift();
      log('info', 'req', {
        rid,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        project: req.project?.id || null,
      });
    });
    next();
  };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 10) / 10;
}

// Prometheus 텍스트 포맷
export function renderMetrics() {
  const lines = [];
  lines.push('# HELP ig_requests_total 총 HTTP 요청 수');
  lines.push('# TYPE ig_requests_total counter');
  lines.push(`ig_requests_total ${metrics.requests}`);
  for (const [k, v] of Object.entries(metrics.requestsByStatus)) {
    lines.push(`ig_requests_by_status{status="${k}"} ${v}`);
  }
  lines.push(`ig_errors_total ${metrics.errors}`);
  lines.push(`ig_rate_limited_total ${metrics.rateLimited}`);
  lines.push('# HELP ig_ws_connections_total 누적 WS 연결 수');
  lines.push(`ig_ws_connections_total ${metrics.wsConnections}`);
  lines.push('# HELP ig_ws_active 현재 활성 WS 연결 수');
  lines.push(`ig_ws_active ${metrics.wsActive}`);
  lines.push(`ig_broadcasts_total ${metrics.broadcasts}`);
  lines.push(`ig_request_latency_ms{quantile="0.5"} ${percentile(metrics.latencies, 50)}`);
  lines.push(`ig_request_latency_ms{quantile="0.95"} ${percentile(metrics.latencies, 95)}`);
  lines.push(`ig_request_latency_ms{quantile="0.99"} ${percentile(metrics.latencies, 99)}`);
  lines.push(`ig_uptime_seconds ${Math.round((Date.now() - t0) / 1000)}`);
  return lines.join('\n') + '\n';
}

// 대시보드용 요약 (JSON)
export function metricsSummary() {
  return {
    requests: metrics.requests,
    byStatus: metrics.requestsByStatus,
    errors: metrics.errors,
    rateLimited: metrics.rateLimited,
    wsActive: metrics.wsActive,
    wsConnections: metrics.wsConnections,
    broadcasts: metrics.broadcasts,
    latency: {
      p50: percentile(metrics.latencies, 50),
      p95: percentile(metrics.latencies, 95),
      p99: percentile(metrics.latencies, 99),
    },
    uptimeSeconds: Math.round((Date.now() - t0) / 1000),
  };
}
