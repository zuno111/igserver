// 프로젝트 식별 미들웨어. API 키로 프로젝트를 찾아 req.project에 주입 → 데이터 격리의 핵심.
// 키 전달 방법: X-Project-Key 헤더 / ?key= 쿼리 / Authorization: Bearer 토큰 안의 pid
import { getRepo } from '../db/index.js';
import { verifyToken } from '../auth.js';

export async function resolveProject(req, res, next) {
  try {
    const repo = getRepo();
    let project = null;

    const key = req.get('X-Project-Key') || req.query.key;
    if (key) {
      project = await repo.getProjectByKey(key);
      if (project) req.projectAuth = 'public';
      else { project = await repo.getProjectBySecretKey(key); if (project) req.projectAuth = 'secret'; }
      // 추가 발급 키(범위 제한 키) 탐색
      if (!project) {
        const scoped = await findScopedKey(repo, key);
        if (scoped) {
          if (scoped.keyDef.expiresAt && Date.now() > scoped.keyDef.expiresAt) {
            return res.status(401).json({ error: 'key_expired', message: '만료된 API 키입니다.' });
          }
          project = scoped.project;
          req.projectAuth = 'scoped';
          req.keyScope = { mode: scoped.keyDef.mode || 'write', collections: scoped.keyDef.collections || null };
        }
      }
    }

    // 키가 없으면 토큰 안의 프로젝트 ID로
    if (!project) {
      const auth = req.get('Authorization');
      if (auth?.startsWith('Bearer ')) {
        const payload = verifyToken(auth.slice(7));
        if (payload?.pid) project = await repo.getProject(payload.pid);
      }
    }

    if (!project) return res.status(401).json({ error: 'no_project', message: '프로젝트 키가 필요합니다 (X-Project-Key).' });
    if (project.status !== 'active') return res.status(403).json({ error: 'project_disabled', message: '비활성화된 프로젝트입니다.' });

    req.project = project;
    next();
  } catch (e) {
    next(e);
  }
}

// settings.apiKeys 안에서 키 탐색 (내부 인프라 규모 — 프로젝트 스캔 허용)
async function findScopedKey(repo, key) {
  const projects = await repo.listProjects();
  for (const p of projects) {
    for (const k of (p.settings?.apiKeys || [])) {
      if (k.key === key) return { project: p, keyDef: k };
    }
  }
  return null;
}

// 범위 제한 키 가드: /api/data, /api/files 에 적용. 읽기전용·컬렉션 제한 강제.
export function enforceKeyScope(req, res, next) {
  const scope = req.keyScope;
  if (!scope) return next();
  const isWrite = req.method !== 'GET';
  if (isWrite && scope.mode === 'read') {
    return res.status(403).json({ error: 'read_only_key', message: '이 키는 읽기 전용입니다.' });
  }
  if (scope.collections && scope.collections.length) {
    const coll = req.params.collection || (req.path.split('/').filter(Boolean)[0]);
    if (coll && !scope.collections.includes(coll)) {
      return res.status(403).json({ error: 'collection_not_allowed', message: `이 키는 ${scope.collections.join(', ')} 컬렉션만 접근할 수 있습니다.` });
    }
  }
  next();
}
