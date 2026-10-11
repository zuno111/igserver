// 프로젝트별 회원가입/로그인/내 정보. 각 프로젝트는 독립된 유저 풀을 가진다.
import { Router } from 'express';
import { getRepo } from '../db/index.js';
import { hashPassword, verifyPassword, signToken, verifyToken, signResetToken } from '../auth.js';
import { requireUser } from '../middleware/auth.js';
import { rateLimit } from '../ratelimit.js';
import { getLimits, quotaError } from '../quota.js';
import { fireWebhooks } from '../webhooks.js';
import { config, randomId } from '../config.js';

const router = Router();
const authLimit = rateLimit({ windowMs: config.rlWindowMs, max: config.rlAuthMax, keyBy: 'ip' });

function emailValid(e) { return typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

// 회원가입
router.post('/signup', authLimit, async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    if (!emailValid(email)) return res.status(400).json({ error: 'bad_email', message: '이메일 형식이 올바르지 않습니다.' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'weak_password', message: '비밀번호는 6자 이상이어야 합니다.' });

    const repo = getRepo();
    const exists = await repo.getUserByEmail(req.project.id, email);
    if (exists) return res.status(409).json({ error: 'email_taken', message: '이미 가입된 이메일입니다.' });
    // 쿼터: 유저 수 한도
    const limits = getLimits(req.project);
    if (limits.maxUsers !== Infinity && (await repo.countUsers(req.project.id)) >= limits.maxUsers) return quotaError(res, 'users', limits.maxUsers);

    const user = await repo.createUser({
      id: randomId('u_'), project_id: req.project.id, email,
      password_hash: await hashPassword(password), name: name || email.split('@')[0], role: 'user',
    });
    await repo.addAudit({ id: randomId('a_'), project_id: req.project.id, actor_id: user.id, action: 'signup', ip: req.ip });
    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) { next(e); }
});

// 로그인
router.post('/login', authLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const repo = getRepo();
    const user = await repo.getUserByEmail(req.project.id, email || '');
    if (!user || !(await verifyPassword(password || '', user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials', message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }
    await repo.addAudit({ id: randomId('a_'), project_id: req.project.id, actor_id: user.id, action: 'login', ip: req.ip });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { next(e); }
});

// 내 정보
router.get('/me', requireUser, async (req, res, next) => {
  try {
    const user = await getRepo().getUser(req.user.uid);
    if (!user) return res.status(404).json({ error: 'not_found' });
    res.json({ user: publicUser(user) });
  } catch (e) { next(e); }
});

// 비밀번호 변경
router.post('/change-password', requireUser, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'weak_password', message: '새 비밀번호는 6자 이상이어야 합니다.' });
    const repo = getRepo();
    const user = await repo.getUser(req.user.uid);
    if (!user || !(await verifyPassword(oldPassword || '', user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials', message: '현재 비밀번호가 올바르지 않습니다.' });
    }
    await repo.updateUser(user.id, { password_hash: await hashPassword(newPassword) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 비밀번호 재설정 요청: 재설정 토큰을 웹훅('auth.password_reset')으로 보냄 (이메일 발송은 수신 측 담당)
router.post('/request-reset', authLimit, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const repo = getRepo();
    const user = email ? await repo.getUserByEmail(req.project.id, email) : null;
    if (user) {
      const token = signResetToken(user);
      fireWebhooks(req.project, 'auth.password_reset', { email: user.email, userId: user.id, token });
      await repo.addAudit({ id: randomId('a_'), project_id: req.project.id, actor_id: user.id, action: 'reset_requested', ip: req.ip });
    }
    // 이메일 존재 여부를 노출하지 않도록 항상 동일 응답
    res.json({ ok: true, message: '재설정 안내를 전송했습니다.' });
  } catch (e) { next(e); }
});

// 비밀번호 재설정 실행: 토큰 + 새 비밀번호
router.post('/reset', authLimit, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'weak_password', message: '새 비밀번호는 6자 이상이어야 합니다.' });
    const payload = verifyToken(token || '');
    if (!payload || payload.purpose !== 'reset' || payload.pid !== req.project.id) return res.status(401).json({ error: 'bad_token', message: '재설정 토큰이 유효하지 않거나 만료되었습니다.' });
    const repo = getRepo();
    const user = await repo.getUser(payload.uid);
    if (!user || user.project_id !== req.project.id) return res.status(404).json({ error: 'not_found' });
    await repo.updateUser(user.id, { password_hash: await hashPassword(newPassword) });
    await repo.addAudit({ id: randomId('a_'), project_id: req.project.id, actor_id: user.id, action: 'password_reset', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at }; }

export default router;
