// NAS(파일 저장·공유 서버) 실동작 검증: 폴더·업로드·목록·다운로드·이동·재귀삭제·공유링크·사용량.
// 사용: node test/nas_demo.js [base]
const BASE = process.argv[2] || 'http://localhost:8787';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + e); } };
async function api(method, path, { token, key, body, raw, ct } = {}) {
  const headers = {}; if (token) headers.Authorization = 'Bearer ' + token; if (key) headers['X-Project-Key'] = key;
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = ct || 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const t = (res.headers.get('content-type') || '');
  const d = t.includes('json') ? await res.json() : (t.includes('text') ? await res.text() : Buffer.from(await res.arrayBuffer()));
  return { status: res.status, data: d };
}

async function main() {
  console.log('=== NAS 파일 저장·공유 ===');
  const adminToken = (await api('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } })).data.token;
  const proj = (await api('POST', '/admin/api/projects', { token: adminToken, body: { name: 'NAS테스트' } })).data.project;
  const key = proj.api_key;
  const t = (await api('POST', '/api/auth/signup', { key, body: { email: `u${Date.now()}@nas.test`, password: 'pw12345', name: '사용자' } })).data.token;
  const A = { key, token: t };

  // 1) 폴더 생성(중첩 조상 자동 생성)
  let r = await api('POST', '/api/nas/folder', { ...A, body: { path: '/사진/2026' } });
  ok('중첩 폴더 생성(/사진/2026)', r.status === 201 && r.data.folder?.path === '/사진/2026', JSON.stringify(r.data));
  r = await api('GET', '/api/nas/list?path=/', A);
  ok('루트에 사진 폴더 보임', r.data.folders?.some((f) => f.name === '사진'), JSON.stringify(r.data.folders));

  // 2) 업로드 (경로에 파일명)
  r = await api('POST', '/api/nas/upload?path=' + encodeURIComponent('/사진/2026/a.txt'), { ...A, raw: Buffer.from('안녕하세요 NAS', 'utf8') });
  ok('파일 업로드(/사진/2026/a.txt)', r.status === 201 && r.data.file?.size > 0, JSON.stringify(r.data));
  await api('POST', '/api/nas/upload?path=' + encodeURIComponent('/사진/2026/b.bin'), { ...A, raw: Buffer.from([1, 2, 3, 4, 5]) });

  // 3) 폴더 목록
  r = await api('GET', '/api/nas/list?path=' + encodeURIComponent('/사진/2026'), A);
  ok('폴더 내 파일 2개', r.data.files?.length === 2, JSON.stringify(r.data.files?.map((f) => f.name)));

  // 4) 다운로드 (내용 일치)
  r = await api('GET', '/api/nas/file?path=' + encodeURIComponent('/사진/2026/a.txt'), { key });
  ok('다운로드 내용 일치', r.data.toString('utf8') === '안녕하세요 NAS', JSON.stringify(String(r.data)));

  // 5) 이름변경(이동): a.txt → 메모.txt
  r = await api('POST', '/api/nas/move', { ...A, body: { from: '/사진/2026/a.txt', to: '/사진/2026/메모.txt' } });
  ok('파일 이름변경', r.status === 200 && r.data.moved === 1, JSON.stringify(r.data));
  r = await api('GET', '/api/nas/file?path=' + encodeURIComponent('/사진/2026/메모.txt'), { key });
  ok('새 이름으로 다운로드됨', r.data.toString('utf8') === '안녕하세요 NAS');
  r = await api('GET', '/api/nas/file?path=' + encodeURIComponent('/사진/2026/a.txt'), { key });
  ok('옛 경로는 404', r.status === 404);

  // 6) 폴더 이동(하위 전체 경로 갱신): /사진/2026 → /보관/2026
  r = await api('POST', '/api/nas/move', { ...A, body: { from: '/사진/2026', to: '/보관/2026' } });
  ok('폴더 이동(하위 파일 포함)', r.status === 200 && r.data.moved >= 3, JSON.stringify(r.data));
  r = await api('GET', '/api/nas/file?path=' + encodeURIComponent('/보관/2026/메모.txt'), { key });
  ok('이동 후 새 경로로 다운로드', r.data.toString?.('utf8') === '안녕하세요 NAS', 'status=' + r.status);

  // 7) 공유 링크(만료 포함) → 비로그인 다운로드
  r = await api('POST', '/api/nas/share', { ...A, body: { path: '/보관/2026/메모.txt', expiresInSec: 3600 } });
  const shareToken = r.data.file?.share?.token;
  ok('공유 토큰 발급', !!shareToken, JSON.stringify(r.data.file?.share));
  r = await api('GET', `/api/nas/shared/${shareToken}?key=${key}`, {}); // 로그인 없이, 키만
  ok('공유 링크로 비로그인 다운로드', r.data.toString?.('utf8') === '안녕하세요 NAS', 'status=' + r.status);
  // 공유 해제 후 접근 불가
  await api('DELETE', '/api/nas/share?path=' + encodeURIComponent('/보관/2026/메모.txt'), A);
  r = await api('GET', `/api/nas/shared/${shareToken}?key=${key}`, {});
  ok('공유 해제 후 404', r.status === 404, 'status=' + r.status);

  // 8) 사용량
  r = await api('GET', '/api/nas/usage', A);
  ok('사용량: 파일 2 / 폴더 보고', r.data.files === 2 && r.data.bytes > 0, JSON.stringify(r.data));

  // 9) 재귀 삭제: /보관 통째로
  r = await api('DELETE', '/api/nas/delete?path=' + encodeURIComponent('/보관'), A);
  ok('폴더 재귀 삭제', r.status === 200 && r.data.removed >= 3, JSON.stringify(r.data));
  r = await api('GET', '/api/nas/usage', A);
  ok('삭제 후 파일 0', r.data.files === 0, JSON.stringify(r.data));
  r = await api('GET', '/api/nas/file?path=' + encodeURIComponent('/보관/2026/메모.txt'), { key });
  ok('삭제된 파일 404', r.status === 404);

  // 10) 경로 탈출 방지
  r = await api('POST', '/api/nas/upload?path=' + encodeURIComponent('/../../etc/passwd'), { ...A, raw: Buffer.from('x') });
  ok('경로 탈출(..)은 정규화되어 안전', r.status === 201 && !String(r.data.file?.path).includes('..'), JSON.stringify(r.data.file?.path));

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}
main().catch((e) => { console.error('검증 오류:', e); process.exit(99); });
