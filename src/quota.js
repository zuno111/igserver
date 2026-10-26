// 사용량 쿼터 + 플랜. 프로젝트별 데이터·유저·파일용량·요청 한도.
// 플랜은 프로젝트 settings.plan, 개별 조정은 settings.limits 로 오버라이드.
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const PLANS = {
  free: { maxRecords: 1000, maxUsers: 100, maxFileBytes: 50 * MB, rateMax: 120 },
  pro: { maxRecords: 100000, maxUsers: 10000, maxFileBytes: 5 * GB, rateMax: 600 },
  unlimited: { maxRecords: Infinity, maxUsers: Infinity, maxFileBytes: Infinity, rateMax: Infinity },
};

export function getLimits(project) {
  const plan = project?.settings?.plan || 'free';
  const base = PLANS[plan] || PLANS.free;
  const over = project?.settings?.limits || {};
  // 오버라이드 값은 숫자만 반영
  const merged = { ...base };
  for (const k of ['maxRecords', 'maxUsers', 'maxFileBytes', 'rateMax']) {
    if (typeof over[k] === 'number' && over[k] >= 0) merged[k] = over[k];
  }
  // 전역 요청 한도 상향(자체 호스팅/테스트): 환경변수 PLAN_RATE_MAX
  const envRate = Number(process.env.PLAN_RATE_MAX);
  if (Number.isFinite(envRate) && envRate > 0) merged.rateMax = Math.max(merged.rateMax, envRate);
  return { plan, ...merged };
}

// 사용량 집계 (프로젝트 현재 사용량)
export async function getUsage(repo, project) {
  const limits = getLimits(project);
  const [records, users, fileBytes] = await Promise.all([
    repo.countRecords(project.id),
    repo.countUsers(project.id),
    repo.sumFileBytes(project.id),
  ]);
  return {
    plan: limits.plan,
    records, users, fileBytes,
    limits: {
      maxRecords: num(limits.maxRecords), maxUsers: num(limits.maxUsers),
      maxFileBytes: num(limits.maxFileBytes), rateMax: num(limits.rateMax),
    },
    pct: {
      records: pct(records, limits.maxRecords),
      users: pct(users, limits.maxUsers),
      fileBytes: pct(fileBytes, limits.maxFileBytes),
    },
  };
}
function num(v) { return v === Infinity ? null : v; } // JSON에 Infinity 못 담음 → null = 무제한
function pct(used, max) { return max === Infinity ? 0 : Math.min(100, Math.round((used / max) * 100)); }

export function quotaError(res, kind, limit) {
  return res.status(402).json({ error: 'quota_exceeded', kind, limit: num(limit), message: `${kind} 한도(${num(limit)})를 초과했습니다. 플랜을 업그레이드하세요.` });
}
