// 스키마 검증 실동작. 컬렉션 스키마 등록 후 잘못된 데이터 거부 확인.
// 사용: node test/schema_demo.js [base]
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
  console.log('=== 스키마 검증 실동작 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: '스키마테스트' } })).data.project;
  const t = (await api('POST', '/api/auth/signup', { key: proj.api_key, body: { email: `u${Date.now()}@s.test`, password: 'pw12345', name: 'U' } })).data.token;

  // products 컬렉션 스키마: title(문자 필수), price(숫자 0~), status(enum)
  await api('PUT', `/admin/api/projects/${proj.id}/schemas/products`, { token: adminToken, body: {
    fields: {
      title: { type: 'string', required: true, min: 1, max: 50 },
      price: { type: 'number', required: true, min: 0 },
      status: { type: 'string', enum: ['sale', 'soldout', 'hidden'] },
    }, strict: true,
  }});
  ok('스키마 등록', true);

  // 올바른 데이터 → 통과
  let r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { title: '커피', price: 4500, status: 'sale' } });
  ok('유효 데이터 통과', r.status === 201, JSON.stringify(r.data));

  // 필수 누락 (title 없음) → 거부
  r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { price: 1000 } });
  ok('필수 누락 거부 (422)', r.status === 422 && r.data.errors.some((e) => e.includes('title')), JSON.stringify(r.data));

  // 타입 오류 (price 문자열) → 거부
  r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { title: '차', price: '비쌈' } });
  ok('타입 오류 거부', r.status === 422 && r.data.errors.some((e) => e.includes('price')), JSON.stringify(r.data));

  // enum 위반 → 거부
  r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { title: '빵', price: 3000, status: '없는상태' } });
  ok('enum 위반 거부', r.status === 422 && r.data.errors.some((e) => e.includes('status')), JSON.stringify(r.data));

  // 범위 위반 (음수 가격) → 거부
  r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { title: '물', price: -100 } });
  ok('범위 위반 거부 (음수)', r.status === 422, JSON.stringify(r.data));

  // strict: 허용 안 된 필드 → 거부
  r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { title: '우유', price: 2000, 몰래: 'ㅋ' } });
  ok('strict 미허용 필드 거부', r.status === 422 && r.data.errors.some((e) => e.includes('몰래')), JSON.stringify(r.data));

  // 스키마 없는 컬렉션은 자유 (검증 안 함)
  r = await api('POST', '/api/data/freeform', { key: proj.api_key, token: t, body: { 아무거나: 123 } });
  ok('스키마 없는 컬렉션은 자유', r.status === 201);

  // 스키마 삭제 후 products도 자유
  await api('DELETE', `/admin/api/projects/${proj.id}/schemas/products`, { token: adminToken });
  r = await api('POST', '/api/data/products', { key: proj.api_key, token: t, body: { price: 1000 } });
  ok('스키마 삭제 후 검증 해제', r.status === 201, JSON.stringify(r.data));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
