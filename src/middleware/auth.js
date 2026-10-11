// 인증 미들웨어. Bearer 토큰 → req.user. 프로젝트 스코프 검증(토큰의 pid == 현재 프로젝트).
import { verifyToken } from '../auth.js';

export function requireUser(req, res, next) {
  // 비밀키/범위키 인증은 서버 측 접근 (토큰 불필요). 범위 제한은 enforceKeyScope가 담당.
  if (req.projectAuth === 'secret' || req.projectAuth === 'scoped') {
    if (!req.user) req.user = { uid: '__server__', role: 'admin', pid: req.project?.id, name: 'server' };
    return next();
  }
  const auth = req.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'no_token', message: '로그인이 필요합니다.' });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'bad_token', message: '토큰이 유효하지 않습니다.' });
  // 프로젝트 스코프 교차 검증: 다른 프로젝트 토큰으로 이 프로젝트 접근 차단
  if (req.project && payload.pid && payload.pid !== req.project.id) {
    return res.status(403).json({ error: 'scope_mismatch', message: '다른 프로젝트의 토큰입니다.' });
  }
  req.user = payload;
  next();
}

// 선택적 인증: 토큰 있으면 req.user 채우고, 없어도 통과
export function optionalUser(req, _res, next) {
  if ((req.projectAuth === 'secret' || req.projectAuth === 'scoped') && !req.user) req.user = { uid: '__server__', role: 'admin', pid: req.project?.id, name: 'server' };
  const auth = req.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    const payload = verifyToken(auth.slice(7));
    if (payload && (!req.project || !payload.pid || payload.pid === req.project.id)) req.user = payload;
  }
  next();
}

// 관리자 전용 (대시보드 API). req.admin = {uid,email,role}
export function requireAdmin(req, res, next) {
  const auth = req.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'no_token', message: '관리자 로그인이 필요합니다.' });
  const payload = verifyToken(auth.slice(7));
  if (!payload?.admin) return res.status(403).json({ error: 'not_admin', message: '관리자 권한이 필요합니다.' });
  req.admin = payload;
  next();
}

// 역할 최소 등급 검사 (requireAdmin 뒤에 체인). owner > admin > viewer
const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
export function requireRole(min) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'no_token', message: '관리자 로그인이 필요합니다.' });
    if ((ROLE_RANK[req.admin.role] || 0) < (ROLE_RANK[min] || 99)) {
      return res.status(403).json({ error: 'insufficient_role', message: `${min} 이상 권한이 필요합니다. (현재: ${req.admin.role})` });
    }
    next();
  };
}
