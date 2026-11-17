import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

import { startMemberChunkFixture } from "./member-chunk-fixture.mjs";

const registrar = await readFile(new URL("../../pwa.js", import.meta.url));
const A = "a".repeat(40);
const B = "b".repeat(40);
let documentBuild = A;
let workerBuild = A;
let publishedBuild = A;
let navigations = 0;

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;

  function send(type, content) {
    response.writeHead(200, {
      "Content-Type": type, "Content-Length": Buffer.byteLength(content), "Cache-Control": "no-store",
    });
    response.end(content);
  }

  if (path === "/pwa.js") {
    send("text/javascript", registrar);
  } else if (path === "/version.json") {
    // The worker and page have advanced, but the release endpoint still reports A.
    send("application/json", JSON.stringify({ commit: publishedBuild }));
  } else if (path === "/sw.js") {
    send("text/javascript", `
      self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
      self.addEventListener("message", (event) => {
        if (event.data.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
        if (event.data.type === "QA_BUILD") event.ports[0].postMessage("${workerBuild}");
      });
    `);
  } else if (path === "/score") {
    if (request.method === "GET") {
      navigations += 1;
      publishedBuild = documentBuild;
    }
    send("text/html", `<!doctype html><html lang="en">
      <head><meta name="gvdg-build" content="${documentBuild}"><script defer src="/pwa.js"></script></head>
      <body><main id="scoreRoot"><h1>Scoring fixture</h1></main></body></html>`);
  } else {
    response.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ serviceWorkers: "allow" });
  page.setDefaultTimeout(15_000);
  await page.goto("http://127.0.0.1:" + server.address().port + "/score");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  assert.equal(await refresh.count(), 0);
  await page.evaluate(() => { window.qaOldController = navigator.serviceWorker.controller; });

  workerBuild = B;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  await refresh.waitFor();
  assert.equal(navigations, 1);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller === window.qaOldController), true);

  await page.evaluate(() => document.body.classList.add("score-glove"));
  await refresh.waitFor({ state: "hidden" });
  assert.equal(navigations, 1);
  await page.evaluate(() => document.body.classList.remove("score-glove"));

  documentBuild = B;
  const reloaded = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() });
  await refresh.click();
  await reloaded;
  await page.waitForLoadState("load");
  assert.equal(await page.locator('meta[name="gvdg-build"]').getAttribute("content"), B);
  assert.equal(navigations, 2);
  await page.waitForFunction((build) => localStorage.getItem("gvdg_app_commit") === build, B);
  assert.equal(await refresh.count(), 0);
  const controllerBuild = await page.evaluate(() => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => reject(new Error("Controller did not answer")), 5_000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timeout); resolve(data); };
    navigator.serviceWorker.controller.postMessage({ type: "QA_BUILD" }, [channel.port2]);
  }));
  assert.equal(controllerBuild, B);
  await lazyScreensWhileWaiting();
  console.log("Chromium waiting-worker QA passed lagging release marker, score dock protection, one explicit reload after control transfers, and lazily loaded member screens while an update waits.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// The real sw.js with a member-app release whose screens load on demand. A new release's worker precaches
// its own chunks and then waits for the member to tap Refresh. Until then the running release must still
// open its screens offline; after the refresh, the new release's screens open offline too.
async function lazyScreensWhileWaiting() {
  const fixture = await startMemberChunkFixture({ holdInstall: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  context.setDefaultTimeout(15_000);
  try {
    const app = await context.newPage();
    await app.goto(fixture.origin + "/gvdg-members.html", { waitUntil: "load" });
    await app.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.equal(await app.evaluate(() => window.openScreen("stats")), "stats A");

    fixture.deploy("B");
    await app.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
      const worker = registration.installing || registration.waiting;
      if (!worker) throw new Error("No new worker after the deploy");
      // The new release precaches its chunks, then waits for the member's Refresh.
      await new Promise((resolve) => {
        const check = () => { if (worker.state !== "installing") { worker.removeEventListener("statechange", check); resolve(); } };
        worker.addEventListener("statechange", check);
        check();
      });
      if (registration.waiting !== worker) throw new Error("The new worker is not waiting: " + worker.state);
    });
    const refresh = app.getByRole("button", { name: "Refresh", exact: true });
    await refresh.waitFor();
    await context.setOffline(true);
    assert.equal(await app.evaluate(() => window.openScreen("club")), "club A", "the running release opens a screen it had not loaded");
    await context.setOffline(false);
    await app.waitForFunction(() => navigator.onLine);
    await app.evaluate(() => window.dispatchEvent(new Event("online")));
    await refresh.waitFor();

    const reloaded = app.waitForEvent("framenavigated", { predicate: (frame) => frame === app.mainFrame() });
    await refresh.click();
    await reloaded;
    await app.waitForLoadState("load");
    assert.equal(await app.locator("h1").innerText(), "Member app B");
    await context.setOffline(true);
    assert.equal(await app.evaluate(() => window.openScreen("stats")), "stats B");
    assert.equal(await app.evaluate(() => window.openScreen("club")), "club B");
  } finally {
    await context.close();
    await fixture.close();
  }
}
