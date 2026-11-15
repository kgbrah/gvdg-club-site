const CACHE = "gvdg-club-v263";
const OFFLINE_PAGE = "gvdg-members.html";
const ASSETS = [
  "tokens.css",
  "public-polish.css",
  "img/fonts/archivo.woff2",
  "img/fonts/bebas-neue.woff2",
  "watch-pairing.css",
  "phone-activity.css",
  "score-polish.css",
  "member-surfaces.css",
  "member-archive.css",
  "admin-polish.css",
  "homepage-polish.css",
  "home-polish-sections.css",
  "scoring-app.html",
  "scoring-app.css",
  "site.webmanifest",
  "pwa.js",
  "admin-app/admin-app.js",
  "home-app/home-app.js",
  "public-app/public-app.js",
  "tee-sign-preview-app/tee-sign-preview-app.js",
  "img/logo.png",
  "img/icons/app-icon-192.png",
  "img/icons/app-icon-512.png",
  "img/icons/maskable-icon-512.png",
  "img/icons/apple-touch-icon.png",
  OFFLINE_PAGE,
  "members-app/members-app.js",
  "score.html",
  "score-app/score-app.js"
];
const STATIC_DESTINATIONS = new Set(["script", "style", "image", "font", "manifest"]);

function cacheable(res) {
  return res && res.ok && res.status === 200 && res.type === "basic";
}

function staticAsset(req, url) {
  return STATIC_DESTINATIONS.has(req.destination) || /\.(?:css|gif|ico|jpe?g|js|png|svg|webmanifest|webp)$/i.test(url.pathname);
}

function isCodeAsset(req, url) {
  return req.destination === "script" || req.destination === "style" || req.destination === "manifest"
    || /\.(?:js|css|webmanifest)$/i.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (asset) => {
      try {
        const res = await fetch(asset, { cache: "reload" });
        if (res && res.ok) await cache.put(asset, res);
      } catch {
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== "gvdg-maps-v2").map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const appClients = new Set();

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "APP_WINDOW" && event.source && event.source.id) {
    appClients.add(event.source.id);
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "GET" && url.hostname.endsWith("arcgisonline.com") && url.pathname.includes("/World_Imagery/")) {
    event.respondWith((async () => {
      const cache = await caches.open("gvdg-maps-v2");
      const cached = await cache.match(req);
      try {
        // Image tags are no-cors, so a failed Esri response is opaque and used to get pinned forever.
        const res = await fetch(req.url, { mode: "cors", credentials: "omit", cache: "no-store" });
        const type = res.headers.get("content-type") || "";
        if (res.ok && type.startsWith("image/")) {
          cache.put(req, res.clone()).catch(() => {});
          return res;
        }
        return cached || res;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // A notification image fetch has no window. Answer it from the cache and
  // Brave draws its own lion instead of the club mark.
  if (!event.clientId && (url.pathname === "/img/icons/app-icon-192.png" || url.pathname === "/img/icons/notification-badge.png")) return;

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
        .catch(async () => {
          const exact = await caches.match(req);
          if (exact) return exact;
          if (url.pathname === "/score.html") {
            const scorer = await caches.match("score.html");
            if (scorer) return scorer;
          }
          return caches.match(OFFLINE_PAGE);
        })
    );
    return;
  }

  if (!staticAsset(req, url)) return;

  if (isCodeAsset(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const exact = await caches.match(req);
          if (exact) return exact;
          // HTML cache-busters must also work on the first offline scorer visit:
          // install precaches the canonical bundle before any ?v= URL is opened.
          const asset = url.pathname.slice(1);
          if (ASSETS.includes(asset) && [...url.searchParams.keys()].every((key) => key === "v")) {
            const installed = await caches.match(asset);
            if (installed) return installed;
          }
          return Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => (req.destination === "image" ? caches.match("img/logo.png") : Response.error()));
    })
  );
});

function adminNotificationUrl(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/admin.html") || raw.startsWith("//") || raw.includes("\\") || raw.includes("://")) {
    return new URL("/admin.html", self.location.origin).href;
  }
  return new URL(raw, self.location.origin).href;
}

function readPush(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== "object") data = {};
  return {
    title: typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 80) : "GVDG admin",
    body: typeof data.body === "string" ? data.body.slice(0, 180) : "",
    tag: typeof data.tag === "string" && data.tag.trim() ? data.tag.trim().slice(0, 80) : "gvdg-admin",
    url: typeof data.url === "string" ? data.url : "/admin.html",
  };
}

async function openAdmin(target) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const alive = new Set(all.map((client) => client.id));
  for (const id of appClients) if (!alive.has(id)) appClients.delete(id);
  // Only reuse the installed app. A Chrome tab must not catch the tap.
  for (const client of all) {
    if (!appClients.has(client.id)) continue;
    let url;
    try { url = new URL(client.url); } catch { continue; }
    if (url.origin !== self.location.origin) continue;
    try {
      if (typeof client.navigate === "function") {
        const next = await client.navigate(target);
        if (next && typeof next.focus === "function") return next.focus();
      }
    } catch {
      /* open a fresh app window below */
    }
    if (typeof client.focus === "function") return client.focus();
  }
  if (self.clients.openWindow) return self.clients.openWindow(target);
}

self.addEventListener("push", (event) => {
  const note = readPush(event);
  const icon = new URL("/img/icons/app-icon-192.png", self.location.origin).href;
  const badge = new URL("/img/icons/notification-badge.png", self.location.origin).href;
  event.waitUntil(self.registration.showNotification(note.title, {
    body: note.body,
    tag: note.tag,
    data: { url: note.url },
    icon,
    badge,
  }));
});

function rangeNotificationUrl(raw) {
  if (typeof raw === "string" && raw.startsWith("/score.html") && !raw.startsWith("//") && !raw.includes("\\") && !raw.includes("://")) {
    return new URL(raw, self.location.origin).href;
  }
  return new URL("/score.html", self.location.origin).href;
}

async function focusScore(target) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const scores = [];
  for (const client of all) {
    let url;
    try { url = new URL(client.url); } catch { continue; }
    if (url.origin !== self.location.origin) continue;
    if (!url.pathname.endsWith("/score.html")) continue;
    scores.push(client);
  }
  const installed = scores.find((client) => appClients.has(client.id));
  const client = installed || scores[0];
  if (client && typeof client.focus === "function") return client.focus();
  if (self.clients.openWindow) return self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  if (data.kind === "range" || data.kind === "talk") {
    if (data.kind === "talk") event.notification.close();
    event.waitUntil(focusScore(rangeNotificationUrl(data.url)));
    return;
  }
  event.notification.close();
  const target = adminNotificationUrl(data.url);
  event.waitUntil(openAdmin(target));
});
