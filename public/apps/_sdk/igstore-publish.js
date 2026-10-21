// igStore 발행 위젯 — 어떤 STUDIO ig 툴에나 한 줄로 붙이는 "igStore에 올리기" 버튼.
// webmax·레이어룸·컷룸·IG Sound·GAE 등 각 툴이 산출물(파일/링크)을 바로 스토어에 발행·판매·배포한다.
// 새로 만들지 않고 igclient.js(+서버 /api/igstore)를 그대로 재사용한다.
//
// 사용(툴 HTML 하단):
//   <script src="https://서버/app/_sdk/igclient.js"></script>
//   <script src="https://서버/app/_sdk/igstore-publish.js"></script>
//   <script>
//     IGStorePublish.init({
//       base: 'https://서버', key: 'igk_...',   // 생략 시 window.IGSTORE 또는 window.IGPLAY_API 사용
//       kind: 'asset3d',                          // 이 툴의 기본 콘텐츠 종류
//       defaultTitle: '내 3D 모델',
//       getContent: async () => ({ blob: await exportGLB(), filename: 'model.glb' })
//       // 또는 () => ({ url: 'https://...' }) 형태로 외부 링크를 넘겨도 됨
//     });
//   </script>
(function (global) {
  var KIND_LABEL = { game: '게임', level: '레벨', app: '앱', asset3d: '3D에셋', image: '이미지', music: '음원', video: '영상', doc: '문서', bundle: '번들' };
  var FONT = '-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif';
  var CSS = ''
    + '.igsp-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;'
    + 'background:#3aa0ff;color:#fff;border:none;border-radius:999px;padding:12px 18px;font:600 14px/1 ' + FONT + ';'
    + 'box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer;font-style:normal}'
    + '.igsp-fab:hover{filter:brightness(1.06)}'
    + '.igsp-ov{position:fixed;inset:0;z-index:2147483001;background:rgba(10,12,16,.55);display:grid;place-items:center;padding:16px;font:400 14px/1.5 ' + FONT + ';font-style:normal}'
    + '.igsp-card{width:100%;max-width:440px;max-height:88vh;overflow:auto;background:#161a20;color:#e9edf2;border:1px solid #2a3340;border-radius:16px;padding:22px}'
    + '.igsp-card h3{margin:0 0 14px;font-size:18px;font-weight:700}'
    + '.igsp-card label{display:block;font-size:12.5px;color:#9aa6b3;margin:10px 0 4px}'
    + '.igsp-in,.igsp-card select,.igsp-card textarea{width:100%;box-sizing:border-box;background:#0f1319;border:1px solid #2a3340;border-radius:10px;padding:11px 13px;color:#e9edf2;outline:none;font:400 14px ' + FONT + ';font-style:normal}'
    + '.igsp-card textarea{resize:vertical}'
    + '.igsp-row{display:flex;gap:8px}.igsp-row>*{flex:1}'
    + '.igsp-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}'
    + '.igsp-b{border:1px solid #2a3340;background:#0f1319;color:#e9edf2;border-radius:10px;padding:10px 16px;font:600 14px ' + FONT + ';cursor:pointer;font-style:normal}'
    + '.igsp-b.pri{background:#3aa0ff;border-color:#3aa0ff;color:#fff}'
    + '.igsp-note{font-size:12px;color:#9aa6b3;margin-top:8px}'
    + '.igsp-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:2147483002;background:#0f1319;color:#e9edf2;border:1px solid #2a3340;border-radius:10px;padding:10px 16px;font:500 13px ' + FONT + ';box-shadow:0 6px 20px rgba(0,0,0,.3);font-style:normal}';

  function injectCSS() { if (document.getElementById('igsp-css')) return; var s = document.createElement('style'); s.id = 'igsp-css'; s.textContent = CSS; document.head.appendChild(s); }
  function el(tag, attrs, html) { var e = document.createElement(tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(msg) { var t = el('div', { class: 'igsp-toast' }, esc(msg)); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }

  function resolveConfig(opts) {
    var base = opts.base, key = opts.key;
    try { if ((!base || !key) && global.IGSTORE) { base = base || global.IGSTORE.base; key = key || global.IGSTORE.key; } } catch (e) {}
    try { if ((!base || !key) && global.IGPLAY_API) { base = base || global.IGPLAY_API.base; key = key || global.IGPLAY_API.key; } } catch (e) {}
    return { base: base, key: key };
  }

  function init(opts) {
    opts = opts || {};
    injectCSS();
    var cfg = resolveConfig(opts);
    if (!cfg.base || !cfg.key) { console.warn('[IGStorePublish] base/key가 없습니다. init({base,key}) 또는 window.IGSTORE 설정이 필요합니다.'); return; }
    if (typeof global.igClient !== 'function') { console.warn('[IGStorePublish] igclient.js를 먼저 로드하세요.'); return; }
    var ig = global.igClient(cfg.base, cfg.key);

    var fab = el('button', { class: 'igsp-fab', title: 'igStore에 올리기' },
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l2-5h14l2 5M3 9h18l-1.5 11H4.5zM9 13h6"/></svg><span>' + esc(opts.buttonText || 'igStore에 올리기') + '</span>');
    fab.onclick = function () { openDialog(); };
    document.body.appendChild(fab);

    async function openDialog() {
      var ov = el('div', { class: 'igsp-ov' });
      var loggedIn = ig.isLoggedIn();
      var kindOpts = Object.keys(KIND_LABEL).map(function (k) { return '<option value="' + k + '"' + (k === (opts.kind || 'doc') ? ' selected' : '') + '>' + KIND_LABEL[k] + '</option>'; }).join('');
      var authHtml = loggedIn ? '' :
        '<div id="igspAuth"><label>스토어 계정 (처음이면 자동 가입)</label>'
        + '<input class="igsp-in" id="igspEmail" placeholder="이메일" style="margin-bottom:8px">'
        + '<input class="igsp-in" id="igspPw" type="password" placeholder="비밀번호(6자 이상)"><div class="igsp-note">발행하려면 로그인이 필요합니다. 계정이 없으면 자동으로 만들어집니다.</div></div>';
      var card = el('div', { class: 'igsp-card' },
        '<h3>igStore에 올리기</h3>'
        + authHtml
        + '<label>종류</label><select id="igspKind">' + kindOpts + '</select>'
        + '<label>제목</label><input class="igsp-in" id="igspTitle" value="' + esc(opts.defaultTitle || '') + '" placeholder="콘텐츠 제목">'
        + '<label>설명(선택)</label><textarea id="igspDesc" rows="2" placeholder="설명"></textarea>'
        + '<label>태그(쉼표로 구분, 선택)</label><input class="igsp-in" id="igspTags" placeholder="예: 로우폴리, 캐릭터">'
        + '<label>공개 방식</label><select id="igspAccess"><option value="free">무료</option><option value="paid">ISC 유료</option><option value="ad">광고 보고 무료</option><option value="token">토큰 홀더 전용</option></select>'
        + '<div id="igspPaid" style="display:none;margin-top:8px"><input class="igsp-in" id="igspPrice" type="number" min="1" placeholder="가격(ISC)"></div>'
        + '<div id="igspTok" style="display:none;margin-top:8px" class="igsp-row"><input class="igsp-in" id="igspSym" placeholder="토큰 심볼(예: JOON)"><input class="igsp-in" id="igspMin" type="number" min="1" placeholder="최소 보유 수량"></div>'
        + '<div class="igsp-btns"><button class="igsp-b" id="igspCancel">취소</button><button class="igsp-b pri" id="igspGo">올리기</button></div>');
      ov.appendChild(card); document.body.appendChild(ov);
      ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
      card.querySelector('#igspCancel').onclick = function () { ov.remove(); };
      var acc = card.querySelector('#igspAccess');
      acc.onchange = function () {
        card.querySelector('#igspPaid').style.display = acc.value === 'paid' ? 'block' : 'none';
        card.querySelector('#igspTok').style.display = acc.value === 'token' ? 'flex' : 'none';
      };
      card.querySelector('#igspGo').onclick = async function () {
        var go = card.querySelector('#igspGo'); go.disabled = true; go.textContent = '올리는 중…';
        try {
          if (!ig.isLoggedIn()) {
            var email = card.querySelector('#igspEmail').value.trim(), pw = card.querySelector('#igspPw').value;
            if (!email || pw.length < 6) { toast('이메일과 6자 이상 비밀번호를 입력하세요'); throw new Error('auth');
            }
            try { await ig.login(email, pw); } catch (e) { await ig.signup(email, pw, email.split('@')[0]); }
          }
          var title = card.querySelector('#igspTitle').value.trim();
          if (!title) { toast('제목을 입력하세요'); throw new Error('title'); }
          var meta = { kind: card.querySelector('#igspKind').value, title: title, desc: card.querySelector('#igspDesc').value.trim(), access: acc.value, source: opts.source || 'sdk' };
          var tags = card.querySelector('#igspTags').value.trim(); if (tags) meta.tags = tags.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          if (acc.value === 'paid') { var pr = Math.round(+card.querySelector('#igspPrice').value || 0); if (pr < 1) { toast('가격을 입력하세요'); throw new Error('price'); } meta.price = pr; }
          if (acc.value === 'token') { var sym = card.querySelector('#igspSym').value.trim().toUpperCase(); if (!sym) { toast('토큰 심볼을 입력하세요'); throw new Error('sym'); } meta.gateSymbol = sym; meta.gateMin = Math.round(+card.querySelector('#igspMin').value || 0) || 1; }
          if (opts.cover) meta.cover = opts.cover;
          // 콘텐츠 가져오기: getContent()가 { blob, filename } 또는 { url } 반환
          var content = typeof opts.getContent === 'function' ? await opts.getContent() : null;
          var item;
          if (content && content.blob) item = await ig.store.publishFile(content.blob, content.filename || (title + '.bin'), meta);
          else { if (content && content.url) meta.externalUrl = content.url; item = await ig.store.publish(meta); }
          ov.remove();
          toast('스토어에 올렸습니다: ' + title);
          if (typeof opts.onPublished === 'function') opts.onPublished(item);
        } catch (e) { if (!['auth', 'title', 'price', 'sym'].includes(e.message)) toast(e.message || '발행 실패'); go.disabled = false; go.textContent = '올리기'; }
      };
    }

    return { open: openDialog, client: ig };
  }

  global.IGStorePublish = { init: init };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.IGStorePublish;
})(typeof window !== 'undefined' ? window : globalThis);
