// JWT 발급/검증 + bcrypt 해싱 (bcryptjs = 순수 JS, 네이티브 빌드 회피)
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

// 토큰에 프로젝트 스코프를 담아 발급. 프로젝트별 유저 격리.
export function signToken(user) {
  return jwt.sign(
    { uid: user.id, pid: user.project_id, email: user.email, name: user.name, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

// 동기 검증 (WS 핸드셰이크에서도 사용)
export function verifyToken(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch { return null; }
}

// 비밀번호 재설정 토큰 (짧은 만료, purpose로 용도 제한)
export function signResetToken(user) {
  return jwt.sign({ uid: user.id, pid: user.project_id, purpose: 'reset' }, config.jwtSecret, { expiresIn: '15m' });
}

// 관리자 토큰 (대시보드). 프로젝트 스코프 없이 전역. role: owner|admin|viewer
export function signAdminToken(admin) {
  return jwt.sign({ uid: admin.id, email: admin.email, role: admin.role || 'admin', admin: true }, config.jwtSecret, { expiresIn: '1d' });
}
