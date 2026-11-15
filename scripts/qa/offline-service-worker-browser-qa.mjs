import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { createCoursePackStore } from "../../src/shared/course-packs.js";

// Test the built app and actual service worker. No browser route fulfills a
// document, script or offline request, so a missing precache really fails.
const root = process.cwd();
const mime = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/version.json") { response.setHeader("Content-Type", "application/json"); response.end('{"commit":"offline-qa"}'); return; }
  const file = resolve(root, "." + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
  try { response.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream"); response.end(await readFile(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const site = "http://127.0.0.1:" + server.address().port;
let saved;
const packStore = createCoursePackStore({ put: async (pack) => { saved = pack; }, get: async () => saved });
assert.equal((await packStore.save({ id: 600, name: "Offline Build QA" }, {
  id: 601, course_id: 600, name: "Saved loop", expected_holes: 1,
  holes: [{ hole: 1, par: 3, distance_ft: 250, tee: null, target: null }],
})).ok, true);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A first visit to the member page should install everything needed for a
  // brand-new scoring URL, even when the scorer was never opened online.
  await page.goto(site + "/gvdg-members.html", { waitUntil: "load" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((ready) => navigator.serviceWorker.addEventListener("controllerchange", ready, { once: true }));
  });
  await page.evaluate((pack) => new Promise((resolve, reject) => {
    const request = indexedDB.open("gvdg-course-packs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("layouts", { keyPath: "key" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("layouts", "readwrite");
      tx.objectStore("layouts").put(pack);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), saved);
  await context.setOffline(true);
  await page.goto(site + "/score.html?offline=1&pack=600%3A601", { waitUntil: "load" });
  await page.getByLabel("Your name", { exact: true }).fill("Offline QA");
  await page.getByRole("button", { name: "Start offline round", exact: true }).click();
  const cell = page.getByRole("button", { name: "Enter score for Offline QA on hole 1", exact: true });
  await cell.click();
  await page.getByRole("dialog").getByRole("button", { name: "2", exact: true }).click();
  await cell.locator(".n").getByText("2", { exact: true }).waitFor();
  await page.reload({ waitUntil: "load" });
  await cell.locator(".n").getByText("2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Finish card", exact: true }).click();
  await page.getByRole("button", { name: "Save finished round", exact: true }).click();
  await page.getByRole("heading", { name: "Finished offline round", exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Archivo"')), true);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log("Built service-worker offline start, scoring, reload and finish passed.");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
