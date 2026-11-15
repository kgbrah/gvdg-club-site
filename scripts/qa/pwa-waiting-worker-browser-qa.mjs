import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

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
  console.log("Chromium waiting-worker QA passed lagging release marker, score dock protection and one explicit reload after control transfers.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
