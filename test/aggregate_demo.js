// 집계 쿼리(sum·avg·min·max·count·group-by) 실동작 검증.
// 사용: node test/aggregate_demo.js [base]
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
  console.log('=== 집계 쿼리 실동작 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '집계테스트' } })).data.project;
  const key = proj.api_key;
  const t = (await api('POST', '/api/auth/signup', { key, body: { email: `u${Date.now()}@agg.test`, password: 'pw12345', name: 'U' } })).data.token;

  // 주문 데이터: 과일 3건(1000,1500,2000), 채소 2건(500,800)
  const rows = [
    { cat: '과일', price: 1000 }, { cat: '과일', price: 1500 }, { cat: '과일', price: 2000 },
    { cat: '채소', price: 500 }, { cat: '채소', price: 800 },
  ];
  await api('POST', '/api/data/orders/_batch', { key, token: t, body: { ops: rows.map((d) => ({ op: 'create', data: d })) } });
  ok('주문 5건 생성', true);

  // 전체 합계 = 5800
  let r = await api('GET', '/api/data/orders/_aggregate?op=sum&field=price', { key });
  ok('sum 전체 = 5800', r.data.value === 5800, 'value=' + r.data.value);

  // 평균 = 1160
  r = await api('GET', '/api/data/orders/_aggregate?op=avg&field=price', { key });
  ok('avg 전체 = 1160', r.data.value === 1160, 'value=' + r.data.value);

  // 최소 500, 최대 2000
  r = await api('GET', '/api/data/orders/_aggregate?op=min&field=price', { key });
  ok('min = 500', r.data.value === 500, 'value=' + r.data.value);
  r = await api('GET', '/api/data/orders/_aggregate?op=max&field=price', { key });
  ok('max = 2000', r.data.value === 2000, 'value=' + r.data.value);

  // count = 5
  r = await api('GET', '/api/data/orders/_aggregate?op=count', { key });
  ok('count = 5', r.data.value === 5, 'value=' + r.data.value);

  // group-by cat, sum price → 과일 4500, 채소 1300
  r = await api('GET', '/api/data/orders/_aggregate?op=sum&field=price&groupBy=cat', { key });
  const g = Object.fromEntries((r.data.groups || []).map((x) => [x.group, x.value]));
  ok('group-by cat sum (과일 4500)', g['과일'] === 4500, JSON.stringify(g));
  ok('group-by cat sum (채소 1300)', g['채소'] === 1300, JSON.stringify(g));

  // 필터 + 집계: price>=1000인 것만 합계 = 1000+1500+2000 = 4500
  r = await api('GET', '/api/data/orders/_aggregate?op=sum&field=price&filter=price:gte:1000', { key });
  ok('필터+sum (>=1000 → 4500)', r.data.value === 4500, 'value=' + r.data.value);

  // group-by count
  r = await api('GET', '/api/data/orders/_aggregate?op=count&groupBy=cat', { key });
  const gc = Object.fromEntries((r.data.groups || []).map((x) => [x.group, x.value]));
  ok('group-by count (과일 3, 채소 2)', gc['과일'] === 3 && gc['채소'] === 2, JSON.stringify(gc));

  // field 없는 sum은 400
  r = await api('GET', '/api/data/orders/_aggregate?op=sum', { key });
  ok('field 없는 sum 거부 (400)', r.status === 400);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
