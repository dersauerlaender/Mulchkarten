// Service Worker: Offline-Cache + Empfang geteilter Dateien (Android "Teilen → Mulchkarten")
const VERSION = 'mk-1.11.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/georef.js',
  './js/gestures.js',
  './js/model.js',
  './js/overview.js',
  './js/pdfimport.js',
  './js/rotation.js',
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

// ---- OpenStreetMap-Kacheln zwischenspeichern (angesehene Gegenden auch offline) ----
const TILE_CACHE = 'osm-tiles';
const TILE_MAX = 3000;                    // ca. 40–60 MB
const TILE_MAX_AGE = 30 * 864e5;          // nach 30 Tagen im Hintergrund erneuern
let tilePuts = 0;

async function trimTiles(cache) {
  const keys = await cache.keys();        // Einfügereihenfolge = älteste zuerst
  for (let i = 0; i < keys.length - TILE_MAX + 200 && keys.length > TILE_MAX; i++) await cache.delete(keys[i]);
}

async function fetchTile(url, cache) {
  // als CORS-Anfrage, damit die Antwort nicht "undurchsichtig" ist (sonst rechnet Chrome sie riesig an)
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (res.ok) {
    await cache.put(url, res.clone());
    if (++tilePuts % 100 === 0) trimTiles(cache);
  }
  return res;
}

async function tileResponse(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) {
    const age = Date.now() - new Date(hit.headers.get('date') || 0).getTime();
    if (age > TILE_MAX_AGE) fetchTile(req.url, cache).catch(() => {});   // im Hintergrund erneuern
    return hit;
  }
  try {
    return await fetchTile(req.url, cache);
  } catch {
    try { return await fetch(req); } catch { return new Response('', { status: 504 }); }
  }
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'share-inbox' && k !== TILE_CACHE) await caches.delete(k);
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
  if (e.request.method === 'GET' && url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(tileResponse(e.request));
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
