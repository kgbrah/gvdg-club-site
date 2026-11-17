import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { createCoursePackStore } from "../../src/shared/course-packs.js";
import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

// Test the built app and actual service worker. No browser route fulfills a
// document, script or offline request, so a missing precache really fails.
const root = process.cwd();
const mime = { ".webp": "image/webp", ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json",
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
  await context.close();
  await memberScreensOffline();
  console.log("Built service-worker offline start, scoring, reload and finish passed, and every lazily loaded member screen opened offline.");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

// The member app's screens past Home are separate chunk files. The first visit's install must precache all
// of them, so a member whose connection drops can still open any screen they had not opened yet.
async function memberScreensOffline() {
  const manifest = await readFile("members-app/sw-chunks.js", "utf8");
  const listed = JSON.parse(manifest.slice(manifest.indexOf("["), manifest.lastIndexOf("]") + 1)).map((file) => "/" + file).sort();
  assert.ok(listed.length > 5, "the build lists the member app's chunks");
  const member = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  try {
    let offline = false;
    // Only the cross-origin API is a fixture; the page, scripts and chunks come from the server and worker.
    await installMemberDashboardApiRoutes(member, "http://127.0.0.1:8788");
    await member.route("http://127.0.0.1:8788/**", (route) => (offline ? route.abort("internetdisconnected") : route.fallback()));
    await member.addInitScript(() => localStorage.setItem("gvdg_member_token", "qa-token"));
    const app = await member.newPage();
    app.setDefaultTimeout(20_000);
    const errors = [];
    app.on("pageerror", (error) => errors.push(error.message));
    await app.goto(site + "/gvdg-members.html", { waitUntil: "load" });
    await app.locator('[data-react-overview-dashboard="ready"]').waitFor();
    await app.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((ready) => navigator.serviceWorker.addEventListener("controllerchange", ready, { once: true }));
    });
    const cached = () => app.evaluate(async () => (await (await caches.open("gvdg-member-chunks")).keys())
      .map((request) => new URL(request.url).pathname).filter((path) => path.includes("/chunks/")).sort());
    await app.waitForFunction(async (count) => (await (await caches.open("gvdg-member-chunks")).keys())
      .filter((request) => request.url.includes("/chunks/")).length >= count, listed.length);
    assert.deepEqual(await cached(), listed);

    offline = true;
    await member.setOffline(true);
    const nav = app.getByRole("navigation", { name: "Member app" });
    await nav.getByRole("button", { name: "Stats" }).click();
    await app.locator("#membersReactSeasonPanel [data-react-season-page]").waitFor();
    await nav.getByRole("button", { name: "Club" }).click();
    await app.locator('#membersReactMorePanel [data-react-more-page="ready"]').waitFor();
    await app.getByRole("button", { name: "Club directory" }).click();
    await app.locator('[data-react-club-panel="ready"] [data-react-doubles-league="ready"]').waitFor();
    for (const [hash, ready] of [
      ["#practice", '[data-member-practice="ready"]'],
      ["#appearance", ".member-appearance-toggle"],
      ["#board", "#membersReactBoardPanel [data-react-board-panel]"],
      ["#leagues", '[data-react-doubles-league="ready"]:visible'],
    ]) {
      await app.evaluate((next) => { location.hash = next; }, hash);
      await app.locator(ready).first().waitFor({ state: "visible" });
    }
    assert.equal(await app.locator(".member-panel-load-error").count(), 0, "no screen failed to load offline");
    assert.deepEqual(errors, []);
  } finally {
    await member.close();
  }
}
