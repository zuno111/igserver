// igPlay 자동 프로비전 + 페이지 주입.
// 서버가 켜지면 igPlay 프로젝트(slug=igplay)를 자동 생성/보장하고, 그 공개키를 캐시한다.
// /app/igplay/ 페이지를 서빙할 때 origin+공개키를 window.IGPLAY_API로 주입 → 사용자는 주소/키 입력 없이 계정 로그인만 하면 된다.
// 공개키(api_key)만 노출한다. 비밀키는 절대 주입하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { getRepo } from './db/index.js';
import { config, randomId, randomKey, randomSecretKey } from './config.js';
import { log } from './logger.js';

let igplayKey = null; // 공개키 캐시

export async function ensureIgPlay() {
  const repo = getRepo();
  let p = await repo.getProjectBySlug('igplay');
  if (!p) {
    p = await repo.createProject({
      id: randomId('p_'), name: 'igPlay', slug: 'igplay',
      api_key: randomKey(), secret_key: randomSecretKey(), status: 'active', settings: { plan: 'free' },
    });
    log('info', 'igPlay 프로젝트 자동 생성', { key: p.api_key });
  }
  igplayKey = p.api_key;
  return p;
}

// /app/igplay/ 정적 서빙 전에 HTML을 주입해 반환하는 미들웨어
export function igplayInject(req, res, next) {
  // /app/igplay 또는 /app/igplay/ 또는 /app/igplay/index.html 만 대상
  const p = req.path;
  if (!(p === '/igplay' || p === '/igplay/' || p === '/igplay/index.html')) return next();
  const file = path.join(config.root, 'public/apps/igplay/index.html');
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return next();
    const origin = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
    const inject = `<script>window.IGPLAY_API={base:${JSON.stringify(origin)},key:${JSON.stringify(igplayKey || '')},auto:true};</script>`;
    // <title> 바로 뒤(스크립트 로드 전)에 주입
    const out = html.includes('<title>') ? html.replace('<title>', inject + '<title>') : inject + html;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 브라우저가 옛 버전을 붙들지 않도록 — 항상 최신 HTML을 받도록 캐시 금지
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(out);
  });
}
