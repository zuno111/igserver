// igClient — igServer에 붙이는 범용 클라이언트. 어느 웹앱/앱에나 이 파일 하나면 백엔드 연동 끝.
// 사용: const ig = igClient('https://서버주소', '프로젝트키');
(function (global) {
  function igClient(baseUrl, projectKey) {
    baseUrl = baseUrl.replace(/\/$/, '');
    let token = (typeof localStorage !== 'undefined' && localStorage.getItem('ig_token_' + projectKey)) || '';

    async function req(method, path, { body, raw, auth = true, headers: extra } = {}) {
      const headers = { 'X-Project-Key': projectKey, ...(extra || {}) };
      if (auth && token) headers.Authorization = 'Bearer ' + token;
      let payload;
      if (raw !== undefined) { headers['Content-Type'] = 'application/octet-stream'; payload = raw; }
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const res = await fetch(baseUrl + path, { method, headers, body: payload });
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      if (!res.ok) throw Object.assign(new Error(data?.message || data?.error || ('HTTP ' + res.status)), { status: res.status, data });
      return data;
    }

    function setToken(t) { token = t || ''; if (typeof localStorage !== 'undefined') { if (t) localStorage.setItem('ig_token_' + projectKey, t); else localStorage.removeItem('ig_token_' + projectKey); } }

    const api = {
      get token() { return token; },
      get baseUrl() { return baseUrl; },
      get projectKey() { return projectKey; },

      // ---- 인증 ----
      async signup(email, password, name) { const r = await req('POST', '/api/auth/signup', { body: { email, password, name }, auth: false }); setToken(r.token); return r.user; },
      async login(email, password) { const r = await req('POST', '/api/auth/login', { body: { email, password }, auth: false }); setToken(r.token); return r.user; },
      async me() { return (await req('GET', '/api/auth/me')).user; },
      async changePassword(oldPassword, newPassword) { return req('POST', '/api/auth/change-password', { body: { oldPassword, newPassword } }); },
      async requestReset(email) { return req('POST', '/api/auth/request-reset', { body: { email }, auth: false }); },
      async resetPassword(token, newPassword) { return req('POST', '/api/auth/reset', { body: { token, newPassword }, auth: false }); },
      logout() { setToken(''); },
      isLoggedIn() { return !!token; },

      // ---- 데이터 (범용 저장소) ----
      async create(collection, data) { return (await req('POST', '/api/data/' + collection, { body: data })).item; },
      // put(collection, id, data, { rev }) — rev 지정 시 그 버전일 때만 수정(충돌 시 409 rev_conflict 에러)
      async put(collection, id, data, { rev } = {}) {
        const headers = rev != null ? { 'If-Match': String(rev) } : undefined;
        return (await req('PUT', `/api/data/${collection}/${id}`, { body: data, headers })).item;
      },
      // 원자적 증감: inc('scores','u1',{점수:10}) 또는 inc('scores','u1','점수',10)
      async inc(collection, id, fieldOrObj, by = 1) {
        const body = typeof fieldOrObj === 'string' ? { field: fieldOrObj, by } : { fields: fieldOrObj };
        return (await req('POST', `/api/data/${collection}/${id}/inc`, { body })).item;
      },
      // get(collection, id, { expand:['authorId:users'] }) — 참조 필드를 펼쳐 item._expand 에 담아줌
      async get(collection, id, { expand } = {}) {
        const qs = new URLSearchParams(); for (const e of expand || []) qs.append('expand', e);
        const q = qs.toString();
        return (await req('GET', `/api/data/${collection}/${id}${q ? '?' + q : ''}`, { auth: false })).item;
      },
      async list(collection, { private: priv = false, limit = 100, offset = 0, filter, sort, deleted = false, q, expand } = {}) {
        const qs = new URLSearchParams({ limit, offset }); if (priv) qs.set('scope', 'private'); if (deleted) qs.set('deleted', 'true'); if (q) qs.set('q', q);
        for (const f of filter || []) qs.append('filter', Array.isArray(f) ? f.join(':') : `${f.field}:${f.op}:${f.value}`);
        for (const e of expand || []) qs.append('expand', e);
        if (sort) qs.set('sort', Array.isArray(sort) ? sort.join(':') : `${sort.field}:${sort.dir}`);
        return (await req('GET', `/api/data/${collection}?${qs}`)).items;
      },
      // 전문 검색 (data의 모든 텍스트에서 q 검색)
      async search(collection, q, opts = {}) { return this.list(collection, { ...opts, q }); },
      // 집계: op=sum|avg|min|max|count, field, groupBy, filter. groupBy 있으면 {groups:[{group,value}]}, 없으면 {value}
      async aggregate(collection, { op = 'count', field, groupBy, filter } = {}) {
        const qs = new URLSearchParams({ op }); if (field) qs.set('field', field); if (groupBy) qs.set('groupBy', groupBy);
        for (const f of filter || []) qs.append('filter', Array.isArray(f) ? f.join(':') : `${f.field}:${f.op}:${f.value}`);
        return req('GET', `/api/data/${collection}/_aggregate?${qs}`);
      },
      // 건수만 (전체 받지 않음). filter는 list와 동일 형식.
      async count(collection, { private: priv = false, filter } = {}) {
        const qs = new URLSearchParams(); if (priv) qs.set('scope', 'private');
        for (const f of filter || []) qs.append('filter', Array.isArray(f) ? f.join(':') : `${f.field}:${f.op}:${f.value}`);
        return (await req('GET', `/api/data/${collection}/_count?${qs}`)).count;
      },
      async remove(collection, id, { hard = false } = {}) { return req('DELETE', `/api/data/${collection}/${id}${hard ? '?hard=true' : ''}`); },
      // 배치: ops = [{op:'create'|'update'|'delete', id?, data?, hard?}]
      async batch(collection, ops) { return req('POST', `/api/data/${collection}/_batch`, { body: { ops } }); },
      async restore(collection, id) { return (await req('POST', `/api/data/${collection}/${id}/restore`)).item; },
      // 변경 이력 조회 / 특정 버전으로 롤백
      async history(collection, id, { limit = 100 } = {}) { return (await req('GET', `/api/data/${collection}/${id}/history?limit=${limit}`)).history; },
      async rollback(collection, id, version) { return (await req('POST', `/api/data/${collection}/${id}/rollback`, { body: { version } })).item; },
      // 레코드 공유: { public, readers:[uid], writers:[uid] }
      async share(collection, id, acl) { return (await req('POST', `/api/data/${collection}/${id}/share`, { body: acl })).item; },
      async trash(collection, opts = {}) { return (await this.list(collection, { ...opts, deleted: true })); },

      // ---- 파일 ----
      async upload(blob, filename) {
        const buf = blob instanceof ArrayBuffer ? blob : (blob.arrayBuffer ? await blob.arrayBuffer() : blob);
        const r = await req('POST', '/api/files?filename=' + encodeURIComponent(filename || 'file'), { raw: buf });
        return r.file;
      },
      async listFiles() { return (await req('GET', '/api/files')).items; },
      async deleteFile(id) { return req('DELETE', '/api/files/' + id); },
      fileUrl(id) { return `${baseUrl}/api/files/${id}?key=${projectKey}`; },

      // ---- 실시간 WebSocket ----
      // subscribe(room, onMessage, { onPresence }) — onPresence(members[]) 로 방 접속자 명단 변경 수신
      subscribe(room, onMessage, opts = {}) {
        const wsUrl = `${baseUrl.replace('http', 'ws')}/ws?key=${projectKey}${token ? '&token=' + token : ''}`;
        const ws = new WebSocket(wsUrl);
        let closed = false;
        ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', room }));
        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.type === 'presence' && opts.onPresence) opts.onPresence(m.members, m);
            else if (m.type === 'subscribed' && opts.onPresence && m.members) opts.onPresence(m.members, m);
            else if (m.type === 'message' || m.type === 'data_changed') onMessage(m);
          } catch {}
        };
        ws.onclose = () => { if (!closed) setTimeout(() => api.subscribe(room, onMessage, opts), 2000); };
        const handle = {
          socket: ws,
          publish: (data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'publish', room, data })),
          who: () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'who', room })),
          close: () => { closed = true; ws.close(); },
        };
        return handle;
      },
      // 현재 프로젝트 접속자 상세 조회 (REST)
      async presence() { return (await req('GET', '/api/project/presence')).online; },

      // 실시간 데이터 구독: 컬렉션의 생성/수정/삭제를 실시간 수신.
      // live('messages', (ev) => { ev.op, ev.id, ev.data }) — 내부적으로 'data:컬렉션' 방 구독.
      // 비공개(_acl) 레코드 변경은 권한 있는 로그인 사용자에게만 전달된다.
      live(collection, onChange, opts = {}) {
        return this.subscribe('data:' + collection, (m) => { if (m.type === 'data_changed') onChange(m); }, opts);
      },

      // ---- NAS (파일 저장·공유 서버) ----
      nas: {
        // 폴더 내용: { path, folders:[], files:[] }
        async list(p = '/') { return req('GET', '/api/nas/list?path=' + encodeURIComponent(p)); },
        async mkdir(p) { return (await req('POST', '/api/nas/folder', { body: { path: p } })).folder; },
        // upload('/사진/a.jpg', blobOrArrayBuffer)
        async upload(p, blob) { const buf = blob instanceof ArrayBuffer ? blob : (blob && blob.arrayBuffer ? await blob.arrayBuffer() : blob); return (await req('POST', '/api/nas/upload?path=' + encodeURIComponent(p), { raw: buf })).file; },
        async meta(p) { return (await req('GET', '/api/nas/meta?path=' + encodeURIComponent(p))).item; },
        async move(from, to) { return req('POST', '/api/nas/move', { body: { from, to } }); },
        async remove(p) { return req('DELETE', '/api/nas/delete?path=' + encodeURIComponent(p)); },
        // 공유 링크 발급(파일). expiresInSec 생략 시 무기한. 반환 file.share.url
        async share(p, expiresInSec) { return (await req('POST', '/api/nas/share', { body: { path: p, expiresInSec } })).file; },
        async unshare(p) { return req('DELETE', '/api/nas/share?path=' + encodeURIComponent(p)); },
        async usage() { return req('GET', '/api/nas/usage'); },
        fileUrl(p) { return `${baseUrl}/api/nas/file?path=${encodeURIComponent(p)}&key=${projectKey}`; },
        async download(p) { const r = await fetch(`${baseUrl}/api/nas/file?path=${encodeURIComponent(p)}&key=${projectKey}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); },
      },
    };
    return api;
  }

  global.igClient = igClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = igClient;
})(typeof window !== 'undefined' ? window : globalThis);
