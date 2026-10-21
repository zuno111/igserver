// 메신저 자동 프로비전 + 페이지 주입.
// 서버가 켜지면 메신저 프로젝트(slug=messenger)를 자동 생성/보장하고 공개키를 캐시한다.
// /app/messenger/ 페이지에 origin+공개키를 window.IG_MSGR로 주입 → 사용자는 주소/키 입력 없이,
// 접속만 하면 기기 신원이 자동 발급돼 바로 쓴다. 공개키만 노출(비밀키는 주입하지 않음).
import fs from 'node:fs';
import path from 'node:path';
import { getRepo } from './db/index.js';
import { config, randomId, randomKey, randomSecretKey } from './config.js';
import { log } from './logger.js';

let msgrKey = null;

export async function ensureMessenger() {
  const repo = getRepo();
  let p = await repo.getProjectBySlug('messenger');
  if (!p) {
    p = await repo.createProject({
      id: randomId('p_'), name: '메신저', slug: 'messenger',
      api_key: randomKey(), secret_key: randomSecretKey(), status: 'active', settings: { plan: 'free' },
    });
    log('info', '메신저 프로젝트 자동 생성', { key: p.api_key });
  }
  msgrKey = p.api_key;
  return p;
}

export function messengerInject(req, res, next) {
  const p = req.path;
  if (!(p === '/messenger' || p === '/messenger/' || p === '/messenger/index.html')) return next();
  const file = path.join(config.root, 'public/apps/messenger/index.html');
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return next();
    const origin = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
    const inject = `<script>window.IG_MSGR={base:${JSON.stringify(origin)},key:${JSON.stringify(msgrKey || '')}};</script>`;
    const out = html.includes('<title>') ? html.replace('<title>', inject + '<title>') : inject + html;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(out);
  });
}
