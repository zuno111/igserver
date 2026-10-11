// 레코드 단위 공유 권한(ACL). 레코드 data 안의 예약 필드 _acl 로 제어.
// _acl = { public: bool, readers: [userId], writers: [userId] }
// 소유자(owner_id)와 서버/관리 권한(role==='admin')은 항상 전체 권한.
// _acl 이 없으면 기존 동작(공개 읽기, 소유자만 쓰기)을 유지한다.

export function getAcl(rec) {
  return (rec && rec.data && rec.data._acl) || null;
}

export function canWrite(rec, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;        // secret/scoped 서버 유저, admin
  if (!rec.owner_id) return true;                 // 공용 레코드(소유자 없음)
  if (rec.owner_id === user.uid) return true;     // 소유자
  const acl = getAcl(rec);
  if (acl && Array.isArray(acl.writers) && acl.writers.includes(user.uid)) return true;
  return false;
}

export function canRead(rec, user) {
  if (canWrite(rec, user)) return true;
  const acl = getAcl(rec);
  if (!acl) return true;                           // ACL 없으면 공개 읽기(기존 동작)
  if (acl.public === true) return true;
  if (user && Array.isArray(acl.readers) && acl.readers.includes(user.uid)) return true;
  return false;
}

// 소유자만 ACL을 설정할 수 있다.
export function canManageAcl(rec, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return rec.owner_id === user.uid;
}

// 사용자 입력에서 안전한 _acl 만 추출
export function sanitizeAcl(input) {
  const a = input || {};
  const arr = (x) => Array.isArray(x) ? x.filter((v) => typeof v === 'string').slice(0, 1000) : [];
  return { public: a.public === true, readers: arr(a.readers), writers: arr(a.writers) };
}
