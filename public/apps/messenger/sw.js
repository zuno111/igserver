// ig 메신저 서비스워커. 앱 셸을 캐시해 오프라인에서도 열리고, 설치 가능하게 한다.
const C = 'igmsgr-v1';
const SHELL = [
  '/app/messenger/',
  '/app/messenger/index.html',
  '/app/_sdk/igclient.js',
  '/app/messenger/manifest.webmanifest',
  '/app/messenger/icon.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                         // 쓰기 요청은 그대로 네트워크
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/ws')) return; // API/실시간은 항상 네트워크
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
