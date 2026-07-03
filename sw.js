const CACHE = "gvdg-club-v26";
const OFFLINE_PAGE = "gvdg-members.html";
const ASSETS = [
  "site.webmanifest",
  "pwa.js",
  "nav.js",
  "crotts.js",
  "img/logo.png",
  "img/icons/app-icon-192.png",
  "img/icons/app-icon-512.png",
  "img/icons/maskable-icon-512.png",
  "img/icons/apple-touch-icon.png",
  OFFLINE_PAGE,
  "score.html",
  "admin.html",
  "weather-display.js",
];
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font", "manifest"]);
const NETWORK_FIRST_DESTINATIONS = new Set(["script", "style", "manifest"]);

function cacheable(res) {
  return res && res.ok && res.status === 200 && res.type === "basic";
}

function staticAsset(req, url) {
  return STATIC_DESTINATIONS.has(req.destination) || /\.(?:css|gif|ico|jpe?g|js|png|svg|webmanifest|webp)$/i.test(url.pathname);
}

function networkFirstAsset(req, url) {
  return NETWORK_FIRST_DESTINATIONS.has(req.destination) || /\.(?:css|js|webmanifest)$/i.test(url.pathname);
}

function cacheResponse(req, res) {
  if (cacheable(res)) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  // Evict old caches and take control. We do NOT force-reload open pages (e.g. /events) on a version bump:
  // that discards scroll position and any in-progress form state. Documents are network-first, so open
  // pages pick up fresh content on their next natural navigation/reload.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match(OFFLINE_PAGE)))
    );
    return;
  }

  if (!staticAsset(req, url)) return;

  if (networkFirstAsset(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => cacheResponse(req, res))
        .catch(() => caches.match(req).then((cached) => cached || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => cacheResponse(req, res))
        .catch(() => (req.destination === "image" ? caches.match("img/logo.png") : Response.error()));
    })
  );
});
