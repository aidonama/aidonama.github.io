// Tandau: работа без интернета после первого открытия.
const CACHE = 'tandau-v10';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Страница: сначала сеть (чтобы получать обновления), без сети — из кэша.
  if (req.mode === 'navigate') {
    // Страница статистики не кэшируется и не подменяет главную.
    if (new URL(req.url).pathname.endsWith('/stats.html')) return;
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // Запросы к воркеру (ИИ, аналитика) — всегда в сеть, мимо кэша.
  const host = new URL(req.url).hostname;
  if (host.endsWith('workers.dev') || host.endsWith('googleapis.com') || host.endsWith('firebaseapp.com') || host === 'dns.google') return;
  // Остальное (иконки, шрифты): из кэша, иначе из сети с сохранением.
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return r;
  })));
});
