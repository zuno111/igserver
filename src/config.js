// 환경변수 로드 + 기본값. .env 파일이 있으면 읽어서 process.env에 주입(의존성 없이 직접 파싱).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SEA(단일 실행파일) / pkg 환경에서는 소스 경로가 없으므로 실행파일 위치를 루트로 쓴다.
// 빌드 시 IG_SEA=1 이 주입된다(esbuild --define). process.pkg는 pkg 빌드용.
export const IS_PACKAGED = process.env.IG_SEA === '1' || !!process.pkg;

const __dirname = IS_PACKAGED ? '' : path.dirname(fileURLToPath(import.meta.url));
export const ROOT = IS_PACKAGED ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

// .env 직접 로드 (dotenv 의존성 회피)
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const txt = fs.readFileSync(envPath, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

const env = process.env;

// JWT 시크릿: 지정 없으면 데이터 디렉토리에 생성해 저장(재시작해도 유지 → 토큰 안 깨짐)
function resolveJwtSecret() {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const dataDir = env.DATA_DIR || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, '.jwt_secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const secret = randomHex(48);
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const config = {
  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  root: ROOT,

  // DB 드라이버 선택: DATABASE_URL 있으면 postgres, DB_DRIVER=memory면 메모리, 기본 sqlite
  dbDriver: env.DATABASE_URL ? 'postgres' : (env.DB_DRIVER || 'sqlite'),
  databaseUrl: env.DATABASE_URL || '',

  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',

  // 관리자 계정 (대시보드 접속). 최초 1회 생성.
  adminEmail: env.ADMIN_EMAIL || 'admin@studio-ig.local',
  adminPassword: env.ADMIN_PASSWORD || 'admin1234',

  // rate limit 기본값
  rlWindowMs: parseInt(env.RL_WINDOW_MS || '60000', 10),
  rlMax: parseInt(env.RL_MAX || '300', 10),
  rlAuthMax: parseInt(env.RL_AUTH_MAX || '20', 10),

  // 파일 업로드 상한 (바이트)
  maxUploadBytes: parseInt(env.MAX_UPLOAD_BYTES || String(20 * 1024 * 1024), 10),

  // 데이터 보존 (일). 0이면 비활성
  retentionDays: parseInt(env.RETENTION_DAYS || '0', 10),

  nodeEnv: env.NODE_ENV || 'development',
};

export function randomId(prefix = '') {
  return prefix + randomHex(12);
}

export function randomKey() {
  return 'igk_' + randomHex(24);
}

export function randomSecretKey() {
  return 'sk_' + randomHex(24);
}
