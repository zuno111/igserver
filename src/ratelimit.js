// Rate limit. 인메모리 토큰버킷(고정 윈도우). 다중 노드 공유가 필요하면 PG 기반으로 확장 가능.
import { metrics } from './logger.js';
import { getLimits } from './quota.js';

const buckets = new Map(); // key -> { count, resetAt }
const pbuckets = new Map(); // 프로젝트별 분당 버킷

// 플랜 기반 프로젝트별 요청 한도 (resolveProject 뒤에 사용)
export function projectRateLimit() {
  return (req, res, next) => {
    if (!req.project) return next();
    const limits = getLimits(req.project);
    if (limits.rateMax === Infinity) return next();
    const now = Date.now();
    let b = pbuckets.get(req.project.id);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + 60000 }; pbuckets.set(req.project.id, b); }
    b.count++;
    res.setHeader('X-Plan-RateLimit', limits.rateMax);
    res.setHeader('X-Plan-RateLimit-Remaining', Math.max(0, limits.rateMax - b.count));
    if (b.count > limits.rateMax) {
      metrics.rateLimited++;
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'plan_rate_limited', message: '플랜 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.' });
    }
    next();
  };
}

export function rateLimit({ windowMs, max, keyBy = 'ip' }) {
  return (req, res, next) => {
    const now = Date.now();
    let id;
    if (keyBy === 'user') id = 'u:' + (req.user?.uid || req.ip);
    else if (keyBy === 'project') id = 'p:' + (req.project?.id || req.ip);
    else id = 'ip:' + req.ip;
    const key = `${req.baseUrl || ''}${req.path}|${id}`;

    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.count++;

    const remaining = Math.max(0, max - b.count);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    if (b.count > max) {
      metrics.rateLimited++;
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    }
    next();
  };
}

// 주기적 정리 (메모리 누수 방지)
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60000);
cleanup.unref();
