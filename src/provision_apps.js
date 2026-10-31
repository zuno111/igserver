// Vercel에서 이관한 앱들의 자동 프로비전 + 프론트 키 주입.
// 서버 부팅 시 각 앱의 프로젝트(slug)를 보장 생성하고 공개키를 캐시한다.
// /app/<slug>/ HTML 서빙 시 window.<GLOBAL>_API = { base, key } 를 주입해
// 손님은 주소/키 입력 없이 바로 쓰게 한다. 공개키만 주입(시크릿키는 절대 노출 안 함).
import fs from 'node:fs';
import path from 'node:path';
import { getRepo } from './db/index.js';
import { config, randomId, randomKey, randomSecretKey } from './config.js';
import { log } from './logger.js';

const keys = {}; // slug -> api_key(public)

async function ensureApp(slug, name) {
  const repo = getRepo();
  let p = await repo.getProjectBySlug(slug);
  if (!p) {
    p = await repo.createProject({
      id: randomId('p_'), name, slug,
      api_key: randomKey(), secret_key: randomSecretKey(), status: 'active', settings: { plan: 'free' },
    });
    log('info', `${name} 프로젝트 자동 생성`, { slug, key: p.api_key });
  }
  keys[slug] = p.api_key;
  return p;
}

export async function ensureSchoolyam() { return ensureApp('schoolyam', 'School Yam'); }
export async function ensureIggift() { return ensureApp('iggift', 'igGift'); }

// 정적 HTML 서빙 전에 config 주입. slug/전역명 매핑.
function makeInject(slug, globalName) {
  return function inject(req, res, next) {
    const p = req.path;
    if (!(p === `/${slug}` || p === `/${slug}/` || p === `/${slug}/index.html`)) return next();
    const file = path.join(config.root, `public/apps/${slug}/index.html`);
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      const origin = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
      const cfg = `<script>window.${globalName}_API={base:${JSON.stringify(origin)},key:${JSON.stringify(keys[slug] || '')},slug:${JSON.stringify(slug)},auto:true};</script>`;
      const out = html.includes('<title>') ? html.replace('<title>', cfg + '<title>') : cfg + html;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(out);
    });
  };
}

export const schoolyamInject = makeInject('schoolyam', 'SCHOOLYAM');
export const iggiftInject = makeInject('iggift', 'IGGIFT');
