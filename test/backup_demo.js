// 백업/복원 실동작 검증. 데이터를 만들고 export → import → 복원 확인.
// 사용: node test/backup_demo.js [base]
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };

async function api(method, path, { token, key, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((d && d.message) || res.status);
  return d;
}

async function main() {
  console.log('=== 백업/복원 실동작 검증 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '원본프로젝트' } })).project;

  // 유저 2명 + 데이터 5개
  const u1 = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `a${Date.now()}@b.test`, password: 'pw12345', name: '유저1' } })).token;
  for (let i = 0; i < 5; i++) await api('POST', '/api/data/notes', { key: proj.api_key, token: u1, body: { text: '메모 ' + i, n: i } });
  ok('원본 데이터 생성 (5건)', true);

  // export
  const backup = await api('GET', `/admin/api/projects/${proj.id}/export`, { token: adminToken });
  ok('export', backup.records.length === 5 && backup.users.length === 1, `records=${backup.records.length} users=${backup.users.length}`);

  // import (새 프로젝트로)
  const imp = await api('POST', '/admin/api/import', { token: adminToken, body: { ...backup, name: '복원프로젝트' } });
  ok('import → 새 프로젝트', !!imp.project.api_key && imp.restored.records === 5, JSON.stringify(imp.restored));

  // 복원된 프로젝트에서 데이터 확인
  const count = (await api('GET', '/api/data/notes/_count', { key: imp.project.api_key })).count;
  ok('복원된 데이터 건수 일치', count === 5, `count=${count}`);

  // 복원된 유저로 로그인 가능 (비번 해시 유지)
  const backupUser = backup.users[0];
  const login = await api('POST', '/api/auth/login', { key: imp.project.api_key, body: { email: backupUser.email, password: 'pw12345' } }).catch((e) => ({ err: e.message }));
  ok('복원된 유저 로그인 가능', !!login.token, JSON.stringify(login).slice(0, 60));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
