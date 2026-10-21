// 고도화 검증 1: 원자적 증감(inc) + 낙관적 동시성(rev) + 관계형 expand(조인).
// 사용: node test/atomic_demo.js [base]
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
async function api(method, path, { token, key, body, headers: extra } = {}) {
  const headers = { ...(extra || {}) }; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const d = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: d };
}

async function main() {
  console.log('=== 원자적 증감 · 조건부 쓰기 · 조인 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '고도화테스트' } })).data.project;
  const key = proj.api_key;
  const t = (await api('POST', '/api/auth/signup', { key, body: { email: `u${Date.now()}@up.test`, password: 'pw12345', name: '사용자' } })).data.token;

  // --- 1) 원자적 증감: 없는 문서에 inc → 0에서 시작해 생성 ---
  let r = await api('POST', '/api/data/scores/game1/inc', { key, token: t, body: { field: 'score', by: 10 } });
  ok('inc로 신규 생성(score=10)', r.data.item?.data?.score === 10, JSON.stringify(r.data));
  ok('rev=1', r.data.item?.rev === 1, 'rev=' + r.data.item?.rev);

  // 다중 필드 + 점(.) 경로 증감
  r = await api('POST', '/api/data/scores/game1/inc', { key, token: t, body: { fields: { score: 5, 'stats.kills': 3 } } });
  ok('다중/점경로 증감(score=15, stats.kills=3)', r.data.item?.data?.score === 15 && r.data.item?.data?.stats?.kills === 3, JSON.stringify(r.data.item?.data));

  // --- 2) 동시성: +1을 50번 병렬 호출 → 정확히 50 누적(경쟁 조건 없음) ---
  await api('POST', '/api/data/counters/likes/inc', { key, token: t, body: { field: 'n', by: 0 } }); // 0으로 생성
  await Promise.all(Array.from({ length: 50 }, () => api('POST', '/api/data/counters/likes/inc', { key, token: t, body: { field: 'n', by: 1 } })));
  r = await api('GET', '/api/data/counters/likes', { key });
  ok('50회 동시 증감 = 정확히 50', r.data.item?.data?.n === 50, 'n=' + r.data.item?.data?.n);

  // --- 3) 낙관적 동시성(rev): 현재 rev로 PUT은 성공, 과거 rev로 PUT은 409 ---
  const created = (await api('POST', '/api/data/docs', { key, token: t, body: { title: 'v1' } })).data.item;
  ok('생성 직후 rev=1', created.rev === 1, 'rev=' + created.rev);
  let put1 = await api('PUT', `/api/data/docs/${created.id}`, { key, token: t, headers: { 'If-Match': '1' }, body: { title: 'v2' } });
  ok('올바른 rev로 수정 성공(rev=2)', put1.status === 200 && put1.data.item?.rev === 2, JSON.stringify(put1.data));
  let putStale = await api('PUT', `/api/data/docs/${created.id}`, { key, token: t, headers: { 'If-Match': '1' }, body: { title: '충돌' } });
  ok('과거 rev로 수정 → 409 rev_conflict', putStale.status === 409 && putStale.data.error === 'rev_conflict', JSON.stringify(putStale.data));
  ok('409 응답에 현재 rev 포함', putStale.data.current === 2, 'current=' + putStale.data.current);
  // body._rev 방식도 동작
  let putBody = await api('PUT', `/api/data/docs/${created.id}`, { key, token: t, body: { title: 'v3', _rev: 2 } });
  ok('body._rev 로도 조건부 수정 성공', putBody.status === 200 && putBody.data.item?.rev === 3, JSON.stringify(putBody.data));
  ok('_rev 제어필드는 저장되지 않음', putBody.data.item?.data?._rev === undefined, JSON.stringify(putBody.data.item?.data));

  // --- 4) 관계형 expand(조인): posts.authorId → authors 레코드 펼치기 ---
  const author = (await api('POST', '/api/data/authors', { key, token: t, body: { name: '김작가', bio: '소설가' } })).data.item;
  await api('POST', '/api/data/posts', { key, token: t, body: { title: '글1', authorId: author.id } });
  r = await api('GET', `/api/data/posts?expand=authorId:authors`, { key });
  const post = r.data.items?.[0];
  ok('목록 expand로 참조 레코드 펼침', post?._expand?.authorId?.data?.name === '김작가', JSON.stringify(post?._expand));
  // 단건 조회도 expand
  r = await api('GET', `/api/data/posts/${post.id}?expand=authorId:authors`, { key });
  ok('단건 expand 동작', r.data.item?._expand?.authorId?.data?.bio === '소설가', JSON.stringify(r.data.item?._expand));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
