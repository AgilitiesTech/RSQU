'use strict';
// HitchPoint dashboard service worker (scope /admin/). Keeps a copy of the app shell so the dashboard
// opens fast and can show a friendly page offline. It never stores /api/ responses: requests,
// customers and payments always come fresh from the server.
const CACHE = 'hitchpoint-shell-v2';
const SHELL = ['/admin/', '/admin/offline.html', '/static/admin.js', '/static/app.css', '/static/hp.css', '/favicon.svg', '/static/brand/icon-192.png', '/static/brand/logo.svg', '/static/brand/logo-on-dark.svg', '/static/brand/topo.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // never cached
  if (req.mode === 'navigate') {
    // Always the live page when online; the offline page when not.
    e.respondWith(fetch(req).catch(() => caches.match('/admin/offline.html')));
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  // Network first so updates show up right away; the saved copy only when offline.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});
