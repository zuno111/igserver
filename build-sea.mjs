// Node SEA 단일 실행파일 빌더. 외부 다운로드 없이 현재 OS용 실행파일을 만든다.
// 1) esbuild로 전체 서버 코드를 한 CJS 파일로 번들 (better-sqlite3 네이티브만 제외)
// 2) node --experimental-sea-config 로 blob 생성
// 3) 현재 node 바이너리 복사 + postject로 blob 주입
// 4) public/ 과 better_sqlite3.node 를 실행파일 옆에 배치
// 결과: dist/ 폴더를 통째로 주면 Node 설치 없이 실행파일 더블클릭으로 바로 켜짐.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const isWin = process.platform === 'win32';
const exeName = isWin ? 'igserver.exe' : 'igserver';

function log(s) { console.log('[build-sea] ' + s); }

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 1) 번들
  log('esbuild 번들링...');
  await build({
    entryPoints: [path.join(__dirname, 'src/index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'bundle.cjs'),
    // better-sqlite3 JS 래퍼는 번들에 포함, 네이티브 .node만 런타임에 옆에서 로드(nativeBinding 객체).
    define: { 'process.env.IG_SEA': '"1"' },
    banner: { js: '/* igServer SEA bundle */' },
    logLevel: 'warning',
  });

  // 2) SEA blob 설정 + 생성
  const seaConfig = {
    main: path.join(DIST, 'bundle.cjs'),
    output: path.join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig));
  log('SEA blob 생성...');
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' });

  // 3) node 바이너리 복사 + blob 주입
  const outExe = path.join(DIST, exeName);
  fs.copyFileSync(process.execPath, outExe);
  fs.chmodSync(outExe, 0o755);
  log('postject 주입...');
  const postjectBin = path.join(__dirname, 'node_modules/postject/dist/cli.js');
  const args = [postjectBin, outExe, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(process.execPath, args, { stdio: 'inherit' });

  // 4) 네이티브 .node + public 배치
  const nodeFile = path.join(__dirname, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  fs.copyFileSync(nodeFile, path.join(DIST, 'better_sqlite3.node'));
  fs.cpSync(path.join(__dirname, 'public'), path.join(DIST, 'public'), { recursive: true });

  // 정리
  fs.rmSync(path.join(DIST, 'bundle.cjs'), { force: true });
  fs.rmSync(path.join(DIST, 'sea-prep.blob'), { force: true });
  fs.rmSync(path.join(DIST, 'sea-config.json'), { force: true });

  log(`완료: dist/${exeName} (+ better_sqlite3.node, public/)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
