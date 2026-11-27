// Service Worker: Offline-Cache + Empfang geteilter Dateien (Android "Teilen → Mulchkarten")
const VERSION = 'mk-1.6.2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/georef.js',
  './js/model.js',
  './js/overview.js',
  './js/pdfimport.js',
  './vendor/d3.min.js',
  './vendor/pdf-lib.min.js',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' umgeht den HTTP-Cache (GitHub Pages: 10 min), sonst landen alte Dateien im neuen Cache
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'share-inbox') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('files');
      const inbox = await caches.open('share-inbox');
      let i = 0;
      for (const f of files) {
        if (!(f instanceof File)) continue;
        await inbox.put(new Request(`./share-inbox/${Date.now()}-${i++}`), new Response(f, {
          headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': f.type || 'application/octet-stream' },
        }));
      }
      return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Versionsdatei immer frisch vom Server
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });
    if (cached) return cached;
    try {
      return await fetch(e.request);
    } catch (err) {
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
