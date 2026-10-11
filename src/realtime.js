// WebSocket 실시간 계층. 프로젝트별 방(room) 구독 + 브로드캐스트.
// 채팅/프레즌스/실시간 데이터 동기화에 사용. 토큰으로 인증, 방 이름은 프로젝트 스코프로 격리.
import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';
import { getRepo } from './db/index.js';
import { metrics, log } from './logger.js';

// room key: projectId|roomName → Set<ws>
const rooms = new Map();
let _wss = null;

// 프로젝트별 현재 접속자 수 (presence)
export function presenceStats() {
  const stats = {};
  if (!_wss) return stats;
  for (const ws of _wss.clients) {
    if (ws.pid && ws.readyState === 1) stats[ws.pid] = (stats[ws.pid] || 0) + 1;
  }
  return stats;
}

// 프로젝트의 현재 접속자 상세 (관리자/앱용). 유저별로 묶고 연결 수·마지막 활동 포함.
export function presenceList(pid) {
  if (!_wss) return [];
  const byUser = new Map();
  for (const ws of _wss.clients) {
    if (ws.pid !== pid || ws.readyState !== 1) continue;
    const key = ws.uid || ('anon:' + ws.connId);
    if (!byUser.has(key)) byUser.set(key, { uid: ws.uid || null, name: ws.name || '익명', connections: 0, rooms: new Set(), connectedAt: ws.connectedAt, lastSeen: ws.lastSeen });
    const u = byUser.get(key);
    u.connections++;
    for (const r of ws.roomNames) u.rooms.add(r);
    u.connectedAt = Math.min(u.connectedAt, ws.connectedAt);
    u.lastSeen = Math.max(u.lastSeen, ws.lastSeen);
  }
  return [...byUser.values()].map((u) => ({ ...u, rooms: [...u.rooms] })).sort((a, b) => a.connectedAt - b.connectedAt);
}

// 특정 방의 접속자 명단 (중복 유저 1명으로)
export function roomPresence(pid, room) {
  const set = rooms.get(roomKey(pid, room));
  if (!set) return [];
  const seen = new Map();
  for (const ws of set) {
    if (ws.readyState !== 1) continue;
    const key = ws.uid || ('anon:' + ws.connId);
    if (!seen.has(key)) seen.set(key, { uid: ws.uid || null, name: ws.name || '익명', since: ws.connectedAt });
  }
  return [...seen.values()];
}

// 방 구독자에게 presence 갱신 알림
function emitRoomPresence(pid, room) {
  broadcast(pid, room, { type: 'presence', room, members: roomPresence(pid, room), ts: Date.now() });
}

function roomKey(pid, name) { return `${pid}\u0000${name}`; }

export function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  _wss = wss;

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const projectKey = url.searchParams.get('key');

    // 인증: 유저 토큰 또는 프로젝트 키(익명 구독 허용 시)
    let pid = null, uid = null, name = null;
    const payload = token ? verifyToken(token) : null;
    if (payload) { pid = payload.pid; uid = payload.uid; name = payload.name; }
    if (!pid && projectKey) {
      const proj = await getRepo().getProjectByKey(projectKey);
      if (proj) pid = proj.id;
    }
    if (!pid) { ws.close(4001, 'unauthorized'); return; }

    const now = Date.now();
    ws.pid = pid; ws.uid = uid; ws.name = name; ws.subscriptions = new Set(); ws.roomNames = new Set();
    ws.isAlive = true; ws.connId = (metrics.wsConnections + 1) + '_' + now; ws.connectedAt = now; ws.lastSeen = now;
    metrics.wsConnections++; metrics.wsActive++;
    send(ws, { type: 'connected', uid, pid });

    ws.on('pong', () => { ws.isAlive = true; ws.lastSeen = Date.now(); });

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      ws.lastSeen = Date.now();
      if (msg.type === 'subscribe' && msg.room) {
        const key = roomKey(pid, msg.room);
        if (!rooms.has(key)) rooms.set(key, new Set());
        rooms.get(key).add(ws);
        ws.subscriptions.add(key);
        ws.roomNames.add(msg.room);
        send(ws, { type: 'subscribed', room: msg.room, members: roomPresence(pid, msg.room) });
        emitRoomPresence(pid, msg.room); // 입장 알림
      } else if (msg.type === 'unsubscribe' && msg.room) {
        const key = roomKey(pid, msg.room);
        rooms.get(key)?.delete(ws);
        ws.subscriptions.delete(key);
        ws.roomNames.delete(msg.room);
        emitRoomPresence(pid, msg.room); // 퇴장 알림
      } else if (msg.type === 'publish' && msg.room) {
        // 유저가 방에 메시지 발행 → 같은 방 구독자에게 전달
        broadcast(pid, msg.room, { type: 'message', room: msg.room, from: uid || null, name, data: msg.data, ts: Date.now() });
      } else if (msg.type === 'who' && msg.room) {
        send(ws, { type: 'presence', room: msg.room, members: roomPresence(pid, msg.room), ts: Date.now() });
      } else if (msg.type === 'ping') {
        send(ws, { type: 'pong', ts: Date.now() });
      }
    });

    ws.on('close', () => {
      const leftRooms = [...ws.roomNames];
      for (const key of ws.subscriptions) rooms.get(key)?.delete(ws);
      metrics.wsActive--;
      for (const r of leftRooms) emitRoomPresence(pid, r); // 연결 종료 → presence 갱신
    });
  });

  // keepalive: 죽은 소켓 정리
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30000);
  iv.unref();

  log('info', 'realtime ready', { path: '/ws' });
  return wss;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// 서버 코드(라우트)에서 방에 브로드캐스트. 데이터 변경 알림 등.
export function broadcast(pid, room, payload) {
  const key = roomKey(pid, room);
  const set = rooms.get(key);
  if (!set) return 0;
  metrics.broadcasts++;
  let n = 0;
  for (const ws of set) { send(ws, payload); n++; }
  return n;
}

export function roomStats() {
  const stats = {};
  for (const [key, set] of rooms) {
    const [pid, name] = key.split('\u0000');
    stats[pid] = stats[pid] || {};
    stats[pid][name] = set.size;
  }
  return stats;
}
