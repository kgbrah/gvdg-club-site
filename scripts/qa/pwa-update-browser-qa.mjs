// Report the service worker's own network activity to Playwright. Without it, Chromium under Playwright
// often left an updated worker waiting (never activating) with no page request in flight: about half of
// attempts stalled locally and in CI, and none did with it set before Playwright loads. Static imports are
// hoisted, so Playwright is imported dynamically below, after this line.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";

import { cachedChunks, startMemberChunkFixture } from "./member-chunk-fixture.mjs";

// Exercise native service-worker installation and control transfer in Chromium.
// The production worker's complete precache is covered by the built offline QA.
const registrar = await readFile("pwa.js");
const stylesheet = await readFile("tokens.css");
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
let release = A;
let documentsAvailable = true;
// A release whose new service worker never finishes installing (Chromium's stalled waiting worker, or a failed
// install): Refresh must still reload into the new release.
let stallWorker = false;
let markerAvailable = true;
let holdScoreRefresh = false;
let scoreHead = null;
const screenshots = process.env.GVDG_PWA_UPDATE_SCREENSHOTS;

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const route = url.pathname;
  if (process.env.GVDG_PWA_DEBUG) console.log(request.method, url.pathname, url.search);
  const send = (type, body, status = 200) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body), Connection: "close" });
    response.end(body);
  };
  if (route === "/version.json") {
    if (!markerAvailable) { send("text/plain", "Marker unavailable", 503); return; }
    send("application/json", JSON.stringify({ commit: release }));
    return;
  }
  if (route === "/sw.js") {
    send("text/javascript", (stallWorker ? `
      // Stalled: this worker never finishes installing.
      self.addEventListener("install", event => event.waitUntil(new Promise(() => {})));
    ` : "") + `
      self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
      self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
      self.addEventListener("message", event => {
        if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
      });
      self.addEventListener("fetch", event => {
        const url = new URL(event.request.url);
        if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
        if (event.request.mode !== "navigate" && !["/pwa.js", "/tokens.css"].includes(url.pathname)) return;
        event.respondWith((async () => {
          const cache = await caches.open("qa-documents");
          try {
            const response = await fetch(event.request);
            if (response.ok) await cache.put(event.request, response.clone());
            return response;
          } catch {
            return await cache.match(event.request) || Response.error();
          }
        })());
      });
    `);
    return;
  }
  if (route === "/pwa.js") { send("text/javascript", registrar); return; }
  if (route === "/tokens.css") { send("text/css", stylesheet); return; }
  if (route === "/gvdg-members.html" || route === "/score.html" || route === "/score") {
    if (request.method === "HEAD" && holdScoreRefresh && route === "/score") {
      scoreHead = () => send("text/html", "");
      return;
    }
    if (!documentsAvailable && request.method === "HEAD") { send("text/plain", "Unavailable", 503); return; }
    const stamp = url.searchParams.has("legacy") ? "" : `<meta name="gvdg-build" content="${release}">`;
    const id = route.startsWith("/score") ? ' id="scoreRoot"' : "";
    send("text/html", `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Club app fixture</title>
${stamp}<link rel="stylesheet" href="/tokens.css"><script src="/pwa.js" defer></script>
</head><body><main${id}><h1>Club app</h1><p id="fixture-build">${release}</p></main></body></html>`);
    return;
  }
  send("text/plain", "Missing", 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const { chromium } = await import("playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
context.setDefaultTimeout(12_000);
await context.addInitScript(() => {
  Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  const interval = window.setInterval.bind(window);
  window.setInterval = (callback, delay, ...args) => {
    if (delay === 5 * 60_000) window.checkUpdateTimer = callback;
    return interval(callback, delay, ...args);
  };
});

function banner(page) { return page.getByRole("status").filter({ hasText: "Update available" }); }

/** A new release whose service worker never takes over: Refresh still reloads into it (and never says it couldn't). */
async function stalledWorkerRefresh() {
  const isolated = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  try {
    const page = await isolated.newPage();
    release = "f".repeat(40);
    stallWorker = false;
    await page.goto(origin + "/gvdg-members.html", { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
    release = "9".repeat(40);
    stallWorker = true;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update().catch(() => {}));
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.installing), null, { timeout: 15_000 });
    await resume(page);
    await banner(page).waitFor({ timeout: 15_000 });
    await page.evaluate(() => { window.__sameDocument = true; });
    const started = Date.now();
    await banner(page).getByRole("button", { name: "Refresh" }).click();
    await page.waitForFunction(() => !window.__sameDocument, null, { timeout: 20_000, polling: 200 });
    await page.waitForLoadState("load");
    assert.equal(await build(page), "9".repeat(40), "Refresh reloads into the new release even though its worker never took over");
    assert(Date.now() - started < 15_000, "it does not wait out the old 15-second limit");
    assert.equal(await page.getByText("Couldn’t refresh the app", { exact: false }).count(), 0);
    console.log("stalled worker: Refresh reloaded into the new release in " + Math.round((Date.now() - started) / 1000) + " s");
  } finally {
    stallWorker = false;
    await isolated.close();
  }
}
function build(page) { return page.locator("#fixture-build").innerText(); }
async function open(page, url = "/gvdg-members.html") {
  await page.goto(origin + url, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
}
async function resume(page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}
try {
  const old = await context.newPage();
  await open(old);
  assert.equal(await build(old), A);
  assert.equal(await banner(old).count(), 0);
  await old.evaluate(async () => {
    localStorage.setItem("gvdg_member_token", "fixture-member");
    const mapCache = await caches.open("gvdg-maps-v2");
    await mapCache.put("/qa-map", new Response("fixture map"));
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("qa-offline-round", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("rounds");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const connection = request.result;
        const transaction = connection.transaction("rounds", "readwrite");
        transaction.objectStore("rounds").put({ hole: 4, strokes: 3 }, "card");
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => { connection.close(); resolve(); };
      };
    });
  });

  release = B;
  await resume(old);
  await banner(old).waitFor();
  assert.equal(await build(old), A, "automatic service-worker activation leaves the document alone");
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await old.screenshot({ path: screenshots + "/update-on-resume-390.png" });
  }
  const fresh = await context.newPage();
  await open(fresh);
  await fresh.waitForFunction((version) => localStorage.getItem("gvdg_app_commit") === version, B);
  assert.equal(await banner(fresh).count(), 0, "a fresh stamped B document is current");
  await old.bringToFront();
  await resume(old);
  await banner(old).waitFor();
  assert.equal(await build(old), A, "another tab must not mark the old document current");
  await banner(old).getByRole("button", { name: "Later" }).click();
  await banner(old).waitFor({ state: "hidden" });
  await resume(old);
  assert.equal(await old.evaluate(() => JSON.parse(localStorage.getItem("gvdg_update_snooze")).commit), B);
  assert.equal(await banner(old).count(), 0);

  await context.setOffline(true);
  release = C;
  await resume(old);
  assert.equal(await banner(old).count(), 0);
  await context.setOffline(false);
  await old.waitForFunction(() => navigator.onLine);
  await old.evaluate(() => window.dispatchEvent(new Event("online")));
  await banner(old).waitFor();
  documentsAvailable = false;
  await banner(old).getByRole("button", { name: "Refresh" }).click();
  await banner(old).getByText("Couldn’t refresh the app. Try again when connected.").waitFor();
  assert.equal(await old.evaluate(() => sessionStorage.getItem("gvdg_update_requested")), null);
  assert.equal(await old.evaluate(() => localStorage.getItem("gvdg_app_commit")), B);
  assert.equal(await build(old), A, "page transport failures leave the old document intact");

  documentsAvailable = true;
  const reloaded = old.waitForEvent("framenavigated", { predicate: (frame) => frame === old.mainFrame() });
  await banner(old).getByRole("button", { name: "Refresh" }).click();
  await reloaded;
  await old.waitForLoadState("load");
  assert.equal(await build(old), C);
  await old.waitForFunction((version) => localStorage.getItem("gvdg_app_commit") === version, C);
  assert.equal(await banner(old).count(), 0);
  assert.equal(await old.evaluate(() => JSON.parse(localStorage.getItem("gvdg_update_snooze")).commit), B, "Refresh does not snooze C");
  const saved = await old.evaluate(async () => ({
    auth: localStorage.getItem("gvdg_member_token"),
    map: await (await (await caches.open("gvdg-maps-v2")).match("/qa-map")).text(),
    card: await new Promise((resolve, reject) => {
      const request = indexedDB.open("qa-offline-round", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const connection = request.result;
        const read = connection.transaction("rounds").objectStore("rounds").get("card");
        read.onsuccess = () => { connection.close(); resolve(read.result); };
        read.onerror = () => reject(read.error);
      };
    }),
  }));
  assert.deepEqual(saved, { auth: "fixture-member", map: "fixture map", card: { hole: 4, strokes: 3 } });

  const scorer = await context.newPage();
  await open(scorer, "/score");
  await scorer.evaluate(() => document.body.classList.add("score-glove"));
  release = D;
  await scorer.evaluate(() => window.checkUpdateTimer());
  await scorer.waitForFunction(() => !document.querySelector(".pwa-update"));
  assert.equal(await build(scorer), C, "a new version leaves the active scorecard alone");
  await scorer.evaluate(() => document.body.classList.remove("score-glove"));
  await banner(scorer).waitFor();
  holdScoreRefresh = true;
  await banner(scorer).getByRole("button", { name: "Refresh" }).click();
  const scoreRequestStarted = Date.now();
  while (!scoreHead) {
    assert.ok(Date.now() - scoreRequestStarted < 12_000, "The app verifies the score route before refreshing");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await scorer.evaluate(() => {
    const card = document.createElement("section");
    card.className = "score-glove-layout";
    document.getElementById("scoreRoot").appendChild(card);
    document.body.classList.add("score-glove");
  });
  await banner(scorer).waitFor({ state: "hidden" });
  await scorer.evaluate(() => {
    document.querySelector(".score-glove-layout").remove();
    document.body.classList.remove("score-glove");
  });
  holdScoreRefresh = false;
  scoreHead();
  scoreHead = null;
  await scorer.waitForFunction(() => document.querySelector(".pwa-update-refresh")?.disabled === false);
  assert.equal(await build(scorer), C, "leaving scoring requires another explicit refresh");

  markerAvailable = false;
  const legacy = await context.newPage();
  await open(legacy, "/gvdg-members.html?legacy=1");
  await legacy.waitForFunction(async () => Boolean(await caches.match(location.href)));
  await legacy.evaluate(() => localStorage.removeItem("gvdg_app_commit"));
  await context.setOffline(true);
  await legacy.reload({ waitUntil: "load" });
  assert.equal(await build(legacy), D);
  assert.equal(await banner(legacy).count(), 0);
  release = E;
  markerAvailable = true;
  await context.setOffline(false);
  await legacy.waitForFunction(() => navigator.onLine);
  await legacy.evaluate(() => window.dispatchEvent(new Event("online")));
  await banner(legacy).waitFor();
  assert.equal(await build(legacy), D, "an offline legacy document does not adopt the first later marker");

  // Chromium sometimes leaves a waiting worker un-activated for a long time while a page stays open, with no
  // requests in flight (seen in CI: waiting "installed", active unchanged, in-flight []). Members then get the
  // update on the next launch and pwa.js's Refresh says so. Retry only that stall, once, from a fresh fixture
  // and context; any other failure, or a second stall, still fails the check.
  try {
    await lazyScreensAcrossUpdates();
  } catch (error) {
    if (!/did not activate/.test(String(error && error.message))) throw error;
    console.warn("lazy screens across updates: worker activation stalled; retrying once from scratch. " + error.message);
    await lazyScreensAcrossUpdates();
  }

  await stalledWorkerRefresh();

  console.log("Chromium PWA update QA passed a stalled new service worker, cross-tab versions, per-release Later, offline recovery, explicit refresh safety, stored card data and lazily loaded member screens across updates.");
} finally {
  if (scoreHead) scoreHead();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

// The real sw.js with a member-app release whose screens load on demand from per-release chunk files.
// A deploy removes the previous release's chunks from the server; a page that stays open across the
// update must still open its screens, online and offline, and a third release drops the oldest chunks.
async function lazyScreensAcrossUpdates() {
  const fixture = await startMemberChunkFixture();
  const chunkContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  chunkContext.setDefaultTimeout(15_000);
  // Every request in this context since it opened, including the service worker's own fetches when
  // PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1: a never-settling one keeps the old worker busy.
  const contextInFlight = new Map();
  chunkContext.on("request", (request) => contextInFlight.set(request, (request.serviceWorker() ? "sw:" : "page:") + request.url().replace(/^https?:\/\/[^/]+/, "")));
  chunkContext.on("requestfinished", (request) => contextInFlight.delete(request));
  chunkContext.on("requestfailed", (request) => contextInFlight.delete(request));
  const chunks = (release) => [`/members-app/chunks/club-${release}.js`, `/members-app/chunks/stats-${release}.js`];
  async function waitForChunks(page, expected) {
    const started = Date.now();
    let found = [];
    while (Date.now() - started < 15_000) {
      found = await cachedChunks(page);
      if (JSON.stringify(found) === JSON.stringify(expected)) return;
      await page.waitForTimeout(100);
    }
    assert.deepEqual(found, expected, "member chunk cache");
  }
  // The new worker installs (precaching its chunks) and takes over the way pwa.js's Refresh does it:
  // SKIP_WAITING, then wait until it is activated.
  async function updateWorker(page) {
    // Diagnostics for the rare stall: which page requests are still in flight (each one is a pending fetch
    // event on the old worker, and a waiting worker cannot activate until those settle).
    const inFlight = new Map();
    const started = (request) => inFlight.set(request, request.url());
    const settled = (request) => inFlight.delete(request);
    page.on("request", started);
    page.on("requestfinished", settled);
    page.on("requestfailed", settled);
    try {
      await activateNewWorker(page);
    } catch (error) {
      throw new Error(error.message + " in-flight: " + JSON.stringify([...inFlight.values()].map((url) => url.replace(/^https?:\/\/[^/]+/, "")))
        + " context-in-flight: " + JSON.stringify([...contextInFlight.values()]));
    } finally {
      page.off("request", started);
      page.off("requestfinished", settled);
      page.off("requestfailed", settled);
    }
  }
  async function activateNewWorker(page) {
    await page.evaluate(() => { window.qaWorker = navigator.serviceWorker.controller; });
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const before = registration.active;
      await registration.update();
      if (!registration.installing && !registration.waiting && registration.active === before) throw new Error("No new worker after the deploy");
      // Follow whichever new worker takes over, not one object: the app's own update check can race this
      // one and replace the first new worker (it then reports "redundant", a CI flake). Still fail if no new
      // worker ever activates.
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
        if (registration.active && registration.active !== before && registration.active.state === "activated") return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const state = (worker) => worker ? worker.state : null;
      throw new Error("The new worker did not activate: " + JSON.stringify({
        installing: state(registration.installing), waiting: state(registration.waiting),
        active: state(registration.active), activeIsNew: registration.active !== before,
      }));
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller !== window.qaWorker);
  }
  try {
    const app = await chunkContext.newPage();
    await app.goto(fixture.origin + "/gvdg-members.html", { waitUntil: "load" });
    await app.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
    await waitForChunks(app, chunks("A"));
    assert.equal(await app.evaluate(() => window.openScreen("stats")), "stats A");

    fixture.deploy("B");
    const deployedAt = fixture.state.requests.length;
    await updateWorker(app);
    await waitForChunks(app, [...chunks("A"), ...chunks("B")].sort());
    assert.equal(await app.locator("h1").innerText(), "Member app A", "the open page stays on its release");
    // Release A's club chunk is gone from the server and the phone is offline; the worker still has it.
    await chunkContext.setOffline(true);
    assert.equal(await app.evaluate(() => window.openScreen("club")), "club A");
    await chunkContext.setOffline(false);
    assert.ok(!fixture.state.requests.slice(deployedAt).includes("/members-app/chunks/club-A.js"), "club A came from the install-time precache");

    await app.reload({ waitUntil: "load" });
    assert.equal(await app.locator("h1").innerText(), "Member app B");
    await chunkContext.setOffline(true);
    assert.equal(await app.evaluate(() => window.openScreen("stats")), "stats B");
    const cold = await chunkContext.newPage();
    await cold.goto(fixture.origin + "/gvdg-members.html", { waitUntil: "load" });
    assert.equal(await cold.locator("h1").innerText(), "Member app B", "an offline start uses the installed page");
    assert.equal(await cold.evaluate(() => window.openScreen("club")), "club B");
    await cold.close();
    await chunkContext.setOffline(false);

    fixture.deploy("C");
    await updateWorker(app);
    await waitForChunks(app, [...chunks("B"), ...chunks("C")].sort());
    if (screenshots) await app.screenshot({ path: screenshots + "/member-chunks-after-update-390.png" });
  } finally {
    await chunkContext.close();
    await fixture.close();
  }
}
