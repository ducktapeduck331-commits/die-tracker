/* Sig Tau Beer Die service worker.
   - App shell is precached so the app opens with no signal.
   - index.html and other same-origin files are network-first (so deploys show up right away),
     falling back to the cache when offline or slow.
   - The Firebase SDK and Google Fonts are cached on first use (versioned, safe to keep).
   - Firebase API traffic (Firestore, Auth) is never touched: Firestore has its own offline cache. */
const VERSION = 'beer-die-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'firebase-config.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(VERSION);
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(t);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (fallbackUrl && await cache.match(fallbackUrl));
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, req.mode === 'navigate' ? 'index.html' : null));
  } else if (STATIC_HOSTS.includes(url.hostname) || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))) {
    e.respondWith(cacheFirst(req));
  }
  // anything else (firestore.googleapis.com, identitytoolkit, securetoken, ...) goes straight to the network
});
