// igServer 메인. 웹앱/앱/게임을 한 서버에 올려 실서비스하는 멀티 프로젝트 백엔드.
// MODE=gateway면 리버스 프록시만 띄우고, 그 외엔 전체 서버를 띄운다.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { log, requestLogger, renderMetrics } from './logger.js';
import { initRepo, getRepo } from './db/index.js';
import { attachRealtime, presenceList } from './realtime.js';
import { resolveProject, enforceKeyScope } from './middleware/project.js';
import { rateLimit, projectRateLimit } from './ratelimit.js';
import { getUsage } from './quota.js';
import { startScheduler } from './scheduler.js';
import { createGateway, startWorkerHeartbeat } from './cluster.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import fileRoutes from './routes/files.js';
import nasRoutes from './routes/nas.js';
import adminRoutes, { ensureAdmin } from './routes/admin.js';
import igplayRoutes from './routes/igplay.js';
import igmarketRoutes from './routes/igmarket.js';
import igtokenRoutes from './routes/igtoken.js';
import igstoreRoutes from './routes/igstore.js';
import iggameRoutes from './routes/iggame.js';
import igvideoRoutes from './routes/igvideo.js';
import igsocialRoutes from './routes/igsocial.js';
import igliveRoutes from './routes/iglive.js';
import igvodRoutes from './routes/igvod.js';
import igmapRoutes from './routes/igmap.js';
import messengerRoutes from './routes/messenger.js';
import { ensureIgPlay, igplayInject } from './provision.js';
import { ensureMessenger, messengerInject } from './provision_messenger.js';

const MODE = process.env.MODE || 'standalone';

async function main() {
  // 게이트웨이 모드: 프록시만 띄우고 끝
  if (MODE === 'gateway') {
    createGateway({ port: config.port, host: config.host, clusterSecret: process.env.CLUSTER_SECRET || '' });
    return;
  }

  await initRepo();
  await ensureAdmin(); // 관리자 계정/시스템 프로젝트 보장
  await ensureIgPlay(); // igPlay 프로젝트 자동 프로비전(주소/키 자동 주입용)
  await ensureMessenger(); // 메신저 프로젝트 자동 프로비전

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 보안 헤더
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // CORS (웹앱/앱이 다른 도메인에서 호출). 프로젝트 키 헤더 허용.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.get('Origin') || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Project-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(requestLogger());

  // 헬스체크 (로드밸런서용) + 메트릭
  app.get('/healthz', (_req, res) => res.json({ ok: true, driver: getRepo().driver, mode: MODE }));
  app.get('/metrics', (_req, res) => { res.setHeader('Content-Type', 'text/plain; version=0.0.4'); res.end(renderMetrics()); });

  // 클러스터 하트비트 수신 (게이트웨이가 아니어도 노드 정보를 DB에 기록해 대시보드에서 보이게)
  app.post('/cluster/heartbeat', express.json({ limit: '16kb' }), async (req, res) => {
    if (process.env.CLUSTER_SECRET && req.get('X-Cluster-Secret') !== process.env.CLUSTER_SECRET) return res.status(403).json({ error: 'bad_secret' });
    try { await getRepo().upsertNode(req.body); res.json({ ok: true }); } catch { res.status(400).json({ error: 'bad' }); }
  });

  // ---- 관리자 API (대시보드) ----
  app.use('/admin/api', express.json({ limit: '25mb' }), adminRoutes);

  // ---- 프로젝트 API ----
  // /api/* 는 프로젝트 키로 식별 + 전역 rate limit
  const apiLimit = rateLimit({ windowMs: config.rlWindowMs, max: config.rlMax, keyBy: 'ip' });
  // 파일 라우트는 raw 바디를 쓰므로 json 파서 전에 분기
  app.use('/api/files', apiLimit, resolveProject, projectRateLimit(), enforceKeyScope, fileRoutes);
  // NAS(파일 저장·공유 서버): raw 업로드를 쓰므로 json 파서 전에 분기(files와 동일)
  app.use('/api/nas', apiLimit, resolveProject, projectRateLimit(), enforceKeyScope, nasRoutes);
  app.use('/api', apiLimit, express.json({ limit: '1mb' }), resolveProject, projectRateLimit());
  app.use('/api/auth', authRoutes);
  app.use('/api/data', enforceKeyScope, dataRoutes);
  app.use('/api/igplay', enforceKeyScope, igplayRoutes);
  app.use('/api/igmarket', enforceKeyScope, igmarketRoutes);
  app.use('/api/igtoken', enforceKeyScope, igtokenRoutes);
  app.use('/api/igstore', enforceKeyScope, igstoreRoutes);
  app.use('/api/iggame', enforceKeyScope, iggameRoutes);
  app.use('/api/igvideo', enforceKeyScope, igvideoRoutes);
  app.use('/api/igsocial', enforceKeyScope, igsocialRoutes);
  app.use('/api/iglive', enforceKeyScope, igliveRoutes);
  app.use('/api/igvod', enforceKeyScope, igvodRoutes);
  app.use('/api/igmap', enforceKeyScope, igmapRoutes);
  app.use('/api/messenger', enforceKeyScope, messengerRoutes);
  // 프로젝트 자기 정보 / 사용량 조회
  app.get('/api/project', (req, res) => res.json({ project: { id: req.project.id, name: req.project.name, slug: req.project.slug } }));
  app.get('/api/project/usage', async (req, res, next) => { try { res.json(await getUsage(getRepo(), req.project)); } catch (e) { next(e); } });
  app.get('/api/project/presence', (req, res) => res.json({ online: presenceList(req.project.id) }));

  // ---- 정적 파일 서빙 ----
  // 관리 대시보드
  app.use('/admin', express.static(path.join(config.root, 'public/admin')));
  // 각 프로젝트의 프론트엔드: public/apps/<slug>/ 에 올리면 /app/<slug>/ 로 서비스
  // igPlay 페이지는 주소/공개키를 주입해 반환(정적 서빙보다 먼저)
  app.use('/app', igplayInject);
  app.use('/app', messengerInject);
  app.use('/app', express.static(path.join(config.root, 'public/apps')));
  // 루트 → 대시보드로
  app.get('/', (_req, res) => res.redirect('/admin/'));

  // 404 + 에러 핸들러
  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
  app.use((err, req, res, _next) => {
    log('error', 'unhandled', { err: String(err?.stack || err), rid: req.rid });
    if (!res.headersSent) res.status(500).json({ error: 'server_error', message: '서버 오류가 발생했습니다.' });
  });

  const server = http.createServer(app);
  attachRealtime(server);

  server.listen(config.port, config.host, () => {
    log('info', `igServer 시작 http://${config.host}:${config.port}  (mode=${MODE}, db=${getRepo().driver})`, {});
    log('info', `관리 대시보드: http://localhost:${config.port}/admin/`, {});
  });

  // 워커 모드: 게이트웨이에 등록
  if (MODE === 'worker') {
    startWorkerHeartbeat({
      gatewayUrl: process.env.GATEWAY_URL,
      selfUrl: process.env.SELF_URL || `http://localhost:${config.port}`,
      label: process.env.NODE_LABEL,
    });
  }

  // 예약 작업 스케줄러 (워커 모드는 게이트웨이와 DB 공유 시 중복 방지를 위해 standalone/단일에서만)
  if (MODE !== 'worker') startScheduler();

  // 보존 워커
  if (config.retentionDays > 0) {
    const iv = setInterval(async () => {
      const n = await getRepo().retentionSweep(config.retentionDays);
      if (n) log('info', 'retention sweep', { removed: n });
    }, 6 * 3600 * 1000);
    iv.unref();
  }

  // 스테일 노드 정리 (대시보드 노드 목록 깔끔하게)
  const nodeIv = setInterval(() => getRepo().removeStaleNodes(30000).catch(() => {}), 15000);
  nodeIv.unref();

  // graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log('info', 'shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
  }
}

main().catch((e) => { log('error', 'fatal', { err: String(e?.stack || e) }); process.exit(1); });
