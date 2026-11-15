import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const port = Number(process.env.GVDG_OFFLINE_QA_PORT || 5499);
const site = "http://127.0.0.1:" + port;
const screenshots = process.env.GVDG_QA_SCREENSHOTS || await mkdtemp(join(tmpdir(), "gvdg-offline-screenshots-"));
await mkdir(screenshots, { recursive: true });
const cacheDir = await mkdtemp(join(tmpdir(), "gvdg-offline-vite-"));
const html = (await readFile("score.html", "utf8"))
  .replace(/src="score-app\/score-app\.js[^"]*"/, 'src="/src/score-app/main.js"')
  .replace('<script src="pwa.js" defer></script>', "");
process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const server = await createServer({
  configFile: false, cacheDir, optimizeDeps: { entries: ["src/score-app/main.js"] },
  server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false, fs: { allow: [process.cwd(), cacheDir] } },
  plugins: [{
    name: "offline-round-qa", configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/score.html")) return next();
        response.setHeader("Content-Type", "text/html");
        response.end(await vite.transformIndexHtml(request.url, html));
      });
    },
  }],
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const token = (sub, exp = Math.floor(Date.now() / 1000) + 3600) =>
  "header." + Buffer.from(JSON.stringify({ sub, exp })).toString("base64url") + ".signature";
const mine = token("m_offline_qa");
const other = token("m_other_qa");
const expired = token("m_offline_qa", 1);
const clipId = "10000000-0000-4000-8000-000000000020";
const apiHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const thePack = {
  course: { id: 500, name: "Offline Pines", lat: 35, lng: -82 },
  layout: { id: 501, name: "Creek Loop", course_id: 500, expected_holes: 2, holes: [
    { hole: 1, par: 3, distance_ft: 277, tee: { lat: 35, lng: -82, label: "Tee" }, target: { lat: 35.00065, lng: -82, label: "Saved basket" } },
    { hole: 2, par: 3, distance_ft: 290, tee: null, target: null },
  ]},
};

const contexts = new Set();
const routeFailures = [];

async function closeContext(context) {
  await context.unrouteAll({ behavior: "wait" });
  await context.close();
  contexts.delete(context);
}

async function serveRoute(route, reply) {
  try {
    await reply();
  } catch (error) {
    routeFailures.push(new Error("Fixture request failed for " + route.request().url(), { cause: error }));
    // End the browser request as well so the test can report the original error.
    await route.abort("failed").catch(() => {});
  }
}

async function session(viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block", permissions: ["geolocation"],
    geolocation: { latitude: 35.0002, longitude: -82, accuracy: 5 } });
  contexts.add(context);
  const cached = new Map();
  const upstreamRequests = new Set();
  let offline = false;
  const canonicalKey = (value) => {
    const url = new URL(value);
    return url.pathname === "/score.html" ? site + url.pathname : url.href;
  };
  // Serve the source entry and cached module graph while the Chromium network is disabled.
  // Production's service worker serves the generated bundle and uses the same document URL.
  await context.route(site + "/**", (route) => {
    const key = canonicalKey(route.request().url());
    if (offline) {
      const file = cached.get(key);
      return serveRoute(route, () => file ? route.fulfill(file) : route.abort("internetdisconnected"));
    }
    const pending = serveRoute(route, async () => {
      // Playwright retries only ECONNRESET here. A repeated reset or any other
      // transport failure must still fail the fixture, never use cached data.
      const response = await route.fetch({ maxRetries: route.request().method() === "GET" ? 1 : 0 });
      try {
        const body = await response.body();
        const headers = response.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        const file = { status: response.status(), headers, body };
        if (response.ok()) cached.set(key, file);
        await route.fulfill(file);
      } finally {
        await response.dispose();
      }
    });
    upstreamRequests.add(pending);
    return pending.finally(() => upstreamRequests.delete(pending));
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12000);
  const stored = new Map();
  const writes = [];
  const clips = [];
  let lostAck = true;
  await context.route("http://127.0.0.1:8788/**", (route) => serveRoute(route, async () => {
    if (offline) return route.abort("internetdisconnected");
    const req = route.request();
    const path = new URL(req.url());
    const auth = req.headers().authorization;
    const reply = (json, status = 200) => route.fulfill({ json, status, headers: apiHeaders });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: apiHeaders });
    if (path.pathname === "/me") return reply({ sub: auth === "Bearer " + mine ? "m_offline_qa" : "m_other_qa", name: "QA Owner" });
    if (path.pathname.startsWith("/offline-rounds") && auth !== "Bearer " + mine) return reply({ error: "unauthorized" }, 401);
    if (path.pathname === "/offline-rounds") return reply({ rounds: [...stored.values()].map((value) => value.receipt), before: null });
    if (path.pathname === "/offline-rounds/import") {
      const round = req.postDataJSON();
      assert.equal(round.owner.id, "m_offline_qa");
      writes.push(round);
      const existing = stored.get(round.localId);
      if (existing) assert.deepEqual(round, existing.round);
      const receipt = { id: 22, localId: round.localId, source: "offline", uploadedAt: "2026-11-14T20:00:00.000Z",
        courseName: round.source.courseName, layoutName: round.source.layoutName, finishedAt: round.finishedAt };
      stored.set(round.localId, { round, receipt });
      if (lostAck) { lostAck = false; return route.abort("connectionreset"); }
      return reply(receipt);
    }
    if (path.pathname === "/offline-rounds/22/clips") {
      assert.equal(path.searchParams.has("token"), false);
      assert.equal(path.searchParams.get("clientId"), clipId);
      assert.equal(path.searchParams.get("playerIndex"), "0");
      const data = { id: 6, roundId: 22, clientId: clipId, hole: 1, playerIndex: 0, playerName: "QA Owner",
        mediaPath: "/offline-rounds/22/clips/6/media" };
      clips.push(data);
      return reply(data, 201);
    }
    if (path.pathname === "/offline-rounds/22") {
      const value = [...stored.values()][0];
      return value ? reply({ ...value.receipt, round: value.round, clips }) : reply({ error: "not_found" }, 404);
    }
    return reply({});
  }));
  async function setOffline(value) {
    offline = value;
    // Finish online requests already warming the cache before flipping the
    // browser's network. New requests take only the cache or abort path.
    if (value) await Promise.all(upstreamRequests);
    await context.setOffline(value);
  }
  async function as(memberToken) {
    await page.evaluate((value) => {
      if (value) localStorage.setItem("gvdg_member_token", value);
      else {
        localStorage.removeItem("gvdg_member_token");
        sessionStorage.removeItem("gvdg_member_token");
      }
      localStorage.setItem("gvdg_member_name", "QA Owner");
      window.dispatchEvent(new Event("gvdg:score-auth"));
    }, memberToken);
  }
  async function savePack() {
    await page.evaluate(async ({ course, layout }) => {
      const { coursePackStore } = await import("/src/shared/course-packs.js");
      const saved = await coursePackStore.save(course, layout);
      if (!saved.ok || !saved.pack.quality.scorable || saved.pack.assets.schematicHoles !== 1) throw new Error("Bad QA pack");
      await import("/src/score-app/clip-recovery.js");
    }, thePack);
  }
  return { context, page, errors, stored, writes, clips, setOffline, as, savePack };
}

function controls(page) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const text = (name) => page.getByText(name, { exact: true });
  async function score(name, hole, value) {
    const cell = button("Enter score for " + name + " on hole " + hole);
    await cell.click();
    await page.getByRole("dialog").getByRole("button", { name: String(value), exact: true }).click();
    await cell.locator(".n").getByText(String(value), { exact: true }).waitFor();
  }
  async function shots(hole) {
    await button("Round tools").click();
    await button("Shot details").click();
    await page.getByRole("heading", { name: "Shot details · Hole " + hole }).waitFor();
  }
  async function finish() {
    await button("Finish card").click();
    await button("Save finished round").click();
    await page.getByRole("heading", { name: "Finished offline round" }).waitFor();
  }
  return { button, text, score, shots, finish };
}

const failures = [];
try {
  const mobile = await session({ width: 390, height: 844 });
  const { page } = mobile;
  const { button, text, score, shots, finish } = controls(page);
  await page.goto(site + "/score.html", { waitUntil: "networkidle", timeout: 90_000 });
  await mobile.as(mine);
  await mobile.savePack();
  await mobile.setOffline(true);
  await button("Saved course layouts").click();
  await page.getByRole("link", { name: "Start offline round" }).click();
  await page.getByText(/Scoring works on holes without a map/).waitFor();
  await page.screenshot({ path: join(screenshots, "offline-setup-phone.png") });
  await button("Start offline round").click();
  const firstScore = button("Enter score for QA Owner on hole 1");
  await firstScore.waitFor();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (record) {
      if (this.name === "rounds") {
        IDBObjectStore.prototype.put = put;
        throw new DOMException("simulated quota failure", "QuotaExceededError");
      }
      return put.call(this, record);
    };
  });
  await firstScore.click();
  await page.getByRole("dialog").getByRole("button", { name: "2", exact: true }).click();
  await text("Device storage is full. Free some space and make your edit again.").waitFor();
  assert.equal(await firstScore.locator(".n").textContent(), "-");
  await score("QA Owner", 1, 2);
  await button("Increase QA Owner on hole 1").evaluate((control) => {
    for (let index = 0; index < 5; index++) control.click();
  });
  await firstScore.locator(".n").getByText("7", { exact: true }).waitFor();
  await score("QA Owner", 1, 2);
  const gps = button("Tap for GPS");
  if (await gps.count()) await gps.click();
  await page.locator(".hole-range-hud strong").waitFor();
  assert.match(await page.locator(".hole-range-hud").textContent(), /to basket/i);
  assert.equal(await page.locator(".hole-range-hud-len").count(), 0, "The badge does not repeat the footer's hole length");
  const localId = new URL(page.url()).searchParams.get("offline");
  assert.ok(localId, "The round has a persistent local ID");
  const markedLie = [{ lat: 35.0002, lng: -82, n: 1 }];
  async function expectSavedLie() {
    const lieActions = page.locator(".hole-map-lie-actions");
    await lieActions.getByRole("button", { name: "Mark lie", exact: true, pressed: true }).waitFor();
    await lieActions.getByRole("button", { name: "Undo", exact: true }).waitFor();
    const saved = await page.evaluate(async (id) => {
      const { offlineRoundStore } = await import("/src/score-app/offline-round-store.js");
      return (await offlineRoundStore.get(id))?.marks[1];
    }, localId);
    assert.deepEqual(saved, markedLie);
  }
  assert.equal(await button("Mark lie").getAttribute("aria-pressed"), "false");
  await button("Mark lie").click();
  await expectSavedLie();
  await shots(1);
  await button("Add putt").click();
  await page.getByLabel("Outcome", { exact: true }).selectOption("made");
  await text("GPS and measured distances").click();
  await page.getByLabel("Measured starting distance to basket in feet").fill("18");
  await button("Save shot").click();
  await text("Putt · Made · 18 ft to basket").waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(async ({ localId, clipId }) => {
    const { createClipStore } = await import("/src/score-app/clip-recovery.js");
    const store = createClipStore(indexedDB);
    await store.put({ id: clipId, scopeKey: "offline-round:" + localId, hole: 1, playerIndex: 0, playerName: "QA Owner",
      createdAt: Date.now(), blob: new Blob([new Uint8Array(40)], { type: "video/mp4" }),
      state: "pending", nextAt: 0, attempt: 0, highlight: false });
  }, { localId, clipId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await text("You can still score this hole.").waitFor();
  await button("Previous hole").click();
  await expectSavedLie();
  await shots(1);
  await text("Putt · Made · 18 ft to basket").waitFor();
  await page.screenshot({ path: join(screenshots, "offline-shots-phone.png") });
  await page.keyboard.press("Escape");
  await button("Next hole").click();
  await score("QA Owner", 2, 3);
  await button("Increase QA Owner on hole 2").evaluate((control) => {
    for (let index = 0; index < 5; index++) control.click();
  });
  await finish();
  await page.getByText(/QA Owner · 10 strokes/).waitFor();
  await text("Waiting to upload.").waitFor();
  await page.screenshot({ path: join(screenshots, "offline-finished-phone.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.equal(mobile.writes.length, 0);
  await mobile.as(other);
  await text("This round is unavailable on this device under this account.").waitFor();
  await mobile.setOffline(false);
  assert.equal(mobile.writes.length, 0);
  await mobile.as(expired);
  await page.getByText(/Sign in with the account that owns this round/).waitFor();
  assert.equal(mobile.writes.length, 0);
  await mobile.as(mine);
  await text("Uploaded to your personal history.").waitFor();
  await page.getByRole("heading", { name: "Uploaded videos" }).waitFor();
  assert.equal(mobile.stored.size, 1);
  assert.equal(mobile.writes.length, 2);
  assert.equal(mobile.clips.length, 1);
  assert.equal(mobile.writes[0].source.holes[0].target.label, "Saved basket");
  assert.equal(mobile.writes[0].shots[1][0].puttDistanceFt, 18);
  assert.deepEqual(mobile.writes[0].scores["player:0"], { 1: 2, 2: 8 });
  assert.deepEqual(mobile.writes[0].marks[1], markedLie);
  assert.deepEqual(mobile.errors, []);
  await closeContext(mobile.context);

  const desktop = await session({ width: 1280, height: 900 });
  const wide = desktop.page;
  const ctl = controls(wide);
  await wide.goto(site + "/score.html?offline=1", { waitUntil: "networkidle" });
  await desktop.savePack();
  await wide.reload({ waitUntil: "networkidle" });
  await desktop.setOffline(true);
  await wide.getByLabel("Players", { exact: true }).selectOption("doubles");
  await wide.getByLabel("Scoring", { exact: true }).selectOption("matchplay");
  for (const [index, name] of ["Owner", "Partner", "Guest A", "Guest B"].entries()) {
    await wide.getByLabel(index === 0 ? "Your name" : "Player " + (index + 1), { exact: true }).fill(name);
  }
  await ctl.button("Start offline round").click();
  await ctl.score("Team 1", 1, 2);
  await ctl.score("Team 2", 1, 3);
  await ctl.button("Next hole").click();
  await ctl.score("Team 1", 2, 2);
  await ctl.score("Team 2", 2, 2);
  await wide.screenshot({ path: join(screenshots, "offline-doubles-desktop.png") });
  await ctl.finish();
  await wide.getByText(/Connect an account to upload a private copy/).waitFor();
  await desktop.as(mine);
  await desktop.setOffline(false);
  await ctl.button("Link round to QA Owner").waitFor();
  assert.equal(desktop.writes.length, 0);
  await ctl.button("Link round to QA Owner").click();
  await ctl.button("Confirm link").click();
  await ctl.text("Uploaded to your personal history.").waitFor();
  assert.deepEqual(desktop.writes[0].format, { groupFormat: "doubles", scoringStyle: "matchplay" });
  assert.equal(desktop.writes[0].startedAs, "device");
  assert.deepEqual(desktop.writes[0].scores, { "pair:team 1": { 1: 2, 2: 2 }, "pair:team 2": { 1: 3, 2: 2 } });
  assert.deepEqual(desktop.errors, []);
  await closeContext(desktop.context);
} catch (error) {
  failures.push(error);
} finally {
  for (const result of await Promise.allSettled([...contexts].map(closeContext))) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  await browser.close().catch((error) => failures.push(error));
  await server.close().catch((error) => failures.push(error));
  await rm(cacheDir, { recursive: true, force: true }).catch((error) => failures.push(error));
}
failures.push(...routeFailures);
if (failures.length === 1) throw failures[0];
if (failures.length) throw new AggregateError(failures, "Offline browser QA failed");
console.log("Offline mobile reload, account checks, shots and clip sync, lost ack, and desktop doubles link verified.");
console.log("Screenshots: " + screenshots);
