// 클러스터 모드. 같은 설치물을 여러 노드(라즈베리파이/PC 혼합)에 깔고 역할만 지정.
//  - worker: 게이트웨이에 자동 등록(하트비트). 실제 요청 처리.
//  - gateway: 워커들에 HTTP/WebSocket 요청을 분배하는 리버스 프록시.
//  - standalone(기본): 혼자 전부 처리.
// 수평 확장의 정석은 여러 워커가 같은 PostgreSQL을 공유하는 것(DATABASE_URL). 게이트웨이는 그 앞단 분배기.
import http from 'node:http';
import os from 'node:os';
import { log } from './logger.js';

// ---------------- 워커: 게이트웨이에 등록 ----------------
export function startWorkerHeartbeat({ gatewayUrl, selfUrl, label }) {
  if (!gatewayUrl || !selfUrl) {
    log('error', 'worker needs GATEWAY_URL and SELF_URL');
    return;
  }
  const nodeId = 'node_' + os.hostname() + '_' + (process.env.PORT || '8787');
  async function beat() {
    try {
      const load = os.loadavg()[0] / (os.cpus().length || 1); // 코어당 부하
      const body = JSON.stringify({ id: nodeId, url: selfUrl, label: label || os.hostname(), load, mode: 'worker',
        meta: { cpus: os.cpus().length, mem: os.totalmem(), hostname: os.hostname() } });
      await fetch(gatewayUrl.replace(/\/$/, '') + '/cluster/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cluster-Secret': process.env.CLUSTER_SECRET || '' }, body,
      });
    } catch (e) { log('error', 'heartbeat failed', { err: String(e) }); }
  }
  beat();
  const iv = setInterval(beat, 5000);
  iv.unref();
  log('info', 'worker registered to gateway', { gatewayUrl, selfUrl, nodeId });
}

// ---------------- 게이트웨이: 리버스 프록시 ----------------
export function createGateway({ port, host, clusterSecret }) {
  const nodes = new Map(); // id -> { url, load, label, lastSeen, mode, meta }
  let rrIndex = 0;

  function aliveNodes() {
    const now = Date.now();
    return [...nodes.values()].filter((n) => now - n.lastSeen < 15000);
  }
  // 최소 부하 노드 선택 (동률이면 라운드로빈)
  function pickNode() {
    const alive = aliveNodes();
    if (!alive.length) return null;
    alive.sort((a, b) => a.load - b.load);
    const minLoad = alive[0].load;
    const candidates = alive.filter((n) => n.load <= minLoad + 0.1);
    const node = candidates[rrIndex % candidates.length];
    rrIndex++;
    return node;
  }

  const server = http.createServer((req, res) => {
    // 게이트웨이 자체 엔드포인트
    if (req.url === '/cluster/heartbeat' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        if (clusterSecret && req.headers['x-cluster-secret'] !== clusterSecret) {
          res.writeHead(403); return res.end('{"error":"bad_secret"}');
        }
        try {
          const n = JSON.parse(body);
          nodes.set(n.id, { ...n, lastSeen: Date.now() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, peers: aliveNodes().length }));
        } catch { res.writeHead(400); res.end('{"error":"bad_json"}'); }
      });
      return;
    }
    if (req.url === '/cluster/nodes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ nodes: aliveNodes(), total: nodes.size }));
    }
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }

    // 나머지는 워커로 프록시
    const target = pickNode();
    if (!target) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"no_worker","message":"가용 워커 노드가 없습니다."}'); }
    proxyHttp(req, res, target.url);
  });

  // WebSocket 업그레이드도 프록시
  server.on('upgrade', (req, socket, head) => {
    const target = pickNode();
    if (!target) { socket.destroy(); return; }
    proxyWs(req, socket, head, target.url);
  });

  server.listen(port, host, () => {
    log('info', `게이트웨이 시작 http://${host}:${port} (워커들에 분배)`, {});
  });
  return server;
}

function proxyHttp(req, res, targetBase) {
  const u = new URL(req.url, targetBase);
  const opts = { method: req.method, headers: { ...req.headers, host: u.host }, hostname: u.hostname, port: u.port, path: u.pathname + u.search };
  const pr = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('{"error":"bad_gateway"}'); });
  req.pipe(pr);
}

function proxyWs(req, socket, head, targetBase) {
  const u = new URL(req.url, targetBase);
  const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: req.headers };
  const pr = http.request(opts);
  pr.on('upgrade', (pres, psocket, phead) => {
    const headers = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(pres.headers)) headers.push(`${k}: ${v}`);
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    if (phead?.length) socket.write(phead);
    psocket.pipe(socket); socket.pipe(psocket);
    psocket.on('error', () => socket.destroy());
    socket.on('error', () => psocket.destroy());
  });
  pr.on('error', () => socket.destroy());
  if (head?.length) pr.write(head);
  pr.end();
}
