// 통합 스모크 테스트. 실제 서버를 띄우고 fetch로 전체 플로우를 검증한다.
// 실패 수만큼 exit code. 메모리/sqlite/pg 어느 드라이버든 통과해야 한다.
import { WebSocket } from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8787';
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = '') { if (cond) { pass++; results.push(`  ✓ ${name}`); } else { fail++; results.push(`  ✗ ${name}  ${extra}`); } }

async function j(method, url, { token, key, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['X-Project-Key'] = key;
  let payload;
  if (raw !== undefined) { payload = raw; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  let data = null; const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json(); else data = await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function run() {
  // 0. 헬스체크
  let r = await j('GET', '/healthz');
  ok('헬스체크', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

  // 1. 관리자 로그인 (기본 계정)
  r = await j('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'admin1234' } });
  ok('관리자 로그인', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
  const adminToken = r.data.token;

  // 1b. 잘못된 관리자 로그인 거부
  r = await j('POST', '/admin/api/login', { body: { email: 'admin@studio-ig.local', password: 'wrong' } });
  ok('잘못된 관리자 비번 거부', r.status === 401);

  // 2. 프로젝트 생성
  r = await j('POST', '/admin/api/projects', { token: adminToken, body: { name: '컷룸 테스트', slug: 'cutroom-test' } });
  ok('프로젝트 생성', r.status === 201 && !!r.data.project?.api_key, JSON.stringify(r.data));
  const projectKey = r.data.project?.api_key;
  const secretKey = r.data.project?.secret_key;
  const projectId = r.data.project?.id;
  ok('비밀키 발급', !!secretKey && secretKey.startsWith('sk_'), String(secretKey));

  // 2b. 인증 없이 프로젝트 생성 거부
  r = await j('POST', '/admin/api/projects', { body: { name: 'x' } });
  ok('비인증 프로젝트 생성 거부', r.status === 401);

  // 3. 프로젝트 목록에 보이는지
  r = await j('GET', '/admin/api/projects', { token: adminToken });
  ok('프로젝트 목록 조회', r.status === 200 && r.data.projects.some((p) => p.id === projectId));

  // 4. 프로젝트 키 없이 API 접근 거부
  r = await j('POST', '/api/auth/signup', { body: { email: 'a@b.com', password: '123456' } });
  ok('프로젝트 키 없이 거부', r.status === 401);

  // 5. 회원가입
  const email = `user${Date.now()}@test.com`;
  r = await j('POST', '/api/auth/signup', { key: projectKey, body: { email, password: 'secret123', name: '홍길동' } });
  ok('회원가입', r.status === 201 && !!r.data.token, JSON.stringify(r.data));
  const userToken = r.data.token;
  const userId = r.data.user?.id;

  // 5b. 중복 가입 거부
  r = await j('POST', '/api/auth/signup', { key: projectKey, body: { email, password: 'secret123' } });
  ok('중복 이메일 거부', r.status === 409);

  // 5c. 약한 비번 거부
  r = await j('POST', '/api/auth/signup', { key: projectKey, body: { email: 'x@y.com', password: '12' } });
  ok('약한 비번 거부', r.status === 400);

  // 6. 로그인
  r = await j('POST', '/api/auth/login', { key: projectKey, body: { email, password: 'secret123' } });
  ok('로그인', r.status === 200 && !!r.data.token);

  // 6b. 틀린 비번 로그인 거부
  r = await j('POST', '/api/auth/login', { key: projectKey, body: { email, password: 'nope' } });
  ok('틀린 비번 로그인 거부', r.status === 401);

  // 7. 내 정보
  r = await j('GET', '/api/auth/me', { key: projectKey, token: userToken });
  ok('내 정보 조회', r.status === 200 && r.data.user?.email === email);

  // 8. 데이터 생성 (범용 저장소)
  r = await j('POST', '/api/data/projects', { key: projectKey, token: userToken, body: { title: '첫 영상', duration: 120 } });
  ok('데이터 생성', r.status === 201 && !!r.data.item?.id && r.data.item.data.title === '첫 영상', JSON.stringify(r.data));
  const docId = r.data.item?.id;

  // 8b. 토큰 없이 쓰기 거부
  r = await j('POST', '/api/data/projects', { key: projectKey, body: { x: 1 } });
  ok('비로그인 쓰기 거부', r.status === 401);

  // 9. 데이터 조회
  r = await j('GET', `/api/data/projects/${docId}`, { key: projectKey });
  ok('데이터 단건 조회', r.status === 200 && r.data.item?.data?.duration === 120);

  // 10. 데이터 수정
  r = await j('PUT', `/api/data/projects/${docId}`, { key: projectKey, token: userToken, body: { title: '수정됨', duration: 200 } });
  ok('데이터 수정', r.status === 200 && r.data.item?.data?.title === '수정됨');

  // 11. 목록 조회
  r = await j('GET', '/api/data/projects', { key: projectKey });
  ok('데이터 목록 조회', r.status === 200 && Array.isArray(r.data.items) && r.data.items.length >= 1);

  // 11b. private scope (본인 것만)
  r = await j('GET', '/api/data/projects?scope=private', { key: projectKey, token: userToken });
  ok('private scope 조회', r.status === 200 && r.data.items.length >= 1);

  // 11c. 서버측 필터 (duration gte 150 → 200짜리만)
  await j('POST', '/api/data/projects', { key: projectKey, token: userToken, body: { title: '짧은 영상', duration: 50 } });
  r = await j('GET', '/api/data/projects?filter=duration:gte:150', { key: projectKey });
  ok('서버측 필터 (gte)', r.status === 200 && r.data.items.length >= 1 && r.data.items.every((x) => x.data.duration >= 150), JSON.stringify(r.data.items.map((x) => x.data.duration)));

  // 11d. 서버측 정렬 (duration 오름차순)
  r = await j('GET', '/api/data/projects?sort=duration:asc', { key: projectKey });
  const durs = r.data.items.map((x) => x.data.duration);
  ok('서버측 정렬 (asc)', r.status === 200 && durs.every((v, i) => i === 0 || durs[i - 1] <= v), JSON.stringify(durs));

  // 11e. count 엔드포인트
  r = await j('GET', '/api/data/projects/_count', { key: projectKey });
  ok('count 엔드포인트', r.status === 200 && typeof r.data.count === 'number' && r.data.count >= 2, JSON.stringify(r.data));

  // 11f. count + 필터
  r = await j('GET', '/api/data/projects/_count?filter=duration:lt:100', { key: projectKey });
  ok('count + 필터', r.status === 200 && r.data.count >= 1);

  // 12. 다른 유저가 남의 문서 수정 못 함
  const email2 = `user2_${Date.now()}@test.com`;
  r = await j('POST', '/api/auth/signup', { key: projectKey, body: { email: email2, password: 'secret123' } });
  const userToken2 = r.data.token;
  r = await j('PUT', `/api/data/projects/${docId}`, { key: projectKey, token: userToken2, body: { title: '탈취시도' } });
  ok('타인 문서 수정 차단', r.status === 403, JSON.stringify(r.data));

  // 12b. 비밀키는 서버 권한 (토큰 없이 타인 문서 수정 가능)
  r = await j('PUT', `/api/data/projects/${docId}`, { key: secretKey, body: { title: '서버수정', duration: 999 } });
  ok('비밀키 서버 권한 수정', r.status === 200 && r.data.item?.data?.title === '서버수정', JSON.stringify(r.data));

  // 12c. 공개키로는 비밀 전용 동작 불가 확인 (공개키 = 일반 권한 유지)
  r = await j('PUT', `/api/data/projects/${docId}`, { key: projectKey, token: userToken2, body: { title: '또탈취' } });
  ok('공개키 권한 유지 (타인 수정 여전히 차단)', r.status === 403);

  // 13. 파일 업로드
  const content = Buffer.from('안녕하세요 igServer 파일 테스트');
  r = await j('POST', '/api/files?filename=test.txt', { key: projectKey, token: userToken, raw: content });
  ok('파일 업로드', r.status === 201 && !!r.data.file?.id && r.data.file.size === content.length, JSON.stringify(r.data));
  const fileId = r.data.file?.id;

  // 13b. 파일 다운로드
  r = await j('GET', `/api/files/${fileId}`, { key: projectKey });
  ok('파일 다운로드', r.status === 200 && String(r.data).includes('igServer 파일 테스트'));

  // 14. 프로젝트 격리: 다른 프로젝트 키로 이 데이터 접근 불가
  r = await j('POST', '/admin/api/projects', { token: adminToken, body: { name: '레이어룸 테스트' } });
  const otherKey = r.data.project?.api_key;
  r = await j('GET', `/api/data/projects/${docId}`, { key: otherKey });
  ok('프로젝트 간 데이터 격리', r.status === 404, JSON.stringify(r.data));

  // 15. WebSocket 실시간
  const wsOk = await testWs(projectKey, userToken);
  ok('WebSocket 구독/브로드캐스트', wsOk);

  // 16. 모니터링 overview
  r = await j('GET', '/admin/api/overview', { token: adminToken });
  ok('모니터링 overview', r.status === 200 && r.data.projects >= 2 && !!r.data.metrics);
  ok('overview 요청 시계열(30)·presence', Array.isArray(r.data.series) && r.data.series.length === 30 && typeof r.data.presence === 'object');

  // 17. 감사 로그
  r = await j('GET', '/admin/api/audit', { token: adminToken });
  ok('감사 로그 조회', r.status === 200 && Array.isArray(r.data.audit) && r.data.audit.length > 0);

  // 18. 메트릭
  r = await j('GET', '/metrics');
  ok('Prometheus 메트릭', r.status === 200 && String(r.data).includes('ig_requests_total'));

  // 18b. 관리 대시보드 HTML 서빙
  r = await j('GET', '/admin/');
  ok('관리 대시보드 서빙', r.status === 200 && String(r.data).includes('igServer'));

  // 18c. igClient SDK 서빙
  r = await j('GET', '/app/_sdk/igclient.js');
  ok('igClient SDK 서빙', r.status === 200 && String(r.data).includes('function igClient'));

  // 19. rate limit (인증 엔드포인트 연타 → 429)
  let got429 = false;
  for (let i = 0; i < 30; i++) {
    const rr = await j('POST', '/api/auth/login', { key: projectKey, body: { email: 'z@z.com', password: 'x' } });
    if (rr.status === 429) { got429 = true; break; }
  }
  ok('rate limit 429 동작', got429);

  // 20. 프로젝트 삭제 → 데이터 사라짐
  r = await j('DELETE', `/admin/api/projects/${projectId}`, { token: adminToken });
  ok('프로젝트 삭제', r.status === 200);
  r = await j('GET', `/api/data/projects/${docId}`, { key: projectKey });
  ok('삭제 후 키 무효화', r.status === 401 || r.status === 404);

  console.log('\n' + results.join('\n'));
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail);
}

function testWs(key, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?key=${key}&token=${token}`);
    let subscribed = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', room: 'test-room' })));
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'subscribed') {
        subscribed = true;
        ws.send(JSON.stringify({ type: 'publish', room: 'test-room', data: { hello: 'world' } }));
      } else if (msg.type === 'message' && msg.data?.hello === 'world') {
        clearTimeout(timer); ws.close(); resolve(subscribed);
      }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

run().catch((e) => { console.error('스모크 실행 오류:', e); process.exit(99); });
