const CACHE = "gvdg-club-v4";
const ASSETS = [
  "img/logo.png",
  "img/logo2.png",
  "club.webmanifest",
  "site.webmanifest",
  "gvdg-members.html",
  "admin.html",
  "score.html",
];
const DEFAULT_SHELL = "gvdg-members.html";
const DOCUMENT_SHELLS = new Map([
  ["/admin", "admin.html"],
  ["/admin.html", "admin.html"],
  ["/score", "score.html"],
  ["/score.html", "score.html"],
  ["/gvdg-members", "gvdg-members.html"],
  ["/gvdg-members.html", "gvdg-members.html"],
]);

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

  if (req.mode === "navigate" || req.destination === "document") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match(DOCUMENT_SHELLS.get(url.pathname) || DEFAULT_SHELL))),
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
        .catch(() => caches.match(DEFAULT_SHELL));
    }),
  );
});
