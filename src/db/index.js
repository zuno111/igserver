// 드라이버 선택. DATABASE_URL 있으면 postgres, DB_DRIVER=memory면 메모리, 기본 sqlite.
// sqlite 로드 실패(네이티브 빌드 문제) 시 메모리로 자동 폴백 → 서버는 어떤 환경에서도 뜬다.
import { config } from '../config.js';
import { log } from '../logger.js';
import { createMemoryRepo } from './memory.js';

let repo = null;

export async function initRepo() {
  if (repo) return repo;
  try {
    if (config.dbDriver === 'postgres') {
      const { createPgRepo } = await import('./pg.js');
      repo = await createPgRepo(config);
    } else if (config.dbDriver === 'memory') {
      repo = createMemoryRepo();
    } else {
      const { createSqliteRepo } = await import('./sqlite.js');
      repo = createSqliteRepo(config);
    }
    log('info', 'db ready', { driver: repo.driver });
  } catch (e) {
    log('error', 'db init failed, falling back to memory', { err: String(e) });
    repo = createMemoryRepo();
  }
  return repo;
}

export function getRepo() {
  if (!repo) throw new Error('repo not initialized — call initRepo() first');
  return repo;
}
