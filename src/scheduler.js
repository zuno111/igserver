// 서버측 스케줄러. 프로젝트별 예약 작업을 간격(분) 기반으로 실행한다.
// job 정의는 프로젝트 settings.jobs = [{id, type, intervalMin, collection?, olderThanDays?, active, lastRun, lastResult}]
// type: cleanup_old(오래된 레코드 소프트삭제) | empty_trash(휴지통 영구삭제) | webhook_ping(웹훅으로 tick 발송)
import { getRepo } from './db/index.js';
import { fireWebhooks } from './webhooks.js';
import { log } from './logger.js';

let timer = null;

export function startScheduler() {
  const tick = async () => { try { await runDueJobs(); } catch (e) { log('error', 'scheduler tick failed', { err: String(e) }); } };
  tick(); // 시작 시 1회
  timer = setInterval(tick, 60000); // 1분마다
  timer.unref();
  log('info', 'scheduler ready (1분 주기)', {});
}

const SYS = '__system__';

export async function runDueJobs() {
  const repo = getRepo();
  const projects = (await repo.listProjects()).filter((p) => p.id !== SYS);
  const now = Date.now();
  for (const p of projects) {
    const jobs = p.settings?.jobs || [];
    if (!jobs.length) continue;
    let changed = false;
    for (const job of jobs) {
      if (job.active === false) continue;
      const due = !job.lastRun || (now - job.lastRun) >= (job.intervalMin || 60) * 60000;
      if (!due) continue;
      const result = await runJob(repo, p, job).catch((e) => ({ ok: false, error: String(e.message || e) }));
      job.lastRun = Date.now();
      job.lastResult = result;
      changed = true;
    }
    if (changed) {
      // 최신 프로젝트를 다시 읽어 settings 병합(다른 변경과 충돌 최소화)
      const fresh = await repo.getProject(p.id);
      if (fresh) await repo.updateProject(p.id, { settings: { ...fresh.settings, jobs } }).catch(() => {});
    }
  }
}

export async function runJob(repo, project, job) {
  if (job.type === 'cleanup_old') {
    if (!job.collection) return { ok: false, error: 'no_collection' };
    const days = job.olderThanDays ?? 30;
    const cutoff = Date.now() - days * 86400000 + (days === 0 ? 1000 : 0); // 0일이면 현재까지 포함
    const n = await repo.sweepOldRecords(project.id, job.collection, cutoff);
    if (n) log('info', 'job cleanup_old', { project: project.id, collection: job.collection, removed: n });
    return { ok: true, removed: n, at: Date.now() };
  }
  if (job.type === 'empty_trash') {
    const days = job.olderThanDays ?? 30;
    const cutoff = Date.now() - days * 86400000 + (days === 0 ? 1000 : 0);
    const n = await repo.purgeTrash(project.id, cutoff);
    if (n) log('info', 'job empty_trash', { project: project.id, purged: n });
    return { ok: true, purged: n, at: Date.now() };
  }
  if (job.type === 'webhook_ping') {
    fireWebhooks(project, 'scheduled.tick', { jobId: job.id, at: Date.now() });
    return { ok: true, sent: true, at: Date.now() };
  }
  return { ok: false, error: 'unknown_type' };
}
