// 서버측 스케줄러 실동작 검증. '즉시 실행'으로 cleanup_old / empty_trash / webhook_ping 확인.
// 사용: node test/scheduler_demo.js [base]
import http from 'node:http';
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, { token, key, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: d };
}

async function main() {
  console.log('=== 서버측 스케줄러 실동작 ===');
  const received = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { received.push(JSON.parse(b || '{}')); res.end('ok'); }); });
  await new Promise((r) => server.listen(9822, r));

  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '스케줄러테스트' } })).data.project;
  await api('POST', `/admin/api/projects/${proj.id}/webhooks`, { token: adminToken, body: { url: 'http://localhost:9822/hook', events: ['scheduled.tick'] } });
  const t = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `u${Date.now()}@s.test`, password: 'pw12345', name: 'U' } })).data.token;

  // cleanup_old 작업 등록 (logs 컬렉션, 0일 초과 = 전부)
  let r = await api('POST', `/admin/api/projects/${proj.id}/jobs`, { token: adminToken, body: { type: 'cleanup_old', intervalMin: 60, collection: 'logs', olderThanDays: 0 } });
  ok('cleanup_old 작업 등록', r.status === 201 && r.data.job.type === 'cleanup_old', JSON.stringify(r.data).slice(0, 80));
  const cleanupJob = r.data.job.id;

  // logs 3건 생성
  for (let i = 0; i < 3; i++) await api('POST', '/api/data/logs', { key: proj.api_key, token: t, body: { msg: 'log' + i } });
  let cnt = (await api('GET', '/api/data/logs/_count', { key: proj.api_key })).data.count;
  ok('logs 3건 생성', cnt === 3, 'count=' + cnt);

  // cleanup 즉시 실행 → 전부 소프트삭제
  r = await api('POST', `/admin/api/projects/${proj.id}/jobs/${cleanupJob}/run`, { token: adminToken });
  ok('cleanup 즉시 실행 (3건 정리)', r.status === 200 && r.data.result.removed === 3, JSON.stringify(r.data));
  cnt = (await api('GET', '/api/data/logs/_count', { key: proj.api_key })).data.count;
  ok('활성 logs 0건', cnt === 0, 'count=' + cnt);
  cnt = (await api('GET', '/api/data/logs/_count?deleted=true', { key: proj.api_key })).data.count;
  ok('휴지통에 3건', cnt === 3, 'trash=' + cnt);

  // empty_trash 작업 등록 + 즉시 실행 (0일 초과 = 전부 영구삭제)
  r = await api('POST', `/admin/api/projects/${proj.id}/jobs`, { token: adminToken, body: { type: 'empty_trash', intervalMin: 1440, olderThanDays: 0 } });
  const trashJob = r.data.job.id;
  r = await api('POST', `/admin/api/projects/${proj.id}/jobs/${trashJob}/run`, { token: adminToken });
  ok('empty_trash 즉시 실행 (3건 영구삭제)', r.status === 200 && r.data.result.purged === 3, JSON.stringify(r.data));
  cnt = (await api('GET', '/api/data/logs/_count?deleted=true', { key: proj.api_key })).data.count;
  ok('휴지통 비워짐', cnt === 0, 'trash=' + cnt);

  // webhook_ping 작업 등록 + 즉시 실행 → 웹훅 수신
  r = await api('POST', `/admin/api/projects/${proj.id}/jobs`, { token: adminToken, body: { type: 'webhook_ping', intervalMin: 5 } });
  const pingJob = r.data.job.id;
  await api('POST', `/admin/api/projects/${proj.id}/jobs/${pingJob}/run`, { token: adminToken });
  await sleep(600);
  ok('webhook_ping → scheduled.tick 수신', received.some((x) => x.event === 'scheduled.tick'), JSON.stringify(received.map((x) => x.event)));

  // 작업 목록 3개, 삭제
  r = await api('GET', `/admin/api/projects/${proj.id}/jobs`, { token: adminToken });
  ok('작업 목록 3개', r.data.jobs.length === 3);
  await api('DELETE', `/admin/api/projects/${proj.id}/jobs/${pingJob}`, { token: adminToken });
  r = await api('GET', `/admin/api/projects/${proj.id}/jobs`, { token: adminToken });
  ok('작업 삭제 후 2개', r.data.jobs.length === 2);

  server.close();
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
