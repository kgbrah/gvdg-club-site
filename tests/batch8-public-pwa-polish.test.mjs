import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { sanitizeCrottsActions } from "../src/shared/crotts-actions.js";
import { calendarEventFromPdga } from "../src/shared/event-calendar.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_SOURCE = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const ORIGIN = "https://gvdgclub.com";

function fakeResponse(body, { status = 200, type = "text/plain", responseType = "basic" } = {}) {
  const headers = new Map([["content-type", type]]);
  return {
    ok: status >= 200 && status < 300,
    status,
    type: responseType,
    body,
    headers: {
      get: (name) => headers.get(String(name).toLowerCase()) ?? null,
    },
    clone() {
      return fakeResponse(body, { status, type, responseType });
    },
    async text() {
      return String(body ?? "");
    },
    async json() {
      return JSON.parse(String(body ?? "null"));
    },
  };
}

class MemoryCaches {
  constructor() {
    this.stores = new Map();
  }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const map = this.stores.get(name);
    const keyOf = (req) => new URL(typeof req === "string" ? req : req.url, ORIGIN + "/").href;
    return {
      async match(req) {
        const res = map.get(keyOf(req));
        return res ? (res.clone ? res.clone() : res) : null;
      },
      async put(req, res) { map.set(keyOf(req), res); },
      async delete(req) { return map.delete(keyOf(req)); },
      async keys() { return [...map.keys()].map((url) => ({ url })); },
    };
  }
  async match(req) {
    const url = new URL(typeof req === "string" ? req : req.url, ORIGIN + "/").href;
    for (const map of this.stores.values()) {
      if (map.has(url)) {
        const res = map.get(url);
        return res.clone ? res.clone() : res;
      }
    }
    return undefined;
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
}

function bootWorker(caches, {
  memberChunks = [],
  publicChunks = [],
  files = new Map(),
  online = true,
  now = 1_700_000_000_000,
  windows = [],
  openWindow = async () => null,
} = {}) {
  const handlers = new Map();
  const self = {
    location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
    addEventListener: (name, fn) => handlers.set(name, fn),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow,
    },
    registration: { showNotification: async () => {} },
  };
  const ResponseCtor = class extends Response {
    static error() {
      return { ok: false, status: 0, type: "error", headers: new Map() };
    }
  };
  vm.runInNewContext(SW_SOURCE, {
    URL,
    Response: ResponseCtor,
    self,
    caches,
    Date: Object.assign(class extends Date {}, { now: () => now }),
    importScripts: (scriptPath) => {
      if (scriptPath === "members-app/sw-chunks.js") self.GVDG_MEMBER_CHUNKS = memberChunks;
      if (scriptPath === "public-app/sw-chunks.js") self.GVDG_PUBLIC_CHUNKS = publicChunks;
    },
    fetch: async (req) => {
      if (!online) throw new TypeError("Offline");
      const url = new URL(typeof req === "string" ? req : req.url, ORIGIN + "/").href;
      if (!files.has(url)) return fakeResponse("Not found", { status: 404, type: "text/html" });
      const spec = files.get(url);
      if (typeof spec === "function") return spec(url);
      return fakeResponse(spec.body, spec);
    },
  });
  return {
    async trigger(name, extra = {}) {
      let pending;
      handlers.get(name)({
        ...extra,
        waitUntil: (promise) => { pending = promise; },
      });
      return pending;
    },
    async respondFetch(url, { mode = "cors", destination = "script" } = {}) {
      let result;
      handlers.get("fetch")({
        request: {
          url: new URL(url, ORIGIN + "/").href,
          method: "GET",
          mode,
          destination,
          headers: new Map(),
        },
        respondWith: (promise) => { result = promise; },
      });
      return result;
    },
  };
}

test("sw.js code assets reject HTML fallback and 5xx responses when a valid cached bundle exists", async () => {
  const caches = new MemoryCaches();
  const appUrl = ORIGIN + "/public-app/public-app.js";
  const goodFiles = new Map([
    [appUrl, { status: 200, type: "application/javascript", body: "console.log('v1');" }],
  ]);
  const w1 = bootWorker(caches, { files: goodFiles });
  const liveRes = await w1.respondFetch(appUrl);
  assert.equal(liveRes.status, 200);
  for (let i = 0; i < 20 && !(await caches.match(appUrl)); i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(await caches.match(appUrl));

  // Cloudflare Pages returns 200 text/html during deploy/miss; SW must serve cached JS instead.
  const htmlFiles = new Map([
    [appUrl, { status: 200, type: "text/html; charset=utf-8", body: "<!doctype html><html></html>" }],
  ]);
  const w2 = bootWorker(caches, { files: htmlFiles });
  const fallbackFromHtml = await w2.respondFetch(appUrl);
  assert.equal(await fallbackFromHtml.text(), "console.log('v1');");

  // 503 error response must also fall back to valid cached JS.
  const errFiles = new Map([
    [appUrl, { status: 503, type: "text/plain", body: "upstream error" }],
  ]);
  const w3 = bootWorker(caches, { files: errFiles });
  const fallbackFrom503 = await w3.respondFetch(appUrl);
  assert.equal(await fallbackFrom503.text(), "console.log('v1');");

  // Without any cached copy, a 200 text/html answer for a script or public chunk must fail cleanly as Response.error().
  const emptyCaches = new MemoryCaches();
  const chunkUrl = ORIGIN + "/public-app/chunks/events-missing.js";
  const w4 = bootWorker(emptyCaches, {
    files: new Map([
      [appUrl, { status: 200, type: "text/html; charset=utf-8", body: "<!doctype html><html></html>" }],
      [chunkUrl, { status: 200, type: "text/html; charset=utf-8", body: "<!doctype html><html></html>" }],
    ]),
  });
  const uncachedHtml = await w4.respondFetch(appUrl);
  assert.equal(uncachedHtml.type, "error");
  const uncachedChunkHtml = await w4.respondFetch(chunkUrl);
  assert.equal(uncachedChunkHtml.type, "error");
});

test("sw.js precaches public-app/chunks and retains previous public chunks across two releases", async () => {
  const caches = new MemoryCaches();
  const files = new Map([
    [ORIGIN + "/public-app/chunks/events-aaa.js", { status: 200, type: "application/javascript", body: "export const a=1;" }],
    [ORIGIN + "/public-app/chunks/events-bbb.js", { status: 200, type: "application/javascript", body: "export const b=2;" }],
    [ORIGIN + "/public-app/chunks/events-ccc.js", { status: 200, type: "application/javascript", body: "export const c=3;" }],
  ]);
  for (const [now, publicChunks] of [
    [1000, ["public-app/chunks/events-aaa.js"]],
    [2000, ["public-app/chunks/events-bbb.js"]],
  ]) {
    const w = bootWorker(caches, { publicChunks, files, now });
    await w.trigger("install");
    await w.trigger("activate");
  }

  // Deploy 2 keeps aaa and bbb in gvdg-public-chunks without polluting gvdg-member-chunks.
  const storeAfter2 = caches.stores.get("gvdg-public-chunks");
  assert.ok(storeAfter2.has(ORIGIN + "/public-app/chunks/events-aaa.js"));
  assert.ok(storeAfter2.has(ORIGIN + "/public-app/chunks/events-bbb.js"));
  assert.equal(Boolean(caches.stores.get("gvdg-member-chunks")?.has(ORIGIN + "/public-app/chunks/events-aaa.js")), false);

  // Serving public-app/chunks offline after server removes aaa works from gvdg-public-chunks.
  const wOffline = bootWorker(caches, { publicChunks: ["public-app/chunks/events-bbb.js"], online: false, now: 2500 });
  const oldPublicChunk = await wOffline.respondFetch("/public-app/chunks/events-aaa.js");
  assert.equal(await oldPublicChunk.text(), "export const a=1;");

  // Deploy 3 prunes aaa while keeping bbb and ccc.
  const w3 = bootWorker(caches, { publicChunks: ["public-app/chunks/events-ccc.js"], files, now: 3000 });
  await w3.trigger("install");
  await w3.trigger("activate");
  assert.equal(storeAfter2.has(ORIGIN + "/public-app/chunks/events-aaa.js"), false);
  assert.ok(storeAfter2.has(ORIGIN + "/public-app/chunks/events-bbb.js"));
  assert.ok(storeAfter2.has(ORIGIN + "/public-app/chunks/events-ccc.js"));
});

test("sw.js offline navigation falls back to scoring-app.html (with query), gvdg-members.html, and Response.error() when uncached", async () => {
  const caches = new MemoryCaches();
  const cache = await caches.open("gvdg-club-v370");
  await cache.put("scoring-app.html", fakeResponse("<html>scoring app shell</html>", { type: "text/html" }));
  await cache.put("gvdg-members.html", fakeResponse("<html>members shell</html>", { type: "text/html" }));

  const wOffline = bootWorker(caches, { online: false });
  const scoringRes = await wOffline.respondFetch("/scoring-app.html?utm=1", { mode: "navigate", destination: "document" });
  assert.equal(await scoringRes.text(), "<html>scoring app shell</html>");

  const fallbackRes = await wOffline.respondFetch("/events.html", { mode: "navigate", destination: "document" });
  assert.equal(await fallbackRes.text(), "<html>members shell</html>");

  const emptyCaches = new MemoryCaches();
  const wEmpty = bootWorker(emptyCaches, { online: false });
  const missingRes = await wEmpty.respondFetch("/events.html", { mode: "navigate", destination: "document" });
  assert.equal(missingRes.type, "error");
});

test("sw.js persists APP_WINDOW client ids across activate & restart and prunes dead ids", async () => {
  const caches = new MemoryCaches();
  const w1 = bootWorker(caches);
  await w1.trigger("message", { data: { type: "APP_WINDOW" }, source: { id: "pwa-win-1" } });
  await w1.trigger("message", { data: { type: "APP_WINDOW" }, source: { id: "dead-win-9" } });
  await w1.trigger("message", { data: { type: "APP_WINDOW" }, source: { id: "score-win-2" } });

  // Running activate must keep gvdg-app-windows intact.
  await w1.trigger("activate");
  assert.ok(caches.stores.has("gvdg-app-windows"));

  let focused = null;
  let navigated = null;
  let openedNew = null;
  const adminWin = {
    id: "pwa-win-1",
    url: ORIGIN + "/admin.html",
    async navigate(url) {
      navigated = url;
      return adminWin;
    },
    async focus() {
      focused = adminWin.id;
      return adminWin;
    },
  };
  const browserTab = {
    id: "browser-tab-3",
    url: ORIGIN + "/admin.html",
    async navigate() { throw new Error("browser tab must not be hijacked"); },
    async focus() { throw new Error("browser tab must not be focused"); },
  };
  const scoreWin = {
    id: "score-win-2",
    url: ORIGIN + "/score.html?event=9",
    async focus() {
      focused = scoreWin.id;
      return scoreWin;
    },
  };
  const wRestarted = bootWorker(caches, {
    windows: [browserTab, adminWin, scoreWin],
    openWindow: async (url) => { openedNew = url; return null; },
  });
  await wRestarted.trigger("notificationclick", {
    notification: {
      close() {},
      data: { url: "/admin.html#members", kind: "admin" },
    },
  });
  assert.equal(navigated, ORIGIN + "/admin.html#members");
  assert.equal(focused, "pwa-win-1");
  assert.equal(openedNew, null);

  // Dead window id was pruned while live window ids stayed.
  const winStore = caches.stores.get("gvdg-app-windows");
  assert.equal(winStore.has(ORIGIN + "/_sw/app-window/dead-win-9"), false);
  assert.ok(winStore.has(ORIGIN + "/_sw/app-window/pwa-win-1"));

  await wRestarted.trigger("notificationclick", {
    notification: {
      close() {},
      data: { url: "/score.html?event=9", kind: "range" },
    },
  });
  assert.equal(focused, "score-win-2");
});

test("public-app/sw-chunks.js lists every built public-app chunk on disk", () => {
  const manifest = fs.readFileSync(path.join(ROOT, "public-app/sw-chunks.js"), "utf8");
  const match = manifest.match(/self\.GVDG_PUBLIC_CHUNKS\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(match, "public-app/sw-chunks.js assigns self.GVDG_PUBLIC_CHUNKS");
  const listed = JSON.parse(match[1]).sort();
  const chunksDir = path.join(ROOT, "public-app/chunks");
  const onDisk = fs.readdirSync(chunksDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => `public-app/chunks/${name}`)
    .sort();
  assert.ok(onDisk.length >= 3);
  assert.deepEqual(listed, onDisk);
});

test("event-calendar parses both ASCII hyphen and en-dash PDGA multi-day ranges", () => {
  const hyphen = calendarEventFromPdga({ name: "Test Open", date: "Sep 19-20, 2026" });
  const enDash = calendarEventFromPdga({ name: "Test Open", date: "Sep 19–20, 2026" });
  assert.equal(hyphen?.start, "20260919");
  assert.equal(hyphen?.end, "20260921");
  assert.equal(enDash?.start, "20260919");
  assert.equal(enDash?.end, "20260921");
});

test("sanitizeCrottsActions allows lost-found.html and blocks untrusted URLs", () => {
  const cleaned = sanitizeCrottsActions([
    { id: "lost", label: "Open Lost & Found", href: "lost-found.html" },
    { id: "bad", label: "Phish", href: "https://evil.example/lost-found.html" },
  ]);
  assert.deepEqual(cleaned, [{ id: "lost", label: "Open Lost & Found", href: "lost-found.html" }]);
});

test("Batch 8 PWA, cache-header, widget, and hero accessibility invariants hold in source", () => {
  const headers = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
  assert.match(headers, /^\/\s*\n\s*Cache-Control:\s*public,\s*max-age=0,\s*must-revalidate/m);

  const fieldTestHtml = fs.readFileSync(path.join(ROOT, "field-test.html"), "utf8");
  const scoringHtml = fs.readFileSync(path.join(ROOT, "scoring-app.html"), "utf8");
  const eventsHtml = fs.readFileSync(path.join(ROOT, "events.html"), "utf8");
  assert.match(fieldTestHtml, /site\.webmanifest\?v=179/);
  assert.match(scoringHtml, /site\.webmanifest\?v=179/);
  assert.doesNotMatch(eventsHtml, /public-app\/public-app\.js\?v=220/);

  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const homepagePolish = fs.readFileSync(path.join(ROOT, "homepage-polish.css"), "utf8");
  assert.match(indexHtml, /home-app\/home-app\.js\?v=202/);
  assert.match(indexHtml, /\.carousel-pause\s*\{[^}]*padding:\s*0/);
  assert.match(homepagePolish, /\.hero \.carousel-pause\s*\{[^}]*right:\s*156px;[^}]*padding:\s*0/);

  const crottsWidget = fs.readFileSync(path.join(ROOT, "src/shared/crotts-widget.js"), "utf8");
  assert.match(crottsWidget, /maxLength:\s*2000/);
  assert.match(crottsWidget, /status === 413/);
  assert.match(crottsWidget, /onClose:\s*closeHelp/);

  const donatePrompt = fs.readFileSync(path.join(ROOT, "src/shared/donate-prompt.js"), "utf8");
  assert.match(donatePrompt, /status === 401/);
  assert.match(donatePrompt, /"unauthorized"/);

  const heroAbout = fs.readFileSync(path.join(ROOT, "src/home-app/hero-about-app.js"), "utf8");
  assert.match(heroAbout, /className:\s*"carousel-pause"/);
  assert.match(heroAbout, /"aria-pressed"/);
  assert.match(heroAbout, /onFocus:\s*\(\)\s*=>\s*setFocusPaused\(true\)/);

  const eventsDetail = fs.readFileSync(path.join(ROOT, "src/public-app/events-detail-app.js"), "utf8");
  assert.match(eventsDetail, /player\.index === ctp\.leaderPlayerIndex/);

  const eventsHub = fs.readFileSync(path.join(ROOT, "src/public-app/events-hub-data.js"), "utf8");
  assert.match(eventsHub, /loadRequestId/);

  const liveChat = fs.readFileSync(path.join(ROOT, "src/public-app/events-live-chat.js"), "utf8");
  assert.match(liveChat, /"aria-live":\s*"polite"/);

  const clubContent = fs.readFileSync(path.join(ROOT, "src/public-app/events-club-content-app.js"), "utf8");
  assert.match(clubContent, /role:\s*"progressbar"/);
});
