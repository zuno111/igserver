# igServer

STUDIO ig 공통 서버 인프라. 웹앱·앱·게임을 한 서버에 올려 실제 서비스하는 멀티 프로젝트 백엔드입니다. 프로젝트마다 서버를 새로 만들지 않고, 이 서버 하나에 프로젝트를 등록해서 공유합니다.

## 할 수 있는 것

- 프로젝트별 회원가입·로그인 (JWT)
- 범용 데이터 저장소 (컬렉션·문서 자유 생성, 권한 격리)
- **서버측 쿼리** (필터·정렬·페이지네이션·건수) — 전체를 받지 않고 조건으로 조회
- **API 키 스코프** — 공개키(클라 배포용) + 비밀키(서버 전용·전체 권한)
- **웹훅** — 데이터 변경 시 외부로 서명(HMAC)된 POST
- **백업/복원** — 프로젝트 전체 export·import
- **사용량 쿼터 + 플랜** — 프로젝트별 데이터·유저·파일·요청 한도 (자원 보호용, 결제·과금 아님. 자기 인프라면 unlimited)
- **데이터 스키마 검증** — 컬렉션별 필드 타입·필수·범위·enum 정의, 위반 시 쓰기 거부
- **소프트 삭제 + 휴지통** — 삭제한 데이터 복구, 영구삭제 분리
- **다중 관리자 + 역할(RBAC)** — owner/admin/viewer. 관리자 여러 명, 권한 분리
- **배치 데이터 API** — 여러 레코드 한 번에 생성·수정·삭제 (최대 200개)
- **전문 검색** — 컬렉션 텍스트 검색 (`?q=`), 필터와 조합 가능
- **비밀번호 재설정** — 토큰 기반, 재설정 토큰은 웹훅으로 전달 (이메일 발송은 수신 측)
- **레코드 변경 이력 + 롤백** — 생성/수정/삭제 스냅샷 기록, 특정 버전으로 되돌리기
- **범위 제한 API 키** — 프로젝트당 추가 키 여러 개(읽기전용/특정 컬렉션/만료)
- **서버측 스케줄러** — 프로젝트별 예약 작업(오래된 레코드 정리·휴지통 비우기·웹훅 주기 호출)
- **레코드 단위 공유 권한(ACL)** — 레코드마다 공개 여부·읽기/쓰기 허용 유저 지정
- **집계 쿼리** — sum·avg·min·max·count, group-by, 필터 조합
- **데이터 뷰어** — 관리 대시보드에서 프로젝트 데이터를 직접 조회·편집·삭제·복구
- 파일 업로드·다운로드
- 실시간 WebSocket (방 구독·브로드캐스트, 채팅·동기화)
- 관리 대시보드 (프로젝트 등록·모니터링·감사로그·요청 그래프·실시간 접속자·웹훅 관리)
- 클러스터 (여러 대를 워커로 붙여 수평 확장)

프로젝트는 서로 완전히 격리됩니다. 컷룸·레이어룸·앱을 한 서버에 올려도 데이터가 섞이지 않습니다.

### 서버측 쿼리 예시

```js
// 조건 필터 + 정렬 (서버에서 거르고 정렬해서 돌려줌)
const open = await ig.list('requests', {
  filter: [['status', 'eq', 'open'], ['budget', 'gte', 1000000]],
  sort: ['createdAt', 'desc'], limit: 20
});
// 건수만 (데이터는 안 받음)
const n = await ig.count('requests', { filter: [['status', 'eq', 'open']] });
```

연산자: eq, ne, gt, gte, lt, lte, contains. REST로는 `?filter=status:eq:open&sort=createdAt:desc` 형식입니다.

### 공개키 / 비밀키

- **공개키**(igk_...): 웹앱·앱에 넣어 배포. 회원가입·로그인·본인 데이터.
- **비밀키**(sk_...): 봇·엔진 등 서버에서만 사용. 전체 데이터 접근(서버 권한). 클라이언트에 노출 금지.

딜러 봇·계 운영 엔진처럼 공정한 심판 역할을 하는 서버 프로세스는 비밀키를 쓰면 됩니다.

### 플랜 / 스키마 / 휴지통

플랜과 한도, 컬렉션 스키마는 관리 대시보드의 프로젝트 상세에서 설정합니다. 플랜은 free·pro·unlimited이고, 개별 한도 조정도 됩니다. 스키마를 등록하면 해당 컬렉션에 잘못된 데이터를 쓰려 할 때 서버가 422로 거부합니다.

```js
// 소프트 삭제 (휴지통으로)
await ig.remove('notes', id);
// 휴지통 조회 → 복구
const trashed = await ig.trash('notes');
await ig.restore('notes', id);
// 영구 삭제 (복구 불가)
await ig.remove('notes', id, { hard: true });
// 사용량 확인
const usage = await fetch(base + '/api/project/usage', { headers: { 'X-Project-Key': key } }).then(r => r.json());

// 배치 (여러 건 한 번에)
await ig.batch('items', [
  { op: 'create', data: { name: '사과' } },
  { op: 'update', id: 'd_xxx', data: { name: '수정' } },
  { op: 'delete', id: 'd_yyy' },
]);
// 전문 검색
const found = await ig.search('items', '사과', { filter: [['price', 'gte', 2000]] });
// 비밀번호 재설정
await ig.requestReset('user@test.com');      // 토큰이 웹훅으로 발송됨
await ig.resetPassword(token, 'newpassword'); // 수신한 토큰으로 변경
```

> 플랜·쿼터는 결제 기능이 아니라, 한 서버에 여러 프로젝트를 올릴 때 한쪽이 자원을 독식하지 못하게 막는 한도입니다. 자기 인프라로만 쓰면 unlimited로 두면 됩니다.

### 변경 이력 · 범위 키 · 예약 작업

```js
// 변경 이력 조회 → 특정 버전으로 롤백
const hist = await ig.history('docs', id);     // [{version, op, data, created_at}, ...]
await ig.rollback('docs', id, hist[2].version);
```

### 레코드 공유 · 집계

```js
// 특정 유저에게만 공유 (소유자만 설정 가능)
await ig.share('notes', id, { public: false, readers: ['u_친구id'], writers: [] });
// 집계: 카테고리별 매출 합계
const r = await ig.aggregate('orders', { op: 'sum', field: 'price', groupBy: 'cat' });
// → { op:'sum', groups: [{group:'과일', value:4500}, ...] }
```

범위 제한 키와 예약 작업은 관리 대시보드의 프로젝트 "키·웹훅·예약작업"에서 관리합니다. 대시보드 "데이터" 탭에서는 프로젝트의 레코드를 직접 조회·검색·편집·삭제·복구할 수 있습니다.
- 범위 키: 읽기전용 키(앱에 안전하게 배포), 특정 컬렉션만 허용하는 키, 만료 기한 키를 프로젝트마다 여러 개 발급.
- 예약 작업: 오래된 레코드 자동 정리, 휴지통 자동 비우기, 웹훅 주기 호출을 간격(분)으로 지정. "실행" 버튼으로 즉시 실행도 가능.

## 실행 방법

### 1. 로컬 (가장 간단)

- Windows: `시작.bat` 더블클릭
- Mac / Linux / 라즈베리파이: `bash start.sh`

최초 1회 구성요소를 설치하고 바로 서버가 뜹니다. 설치되는 DB는 SQLite 파일(`data/igserver.db`) 하나라 별도 설치가 필요 없고, 재시작해도 데이터가 유지됩니다.

관리 대시보드: `http://localhost:8787/admin/`
기본 관리자: `admin@studio-ig.local` / `admin1234` (운영 전 변경)

### 2. 단독 실행파일 (Node 설치 불필요) — 가장 편함

실행파일 하나로 켜집니다. Node.js도, `npm install`도 필요 없습니다.

**받는 방법 A — GitHub Actions (권장)**
1. 이 폴더를 GitHub 저장소에 올립니다.
2. 저장소 Actions 탭 → `단독 실행파일 빌드` → `Run workflow` 실행.
3. 빌드가 끝나면 Artifacts에서 `igserver-win-x64`(또는 mac/linux)를 받습니다.
4. 압축을 풀고 `igserver.exe`(Mac/Linux는 `igserver`)를 더블클릭하면 서버가 켜집니다.
   - 버전 태그(`v1.0.0` 등)를 push하면 Release에 zip이 자동 첨부됩니다.

**받는 방법 B — 직접 빌드**
빌드 머신에 Node 22가 있으면:
```
npm install
npm run build      # dist/ 에 실행파일 생성
```
`dist/` 폴더를 통째로 옮기면 그 PC엔 Node가 없어도 실행됩니다.

> 빌드는 Node 22 내장 SEA 방식이라 외부 다운로드 없이 각 OS에서 만들어집니다(nodejs.org 접근 불필요). 실행파일 옆의 `better_sqlite3.node`와 `public/` 폴더는 함께 두세요. 데이터는 같은 폴더 `data/`에 저장되어 재시작해도 유지됩니다.

### 3. 클라우드 / 서버 (Docker)

```
docker compose up -d
```

igServer + PostgreSQL이 함께 뜹니다. Fly.io·Render·VPS 어디서나 동일하게 동작하고, WebSocket과 영속 저장이 모두 됩니다.

## 내가 만든 앱에 붙이는 법

1. 대시보드에서 프로젝트를 만들고 **API 키**를 받습니다.
2. 앱에 `igclient.js`를 넣고 2줄로 연동합니다.

```js
const ig = igClient('http://서버주소:8787', 'API_키');

await ig.signup('user@test.com', 'password', '홍길동');
const doc = await ig.create('posts', { title: '첫 글' });
const list = await ig.list('posts');
ig.subscribe('chat', (msg) => console.log(msg));  // 실시간
const file = await ig.upload(blob, 'photo.png');  // 파일
```

REST로 직접 호출해도 됩니다. 대시보드의 "연동 가이드" 탭에 프로젝트 키가 채워진 예제가 있습니다.

## 여러 대로 확장 (라즈베리파이 + PC 혼합)

같은 프로그램을 여러 노드에 깔고 역할만 지정합니다.

- 대표 노드 (로드밸런서): `MODE=gateway`
- 작업 노드 (라즈베리파이·PC): `MODE=worker GATEWAY_URL=http://대표주소:8787 SELF_URL=http://이노드주소:8787`

워커는 게이트웨이에 자동 등록되고, 게이트웨이가 요청을 부하가 적은 노드로 분배합니다. 노드 상태는 대시보드 "클러스터 노드"에서 봅니다. 여러 노드가 같은 PostgreSQL(`DATABASE_URL`)을 바라보면 데이터도 공유됩니다.

라즈베리파이는 API·가벼운 웹앱·상시 서비스에, PC는 영상 처리·게임 서버처럼 무거운 작업에 적합합니다.

## 주요 엔드포인트

| 구분 | 메서드 | 경로 |
|---|---|---|
| 회원가입 | POST | `/api/auth/signup` |
| 로그인 | POST | `/api/auth/login` |
| 데이터 생성 | POST | `/api/data/:collection` |
| 데이터 조회 | GET | `/api/data/:collection` / `/:id` |
| 파일 업로드 | POST | `/api/files?filename=` |
| 실시간 | WS | `/ws?key=&token=` |
| 헬스체크 | GET | `/healthz` |
| 메트릭 | GET | `/metrics` (Prometheus) |
| 관리 API | - | `/admin/api/*` |

모든 `/api` 요청에는 `X-Project-Key` 헤더(또는 `?key=`)로 프로젝트를 지정합니다.

## 검증

```
npm run smoke     # 전체 플로우 32개 항목 검증
npm run cluster   # 게이트웨이+워커2 클러스터 검증
```

## 환경설정

`.env.example`을 `.env`로 복사해 수정합니다. 아무것도 설정하지 않아도 기본값으로 동작합니다. `DATABASE_URL`을 넣으면 SQLite에서 PostgreSQL로 자동 전환됩니다.
