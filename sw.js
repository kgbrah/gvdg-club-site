// Service worker for the GVDG live-scoring app (score.html). The app document is served NETWORK-FIRST
// so a new deploy is always picked up when online (cache-first previously pinned a stale/broken build and
// could cache the /score.html -> /score redirect). Static assets are cache-first. The cross-origin Worker
// API (auth.*) is never intercepted — offline score writes are queued in the page and flushed on reconnect.
const CACHE = "gvdg-score-v3"; // bump to evict any older (possibly stale/broken) cache on activate
const ASSETS = ["img/logo.png"];
const SHELL = "score.html"; // offline fallback for the app document

// Only clean, same-origin 200s are safe to cache (never opaque/redirect/error responses).
function cacheable(res) {
  return res && res.ok && res.status === 200 && res.type === "basic";
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // let the cross-origin API pass through

  // App document: network-first (always the latest score.html online), cached only as an offline fallback.
  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(SHELL)),
    );
    return;
  }

  // Static assets: cache-first, but only ever store clean 200s.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(SHELL));
    }),
  );
});
