// The owner's Account screen stopped loading for good after a deploy: Cloudflare Pages answers a file it doesn't have
// with the site's HTML and a 200, the service worker saved that page in place of the Account screen's script, and
// served it from then on (a hashed file "never changes"). With the real, built app and its real service worker:
//   A. the HTML arrives while the app installs (mid-deploy): it isn't saved, and Account opens once the file is back
//   B. a phone already holding a bad copy: the next service-worker update throws it out, and Account opens
//   GVDG_SW_FILE=<path> serves another sw.js (e.g. the one before this fix, to see both fail).
//   npm run build && GVDG_QA_NO_SANDBOX=1 node scripts/qa/sw-bad-copy-browser-qa.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

const root = process.cwd();
const swFile = process.env.GVDG_SW_FILE || resolve(root, "sw.js");
const mime = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const state = { poison: false, swEdition: 0 };
const ACCOUNT_CHUNK = /^\/members-app\/chunks\/more-page-[^/]+\.js$/;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/version.json") { response.setHeader("Content-Type", "application/json"); response.end('{"commit":"sw-qa"}'); return; }
  if (url.pathname === "/sw.js") {
    // A new edition is a byte-different worker: the browser installs it as an update.
    response.setHeader("Content-Type", "text/javascript");
    response.setHeader("Cache-Control", "no-cache");
    response.end(String(await readFile(swFile)) + `\n// edition ${state.swEdition}\n`);
    return;
  }
  if (state.poison && ACCOUNT_CHUNK.test(url.pathname)) {
    // What Pages does for a file it doesn't have.
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(await readFile(resolve(root, "index.html")));
    return;
  }
  const file = resolve(root, "." + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
  try { response.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream"); response.end(await readFile(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const site = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}) });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const token = `${b64({ alg: "HS256" })}.${b64({ sub: "member-1", iat: now, exp: now + 2592000 })}.sig`;
const errors = [];

async function open() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await installMemberDashboardApiRoutes(page, "http://127.0.0.1:8788");
  await page.addInitScript((t) => localStorage.setItem("gvdg_member_token", t), token);
  return { context, page };
}
const controlled = (page) => page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((ready) => navigator.serviceWorker.addEventListener("controllerchange", ready, { once: true }));
});
async function accountOpens(page) {
  await page.goto(site + "/gvdg-members.html", { waitUntil: "load" });
  await page.waitForFunction(() => document.body.dataset.memberShell === "members");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab: "account" } })));
  const outcome = await page.waitForFunction(() => {
    if (document.querySelector(".member-panel-load-error")) return "error";
    const heading = [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Account" && h.offsetParent !== null);
    return heading && !document.querySelector("[data-member-panel-loading]") ? "ok" : false;
  }, null, { timeout: 20_000 }).then((handle) => handle.jsonValue()).catch(() => "timeout");
  return outcome;
}

try {
  // A. Mid-deploy install: the Account script comes back as the HTML page while the worker precaches.
  {
    const { context, page } = await open();
    state.poison = true;
    await page.goto(site + "/gvdg-members.html", { waitUntil: "load" });
    await controlled(page);
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r?.update(); });
    const saved = await page.evaluate(async () => {
      const cache = await caches.open("gvdg-member-chunks");
      const hits = [];
      for (const request of await cache.keys()) if (/more-page-/.test(request.url)) hits.push((await cache.match(request))?.headers.get("content-type") || "");
      return hits;
    });
    assert.ok(saved.every((type) => type.includes("javascript")), "the HTML page was saved as the Account script: " + JSON.stringify(saved));
    state.poison = false;
    assert.equal(await accountOpens(page), "ok", "Account opens once the file is back");
    await context.close();
    console.log("A: the HTML answer mid-deploy wasn't saved; Account opens");
  }

  // B. A phone already holding a bad copy (the owner's), then this service worker's next update.
  {
    const { context, page } = await open();
    await page.goto(site + "/gvdg-members.html", { waitUntil: "load" });
    await controlled(page);
    const poisoned = await page.evaluate(async () => {
      const cache = await caches.open("gvdg-member-chunks");
      const urls = (await cache.keys()).map((request) => request.url).filter((u) => /more-page-/.test(u));
      for (const u of urls) await cache.put(u, new Response("<!DOCTYPE html><title>GVDG</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } }));
      return urls.length;
    });
    assert.ok(poisoned >= 1, "the Account script was precached");
    state.swEdition += 1;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const changed = new Promise((ready) => navigator.serviceWorker.addEventListener("controllerchange", ready, { once: true }));
      await registration.update();
      await changed;
    });
    assert.equal(await accountOpens(page), "ok", "Account opens after the update");
    await context.close();
    console.log("B: a saved bad copy is thrown out by the next update; Account opens");
  }
} finally {
  await browser.close();
  server.close();
}
assert.deepEqual(errors.filter((message) => !/Failed to fetch dynamically imported module|Expected a JavaScript/.test(message)), [], "page errors: " + errors.join(" | "));
console.log("PASS sw-bad-copy-browser-qa");
