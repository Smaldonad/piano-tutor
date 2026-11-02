'use strict';
// Offline support: the app's own files are kept on the device so it opens without the Mac.
// Each launch serves the saved copy at once and, if the Mac is reachable, refreshes it in the
// background; a changed file means a new version, used from the next launch.
const SHELL = 'pt-shell';
const FILES = [
  'index.html', 'styles.css', 'manifest.webmanifest',
  'js/themes.js', 'js/theory.js', 'js/midi.js', 'js/audio.js', 'js/app.js',
  'fonts/Bravura.woff2', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const urls = FILES.map(f => new URL(f, self.registration.scope).href);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(urls.map(u => new Request(u, { cache: 'no-store' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function refresh(cache, url, cached) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const changed = !cached || res.headers.get('Last-Modified') !== cached.headers.get('Last-Modified');
    await cache.put(url, res);
    if (changed && cached) for (const c of await self.clients.matchAll()) c.postMessage('updated');
  } catch (e) { /* Mac not reachable: keep the saved copy */ }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.mode === 'navigate' ? urls[0] : req.url.split('?')[0];
  if (!urls.includes(url)) return; // API calls, MIDI files etc. go straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(url);
    const update = refresh(cache, url, cached);
    if (cached) { e.waitUntil(update); return cached; }
    await update;
    return (await cache.match(url)) || fetch(req);
  })());
});
