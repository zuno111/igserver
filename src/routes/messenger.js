// 메신저. 설치(접속)만 하면 가입 없이 기기 신원을 발급받아 메시지/파일을 주고받는다.
// 재사용: 실시간은 realtime(room 브로드캐스트), 저장은 레코드(_mmsg/_mroom), 파일은 /api/files.
// 기기 신원 = 익명 유저. deviceId(랜덤 비밀)만 보관하면 재접속 시 같은 신원 유지.
import { Router } from 'express';
import crypto from 'node:crypto';
import { getRepo } from '../db/index.js';
import { requireUser } from '../middleware/auth.js';
import { signToken, hashPassword } from '../auth.js';
import { broadcast } from '../realtime.js';
import { randomId } from '../config.js';

const router = Router();
const MSG = '_mmsg';    // 메시지
const ROOM = '_mroom';  // 방
const deviceEmail = (deviceId) => `dev_${deviceId}@device.local`;
const personalRoom = (uid) => `u:${uid}`;
const safeRoom = (s) => typeof s === 'string' && /^[A-Za-z0-9_:\-.]{1,128}$/.test(s);

// 방 식별자 → 레코드 doc_id (결정적)
const roomDoc = (room) => 'r_' + crypto.createHash('sha1').update(room).digest('hex').slice(0, 24);
// DM 방 이름: 두 기기 uid를 정렬해 고정
const dmRoom = (a, b) => 'dm_' + [a, b].sort().join('__');

async function getRoom(pid, room) { return getRepo().getRecord(pid, ROOM, roomDoc(room)); }
async function upsertRoom(pid, room, patch, ownerId) {
  const ex = await getRoom(pid, room);
  const data = { room, kind: 'group', title: room, members: [], ...(ex?.data || {}), ...patch };
  return getRepo().putRecord({ project_id: pid, collection: ROOM, doc_id: roomDoc(room), data, owner_id: ex?.owner_id || ownerId });
}

// 기기 등록(가입 없음): deviceId 있으면 그 신원 복원, 없으면 새로 발급.
router.post('/register', async (req, res, next) => {
  try {
    const repo = getRepo();
    let deviceId = typeof req.body?.deviceId === 'string' && /^[A-Za-z0-9_\-]{8,64}$/.test(req.body.deviceId) ? req.body.deviceId : null;
    const wantName = (typeof req.body?.name === 'string' && req.body.name.trim().slice(0, 40)) || null;
    let user = deviceId ? await repo.getUserByEmail(req.project.id, deviceEmail(deviceId)) : null;
    if (!user) {
      if (!deviceId) deviceId = randomId('dev').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
      const name = wantName || ('기기-' + deviceId.slice(-4));
      user = await repo.createUser({
        id: randomId('u_'), project_id: req.project.id, email: deviceEmail(deviceId),
        password_hash: await hashPassword(crypto.randomBytes(16).toString('hex')),
        name, role: 'user', meta: { device: true, deviceId },
      });
    } else if (wantName && wantName !== user.name) {
      user = await repo.updateUser(user.id, { name: wantName });
    }
    const token = signToken(user);
    res.json({ deviceId, token, user: { id: user.id, name: user.name } });
  } catch (e) { next(e); }
});

// 그룹 방 만들기(자유): POST /rooms { title }
router.post('/rooms', requireUser, async (req, res, next) => {
  try {
    const title = (typeof req.body?.title === 'string' && req.body.title.trim().slice(0, 60)) || '새 대화방';
    const room = 'g_' + randomId('').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const rec = await upsertRoom(req.project.id, room, { kind: 'group', title, members: [req.user.uid] }, req.user.uid);
    res.status(201).json({ room: outRoom(rec) });
  } catch (e) { next(e); }
});

// DM 방 열기(없으면 생성): POST /dm { peerDeviceId }
router.post('/dm', requireUser, async (req, res, next) => {
  try {
    const peerId = req.body?.peerDeviceId;
    if (!peerId) return res.status(400).json({ error: 'no_peer', message: '상대 기기 ID가 필요합니다.' });
    const peer = await getRepo().getUserByEmail(req.project.id, deviceEmail(String(peerId)));
    if (!peer) return res.status(404).json({ error: 'peer_not_found', message: '상대 기기를 찾을 수 없습니다.' });
    const room = dmRoom(req.user.uid, peer.id);
    const rec = await upsertRoom(req.project.id, room, { kind: 'dm', title: '', members: [req.user.uid, peer.id] }, req.user.uid);
    res.json({ room: outRoom(rec, req.user.uid, { [peer.id]: peer.name, [req.user.uid]: req.user.name }) });
  } catch (e) { next(e); }
});

// 내 방 목록: GET /rooms
router.get('/rooms', requireUser, async (req, res, next) => {
  try {
    const rooms = await getRepo().queryRecords(req.project.id, ROOM, { limit: 1000, sort: { field: 'lastTs', dir: 'desc' } });
    const mine = rooms.filter((r) => r.data.kind === 'group' || (r.data.members || []).includes(req.user.uid));
    // DM 상대 이름 해석
    const names = {};
    for (const r of mine) for (const m of r.data.members || []) names[m] = names[m] || null;
    const users = await getRepo().listUsers(req.project.id, { limit: 5000 });
    for (const u of users) if (u.id in names) names[u.id] = u.name;
    res.json({ rooms: mine.map((r) => outRoom(r, req.user.uid, names)) });
  } catch (e) { next(e); }
});

// 메시지 전송: POST /send { room, text?, file? }  file={id,name,size,mime}
router.post('/send', requireUser, async (req, res, next) => {
  try {
    const room = req.body?.room;
    if (!safeRoom(room)) return res.status(400).json({ error: 'bad_room' });
    const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 8000) : '';
    const file = req.body?.file && typeof req.body.file === 'object' ? {
      id: String(req.body.file.id || ''), name: String(req.body.file.name || '파일').slice(0, 200),
      size: Number(req.body.file.size) || 0, mime: String(req.body.file.mime || ''),
    } : null;
    if (!text && !file) return res.status(400).json({ error: 'empty', message: '내용이나 파일이 필요합니다.' });
    const ts = Date.now();
    const docId = randomId('m_');
    const data = { room, text, file, from: req.user.uid, name: req.user.name, ts };
    await getRepo().putRecord({ project_id: req.project.id, collection: MSG, doc_id: docId, data, owner_id: req.user.uid });
    // 방 갱신(참여자 추가 + 마지막 메시지)
    const existing = await getRoom(req.project.id, room);
    const members = new Set([...(existing?.data.members || []), req.user.uid]);
    const roomRec = await upsertRoom(req.project.id, room, {
      members: [...members], lastText: file ? (text || '📎 ' + file.name) : text, lastFrom: req.user.name, lastTs: ts,
    }, req.user.uid);
    const msg = { type: 'message', id: docId, room, text, file, from: req.user.uid, name: req.user.name, ts };
    broadcast(req.project.id, room, msg);                       // 방 구독자에게 즉시 전달
    for (const uid of members) broadcast(req.project.id, personalRoom(uid), { type: 'inbox', room, lastText: roomRec.data.lastText, from: req.user.name, ts }); // 개인함 알림
    res.status(201).json({ message: msg });
  } catch (e) { next(e); }
});

// 히스토리: GET /history?room=&limit=&before=  (before=ts 이전으로 페이지네이션)
router.get('/history', requireUser, async (req, res, next) => {
  try {
    const room = req.query.room;
    if (!safeRoom(room)) return res.status(400).json({ error: 'bad_room' });
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const filters = [{ field: 'room', op: 'eq', value: room }];
    if (req.query.before) filters.push({ field: 'ts', op: 'lt', value: Number(req.query.before) });
    const rows = await getRepo().queryRecords(req.project.id, MSG, { filters, sort: { field: 'ts', dir: 'desc' }, limit });
    const items = rows.map((r) => ({ id: r.doc_id, ...r.data })).reverse(); // 오래된→최신
    res.json({ room, messages: items });
  } catch (e) { next(e); }
});

function outRoom(r, meUid, names = {}) {
  const d = r.data;
  let title = d.title;
  if (d.kind === 'dm' && meUid) {
    const peer = (d.members || []).find((m) => m !== meUid);
    title = (peer && names[peer]) || '1:1 대화';
  }
  return { room: d.room, kind: d.kind, title, members: d.members || [], lastText: d.lastText || '', lastFrom: d.lastFrom || '', lastTs: d.lastTs || r.created_at };
}

export default router;
