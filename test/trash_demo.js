// 소프트 삭제 + 휴지통 실동작. 삭제→휴지통→복구→영구삭제 흐름 검증.
// 사용: node test/trash_demo.js [base]
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
async function api(method, path, { token, key, body } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: d };
}

async function main() {
  console.log('=== 소프트 삭제 + 휴지통 실동작 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '휴지통테스트' } })).data.project;
  const t = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `u${Date.now()}@t.test`, password: 'pw12345', name: 'U' } })).data.token;

  // 문서 3개 생성
  const ids = [];
  for (let i = 0; i < 3; i++) { const r = await api('POST', '/api/data/notes', { key: proj.api_key, token: t, body: { text: '메모' + i } }); ids.push(r.data.item.id); }
  ok('문서 3개 생성', ids.length === 3);

  // 1개 소프트 삭제
  let r = await api('DELETE', `/api/data/notes/${ids[0]}`, { key: proj.api_key, token: t });
  ok('소프트 삭제', r.status === 200 && r.data.hard === false);

  // 목록엔 2개만
  r = await api('GET', '/api/data/notes', { key: proj.api_key });
  ok('활성 목록 2개', r.data.items.length === 2 && !r.data.items.find((x) => x.id === ids[0]));

  // 삭제된 건 단건 조회 404
  r = await api('GET', `/api/data/notes/${ids[0]}`, { key: proj.api_key });
  ok('삭제 문서 단건 조회 404', r.status === 404);

  // 휴지통엔 1개
  r = await api('GET', '/api/data/notes?deleted=true', { key: proj.api_key });
  ok('휴지통 1개', r.data.items.length === 1 && r.data.items[0].id === ids[0]);

  // 복구
  r = await api('POST', `/api/data/notes/${ids[0]}/restore`, { key: proj.api_key, token: t });
  ok('복구', r.status === 200 && r.data.item.deleted === false);

  // 복구 후 활성 3개
  r = await api('GET', '/api/data/notes', { key: proj.api_key });
  ok('복구 후 활성 3개', r.data.items.length === 3);

  // 영구 삭제
  r = await api('DELETE', `/api/data/notes/${ids[1]}?hard=true`, { key: proj.api_key, token: t });
  ok('영구 삭제', r.status === 200 && r.data.hard === true);

  // 휴지통에도 없음 (완전 제거)
  r = await api('GET', '/api/data/notes?deleted=true', { key: proj.api_key });
  ok('영구 삭제는 휴지통에도 없음', !r.data.items.find((x) => x.id === ids[1]));

  // 영구 삭제는 복구 불가
  r = await api('POST', `/api/data/notes/${ids[1]}/restore`, { key: proj.api_key, token: t });
  ok('영구 삭제 복구 불가 404', r.status === 404);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
