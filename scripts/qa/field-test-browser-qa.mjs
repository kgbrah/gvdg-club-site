// Field test kit browser QA: plays a short live round with field test mode on (scores, offline and back,
// a dropped live socket, a reload, notes, finishing the card), then opens the member Field log, checks the
// summary, exports and parses the JSON and CSV, and clears the log. A second pass with the mode off checks
// that the recorder never loads and adds no listeners or timers.
//
// Run after `npm run build`:
//   CHROMIUM_PATH=/usr/bin/chromium GVDG_QA_NO_SANDBOX=1 node scripts/qa/field-test-browser-qa.mjs
// GVDG_FIELD_SHOTS=<dir> also writes the review screenshots (scorer, Account, Field log, field-test.html).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";
import { GLASS_PRESETS, buildTheme } from "../../src/shared/dashboard-theme-model.js";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const API = "http://127.0.0.1:8788";
const CODE = "FIELD1";
const ROUND_ID = "field-qa-round-1";
const NAMES = ["Avery Brooks", "Jordan Reyes"];
const MEMBER_ID = "m_field_qa";
const shots = process.env.GVDG_FIELD_SHOTS || "";
if (shots) await mkdir(shots, { recursive: true });
for (const built of ["score-app/score-app.js", "score-app/field-test-recorder.js", "members-app/members-app.js"]) {
  if (!existsSync(join(repo, built))) throw new Error(built + " is missing. Run `npm run build` first.");
}

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".map": "application/json" };
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
  const file = resolve(repo, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(repo)) return response.writeHead(403).end();
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const site = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});

function token(sub) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return part({ alg: "HS256", typ: "JWT" }) + "." + part({ sub, name: NAMES[0], exp: Math.floor(Date.now() / 1000) + 3600 }) + ".qa";
}

// ---------- a small live round: 4 holes, two players on one card ----------
function createRound() {
  const holes = Array.from({ length: 4 }, (_, index) => ({ hole: index + 1, par: 3, distance_ft: 250 + index * 20 }));
  const players = NAMES.map((name, index) => ({
    index, cardId: "c0", name, isMe: index === 0, canEnterScorecard: index === 0, scores: {}, scorecards: {}, throws: {},
  }));
  const state = { holes, players, rev: 1, status: "live", locked: false, updatedAt: new Date().toISOString(), receipts: new Set(), sockets: new Set(), posts: 0, dropNext: 0 };
  state.snapshot = () => ({
    status: state.status, roundCode: CODE, courseId: 100, layoutId: 101, courseName: "QA Field Course", layoutName: "Short tees",
    recoveryRoundId: ROUND_ID, rev: state.rev, updatedAt: state.updatedAt, holes, cardId: "c0", playerIndex: 0,
    players: state.players, cardmates: state.players, conflicts: [], missing: [], shotLedgers: {},
    scoreTargets: state.players.map(({ index, name }) => ({ id: "player:" + index, type: "player", label: name, playerIndexes: [index], members: [name] })),
    standings: state.players.map(({ index, name, scores }) => ({ name, targetId: "player:" + index, playerIndexes: [index], targetType: "player",
      thru: Object.keys(scores).length, total: Object.values(scores).reduce((sum, value) => sum + value, 0),
      toPar: Object.values(scores).reduce((sum, value) => sum + value - 3, 0) })),
    roundConfig: { groupFormat: "singles", scoringStyle: "stroke" },
    lockedCardIds: state.locked ? ["c0"] : [], cardLocked: state.locked,
  });
  state.broadcast = () => {
    const message = JSON.stringify({ type: "snapshot", ...state.snapshot() });
    for (const socket of state.sockets) { try { socket.send(message); } catch { /* closed */ } }
  };
  state.mutate = () => { state.rev += 1; state.updatedAt = new Date().toISOString(); };
  return state;
}

async function installScorerApi(context, state) {
  await context.routeWebSocket(API.replace(/^http/, "ws") + "/rounds/" + CODE + "/live/ws", (socket) => {
    state.sockets.add(socket);
    socket.onClose(() => state.sockets.delete(socket));
    setTimeout(() => { try { socket.send(JSON.stringify({ type: "snapshot", ...state.snapshot() })); } catch { /* closed */ } }, 50);
  });
  await context.route(API + "/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (value, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(value) });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } });
    const live = "/rounds/" + CODE + "/live";
    if (path === live + "/score" && request.method() === "POST") {
      const body = request.postDataJSON();
      const order = body.recovery && body.recovery.order;
      state.posts += 1;
      if (!state.receipts.has(order)) {
        const player = state.players[body.index];
        if (!player) return reply({ error: "invalid_score" }, 400);
        if (body.strokes == null) { delete player.scores[body.hole]; delete player.scorecards[body.hole]; }
        else { player.scores[body.hole] = body.strokes; player.scorecards[body.hole] = { "player:0": body.strokes }; }
        state.receipts.add(order);
        state.mutate();
        setTimeout(state.broadcast, 120);
      }
      // A lost response: the server saved the write, the phone never hears back and must retry.
      if (state.dropNext > 0) { state.dropNext -= 1; return route.abort("connectionreset"); }
      return reply(state.snapshot());
    }
    if (path === live + "/finish-card" && request.method() === "POST") {
      state.status = "final";
      state.locked = true;
      state.mutate();
      setTimeout(state.broadcast, 80);
      return reply(state.snapshot());
    }
    if (path === live + "/mine" || path === live) return reply(state.snapshot());
    if (path === live + "/clips") return reply({ clips: [] });
    if (path === live + "/sharing") return reply({ owner: true, visibility: "card", includeMarked: false, clips: false });
    if (path === "/me") return reply({ sub: MEMBER_ID, name: NAMES[0] });
    if (path === "/me/dashboard-theme") return reply({ theme: null });
    if (path === "/courses/100/layouts") return reply({ layouts: [{ id: 101, name: "Short tees", holes: state.holes }] });
    if (path === "/courses/100/positions") return reply({ positions: [] });
    if (path === "/layouts/101/handicaps") return reply({ players: [] });
    return reply({});
  });
}

// Records which listeners, intervals and observers come from the field test recorder file.
function instrumentationProbe() {
  const probe = { listeners: [], intervals: [], observers: 0, socketListeners: [] };
  window.__fieldProbe = probe;
  const fromRecorder = () => /field-test-recorder/.test(new Error().stack || "");
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, handler, options) {
    if (this instanceof WebSocket) probe.socketListeners.push(type);
    if (fromRecorder()) probe.listeners.push(type);
    return add.call(this, type, handler, options);
  };
  const interval = window.setInterval;
  window.setInterval = function (handler, delay, ...rest) {
    probe.intervals.push({ delay: Number(delay) || 0, recorder: fromRecorder() });
    return interval.call(this, handler, delay, ...rest);
  };
  const Observer = window.MutationObserver;
  window.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); if (fromRecorder()) probe.observers += 1; }
  };
}

async function newContext({ width = 390, height = 844, scheme = "light", field = true, large = false, label = "QA Chromium" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(({ value, field, scheme, large, label }) => {
    try {
      if (!localStorage.getItem("fieldQaSeeded")) {
        localStorage.setItem("fieldQaSeeded", "1");
        localStorage.setItem("gvdg_member_token", value);
        localStorage.setItem("theme", scheme);
        if (field) { localStorage.setItem("gvdg_field_test", "1"); localStorage.setItem("gvdg_field_device", label); }
      }
    } catch { /* about:blank */ }
    if (large) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "130%"; });
  }, { value: token(MEMBER_ID), field, scheme, large, label });
  await context.addInitScript(instrumentationProbe);
  const requests = [];
  context.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const errors = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(message.text())) errors.push(message.text()); });
  });
  return { context, requests, errors };
}

async function openScorer(context, state) {
  await installScorerApi(context, state);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(site + "/score.html?round=" + CODE, { waitUntil: "domcontentloaded" });
  await page.locator(".score-glove-scores .prow .stepper .plus").first().waitFor();
  return page;
}

async function openMembers(context, hash, theme = null) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await installMemberDashboardApiRoutes(page, API);
  await page.route(API + "/me/dashboard-theme", (route) => route.fulfill({ status: 200, contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ theme }) }));
  await page.route(API + "/me", (route) => route.fulfill({ status: 200, contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ sub: MEMBER_ID, name: NAMES[0], isAdmin: false }) }));
  await page.goto(site + "/gvdg-members.html" + hash, { waitUntil: "domcontentloaded" });
  return page;
}

const plus = (page, row) => page.locator(".score-glove-scores .prow").nth(row).locator(".stepper .plus");
const nextHole = (page) => page.getByRole("button", { name: "Next hole" });
async function synced(page, state, posts) {
  await page.waitForFunction(() => !document.querySelector(".card-sync-summary"), null, { timeout: 30000 });
  if (posts != null) assert.ok(state.posts >= posts, "server saw " + state.posts + " score writes, expected " + posts);
}
async function score(page, row, taps = 1) {
  for (let tap = 0; tap < taps; tap += 1) {
    await plus(page, row).click();
    await page.waitForTimeout(220);
  }
}
async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// ===================== 1. Field test mode ON: a full round =====================
const on = await newContext();
const round = createRound();
const scorer = await openScorer(on.context, round);
await scorer.locator('[data-field-test-badge="on"]').waitFor();
assert.ok(on.requests.includes("/score-app/field-test-recorder.js"), "the recorder loads when the mode is on");

// Hole 1: both players.
await score(scorer, 0, 1);
await score(scorer, 1, 2);
await synced(scorer, round, 3);
assert.deepEqual([round.players[0].scores[1], round.players[1].scores[1]], [3, 4]);

// Hole 2 offline, then back online.
await nextHole(scorer).click();
await scorer.waitForTimeout(250);
await on.context.setOffline(true);
await scorer.waitForTimeout(300);
await score(scorer, 0, 1);
await score(scorer, 1, 1);
await scorer.locator(".card-sync-summary").waitFor();
await scorer.waitForTimeout(1600);
await on.context.setOffline(false);
await synced(scorer, round, 5);
assert.equal(round.players[1].scores[2], 3);

// The live socket drops; the scorer reconnects after its back-off.
for (const socket of [...round.sockets]) await socket.close({ code: 4000, reason: "qa drop" }).catch(() => {});
await scorer.waitForTimeout(5200);
assert.ok(round.sockets.size >= 1, "the scorer reopened its live socket");

// Hole 3: one response is lost after the server saved the write, so the phone retries it.
await nextHole(scorer).click();
await scorer.waitForTimeout(250);
round.dropNext = 1;
await score(scorer, 0, 2);
await score(scorer, 1, 1);
await synced(scorer, round);
assert.deepEqual([round.players[0].scores[3], round.players[1].scores[3]], [4, 3]);

// Reload mid-round, then notes from the Field test pill.
await scorer.reload({ waitUntil: "domcontentloaded" });
await scorer.locator(".score-glove-scores .prow .stepper .plus").first().waitFor();
await scorer.locator('[data-field-test-badge="on"]').waitFor();
if (shots) await scorer.screenshot({ path: join(shots, "scorer-field-test-pill-390-light.png") });
await scorer.getByRole("button", { name: "Field test on. Add a note" }).click();
const sheet = scorer.locator(".field-test-sheet");
await sheet.waitFor();
await sheet.getByRole("button", { name: "App closed" }).click();
await sheet.locator(".field-note-status").filter({ hasText: "App closed noted" }).waitFor();
await sheet.getByRole("textbox", { name: "Note", exact: true }).fill("Jordan Reyes lost signal by the creek, PDGA 123456");
await sheet.getByRole("button", { name: "Add note" }).click();
await sheet.getByRole("spinbutton", { name: "Battery %" }).fill("81");
await sheet.getByRole("button", { name: "Save battery" }).click();
await sheet.locator(".field-note-status").filter({ hasText: "Battery 81% noted" }).waitFor();
if (shots) await scorer.screenshot({ path: join(shots, "scorer-field-test-sheet-390-light.png") });
await sheet.getByRole("button", { name: "Back to round" }).click();

// Round tools has the switch too: off hides the pill, on brings it back.
await scorer.getByRole("button", { name: "Round tools" }).click();
const toolSwitch = scorer.locator(".round-tools-sheet [data-field-test-switch]");
await scorer.locator('.round-tools-sheet [data-field-test-switch="on"]').waitFor();
await toolSwitch.click();
await scorer.locator('.round-tools-sheet [data-field-test-switch="off"]').waitFor();
assert.equal(await scorer.locator("[data-field-test-badge]").count(), 0, "turning the mode off removes the pill");
assert.equal(await scorer.evaluate(() => localStorage.getItem("gvdg_field_test")), null);
await toolSwitch.click();
await scorer.locator('.round-tools-sheet [data-field-test-switch="on"]').waitFor();
await scorer.locator(".round-tools-sheet").getByRole("button", { name: "Back to round" }).click();
await scorer.locator('[data-field-test-badge="on"]').waitFor();

// Hole 4 and finish: the active hole after reload is the first one still missing a score.
await scorer.getByRole("heading", { name: "Hole 4" }).waitFor();
await score(scorer, 0, 1);
await score(scorer, 1, 1);
await synced(scorer, round);
await scorer.getByRole("button", { name: "Finish card" }).click();
await scorer.getByRole("button", { name: "Looks good — lock card" }).click();
await scorer.getByText("Round finished — scores are locked").waitFor();
await scorer.waitForTimeout(1200);
const probeOn = await scorer.evaluate(() => window.__fieldProbe);
assert.ok(probeOn.listeners.includes("pointerdown") && probeOn.listeners.includes("unhandledrejection"), "the probe sees the recorder's listeners when on");
assert.ok(probeOn.intervals.some((row) => row.recorder && row.delay === 300000) || !(await scorer.evaluate(() => typeof navigator.getBattery === "function")),
  "battery is sampled every 5 minutes where the battery API exists");
assert.ok(
  probeOn.socketListeners.filter((type) => type === "open").length >= 2
    && probeOn.socketListeners.filter((type) => type === "close").length >= 2,
  "the live socket's open and close are followed when on",
);
await scorer.close();

// The member Field log: summary, export, clear.
const log = await openMembers(on.context, "#field-test");
await log.locator('[data-member-field-test="ready"]').waitFor();
await log.locator('[data-field-summary="ready"]').waitFor();
const tile = async (id) => ({
  value: (await log.locator(`[data-field-tile="${id}"] .field-tile-value`).textContent()).trim(),
  detail: (await log.locator(`[data-field-tile="${id}"] .field-tile-detail`).textContent()).trim(),
});
const feedbackTile = await tile("feedback");
const ackTile = await tile("ack");
const roundsTile = await tile("rounds");
const offlineTile = await tile("offline");
const retriesTile = await tile("retries");
console.log("Field log tiles:", JSON.stringify({ feedbackTile, ackTile, roundsTile, offlineTile, retriesTile }));
assert.match(feedbackTile.value, /^\d+ ms$/);
assert.ok(Number(feedbackTile.value.split(" ")[0]) < 2000, "score feedback is a plausible frame time");
assert.match(ackTile.value, /^\d+ ms$/);
assert.equal(roundsTile.value, "1 of 1");
assert.equal(roundsTile.detail, "Final cards match this phone");
assert.notEqual(offlineTile.value, "0 min");
assert.match(retriesTile.value, /^[1-9]\d* \/ [1-9]\d*$/, "the lost response shows up as a retry and a failed attempt");
assert.equal(await overflow(log), 0, "no sideways scroll on the Field log");

const downloads = [];
log.on("download", (download) => downloads.push(download));
await log.locator('[data-field-export="share"]').click();
await log.locator('[data-field-status]').filter({ hasText: /Saved|Shared/ }).waitFor();
await log.waitForTimeout(500);
assert.equal(downloads.length, 2, "Export falls back to downloading the JSON and the CSV");
const files = {};
for (const download of downloads) files[extname(download.suggestedFilename())] = await readFile(await download.path(), "utf8");
assert.match(downloads[0].suggestedFilename(), /^gvdg-field-log-qa-chromium-\d{8}-\d{4}\.json$/);
const exported = JSON.parse(files[".json"]);
const csv = files[".csv"];
assert.equal(exported.schema, "gvdg-field-log/1");
assert.equal(exported.device.label, "QA Chromium");
assert.equal(exported.device.memberId, MEMBER_ID);
const typesSeen = new Set(exported.events.map((event) => event.type));
for (const type of ["session.start", "session.build", "field.off", "field.on", "tap.feedback", "sync.queue", "sync.ack", "net.offline", "net.online",
  "ws.open", "ws.close", "live.update", "round.open", "round.finish", "round.check", "note"]) {
  assert.ok(typesSeen.has(type), "export has " + type);
}
assert.ok(typesSeen.has("battery") || typesSeen.has("battery.unavailable"), "battery or its absence is recorded");
assert.ok(exported.events.filter((event) => event.type === "session.start").length >= 2, "the reload started a second session");
assert.ok(exported.events.some((event) => event.type === "ws.open" && Number.isFinite(event.recoverMs)), "socket recovery time is recorded");
assert.ok(exported.events.some((event) => event.type === "sync.ack" && event.state === "pending"), "the lost response is recorded");
const check = exported.events.find((event) => event.type === "round.check");
assert.equal(check.verdict, "match");
assert.equal(check.checked, 8);
const summary = exported.summary;
assert.ok(summary.feedback.n >= 8 && summary.feedback.median > 0 && summary.feedback.median < 2000, "feedback samples " + JSON.stringify(summary.feedback));
assert.ok(summary.feedback.max >= summary.feedback.p90 && summary.feedback.p90 >= summary.feedback.median);
assert.ok(summary.ack.n >= 8 && summary.ack.median >= 0 && summary.ack.median < 10000, "ack samples " + JSON.stringify(summary.ack));
assert.ok(summary.network.offlineMs >= 1500 && summary.network.offlineMs < 60000, "offline time " + summary.network.offlineMs);
assert.ok(summary.network.reconnects >= 1 && summary.network.recovery.median >= 3000, "reconnect " + JSON.stringify(summary.network.recovery));
assert.equal(summary.rounds.finished, 1);
assert.equal(summary.rounds.suspected, 0);
assert.ok(summary.live.scorer && summary.live.scorer.delay.n >= 1, "live update delay is measured");
assert.ok(summary.conditions.interrupted.feedback.n >= 2, "offline taps are filed as interrupted");
const notes = exported.events.filter((event) => event.type === "note");
assert.deepEqual(notes.map((event) => event.chip || event.text).slice(0, 2), ["App closed", "[player] lost signal by the creek, PDGA [number]"]);
assert.equal(notes.find((event) => event.chip === "Battery").battery, 81);
for (const secret of [...NAMES, ...NAMES.flatMap((name) => name.split(" ")), "123456", "gvdg_member_token"]) {
  assert.ok(!files[".json"].includes(secret), "the JSON export leaks " + secret);
  assert.ok(!csv.includes(secret), "the CSV export leaks " + secret);
}
assert.ok(csv.startsWith("seq,time,session,app,type,net,eff,ms,target,kind,hole,state,status,detail\r\n"));
assert.equal(csv.trim().split("\r\n").length, exported.events.length + 1);
assert.ok(!/(^|,)[=+\-@]/m.test(csv.replace(/"[^"]*"/g, "")), "no CSV cell starts a formula");
console.log("Export:", exported.events.length, "events;", "feedback median", summary.feedback.median, "ms; ack median", summary.ack.median,
  "ms; offline", summary.network.offlineMs, "ms; recovery", summary.network.recovery.median, "ms");

// Clear with confirmation.
await log.locator('[data-field-clear="ask"]').click();
await log.getByRole("alertdialog", { name: "Clear the field log" }).waitFor();
await log.locator('[data-field-clear="confirm"]').click();
await log.locator('[data-field-status]').filter({ hasText: "empty" }).waitFor();
const left = await log.evaluate(() => new Promise((done) => {
  const request = indexedDB.open("gvdg-field-test", 1);
  request.onsuccess = () => { const count = request.result.transaction("events").objectStore("events").count(); count.onsuccess = () => done(count.result); };
  request.onerror = () => done(-1);
}));
assert.ok(left >= 0 && left < 5, "the log is empty after Clear log (" + left + " left)");
assert.deepEqual(on.errors, [], "no page errors with field test mode on");
await on.context.close();

// ===================== 2. Field test mode OFF: nothing loads or listens =====================
const off = await newContext({ field: false });
const quiet = createRound();
const plain = await openScorer(off.context, quiet);
await score(plain, 0, 1);
await score(plain, 1, 1);
await synced(plain, quiet, 2);
await off.context.setOffline(true);
await score(plain, 0, 1);
await off.context.setOffline(false);
await synced(plain, quiet);
await plain.reload({ waitUntil: "domcontentloaded" });
await plain.locator(".score-glove-scores .prow .stepper .plus").first().waitFor();
await plain.waitForTimeout(800);
assert.equal(await plain.locator("[data-field-test-badge]").count(), 0, "no Field test pill when off");
const probeOff = await plain.evaluate(() => window.__fieldProbe);
assert.deepEqual(probeOff.listeners, [], "no recorder listeners when off");
assert.equal(probeOff.observers, 0, "no mutation observer when off");
assert.ok(!probeOff.intervals.some((row) => row.recorder), "no recorder timer when off");
assert.deepEqual([...probeOff.socketListeners].sort(), ["close", "error", "message", "open"], "the live socket keeps only its own listeners");
const databases = await plain.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((row) => row.name) : []));
assert.ok(!databases.includes("gvdg-field-test"), "no field log database when off");
if (shots) await plain.screenshot({ path: join(shots, "scorer-field-test-off-390-light.png") });
await plain.close();
const account = await openMembers(off.context, "#account");
await account.locator('[data-field-test-switch="off"]').waitFor();
assert.equal(await account.locator("[data-member-field-log-link]").count(), 0, "no Field log row before the mode was ever used");
await account.waitForTimeout(600);
const recorderLoads = off.requests.filter((path) => /field-test-recorder/.test(path));
assert.deepEqual(recorderLoads, [], "the recorder module never loads when off");
assert.deepEqual(off.errors, [], "no page errors with field test mode off");
await off.context.close();
console.log("Off: no recorder request, no listeners, timers, observers or database.");

// ===================== 3. Review screenshots =====================
if (shots) {
  const seed = exported.events;
  const variants = [
    { tag: "390-light", width: 390, height: 844, scheme: "light" },
    { tag: "390-dark", width: 390, height: 844, scheme: "dark" },
    { tag: "320-large-dark", width: 320, height: 720, scheme: "dark", large: true },
  ];
  const wallpaper = "data:image/jpeg;base64," + (await readFile(join(repo, "img/slide5.jpg"))).toString("base64");
  const glass = buildTheme({ mode: "dark", wallpaper, preset: "Frost", glass: { opacity: GLASS_PRESETS.frosted.opacity, blur: GLASS_PRESETS.frosted.blur } });
  async function seedLog(page) {
    await page.evaluate((events) => new Promise((done, fail) => {
      const request = indexedDB.open("gvdg-field-test", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
      request.onsuccess = () => {
        const tx = request.result.transaction("events", "readwrite");
        const store = tx.objectStore("events");
        store.clear();
        for (const { seq: _seq, ...event } of events) store.add(event);
        tx.oncomplete = () => { request.result.close(); done(); };
        tx.onabort = () => fail(tx.error);
      };
    }), seed);
  }
  for (const variant of [...variants, { tag: "390-glass-dark", width: 390, height: 844, scheme: "dark", theme: glass }]) {
    const { context, errors } = await newContext({ ...variant });
    // Scorer with the pill.
    if (!variant.theme) {
      const state = createRound();
      state.players[0].scores = { 1: 3 }; state.players[1].scores = { 1: 4 };
      const page = await openScorer(context, state);
      await page.locator('[data-field-test-badge="on"]').waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shots, "scorer-field-test-" + variant.tag + ".png") });
      if (variant.tag === "390-dark") {
        await page.getByRole("button", { name: "Round tools" }).click();
        await page.locator('.round-tools-sheet [data-field-test-switch="on"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(shots, "scorer-round-tools-switch-390-dark.png") });
      }
      assert.equal(await overflow(page), 0, "scorer overflow " + variant.tag);
      await page.close();
    }
    // Account > Devices with the switch.
    const accountPage = await openMembers(context, "#account", variant.theme || null);
    const devices = accountPage.locator('[data-member-account-devices="ready"]');
    await devices.waitFor();
    await accountPage.locator('[data-field-test-switch="on"]').waitFor();
    await devices.scrollIntoViewIfNeeded();
    await accountPage.waitForTimeout(400);
    await accountPage.screenshot({ path: join(shots, "account-field-test-toggle-" + variant.tag + ".png") });
    assert.equal(await overflow(accountPage), 0, "account overflow " + variant.tag);
    // Field log summary with a real round's events.
    await seedLog(accountPage);
    await accountPage.evaluate(() => { location.hash = "#field-test"; });
    await accountPage.locator('[data-field-summary="ready"]').waitFor();
    await accountPage.getByRole("button", { name: "Refresh" }).click();
    await accountPage.locator('[data-field-tile="rounds"] .field-tile-value').filter({ hasText: "1 of 1" }).waitFor();
    await accountPage.evaluate(() => window.scrollTo(0, 0));
    await accountPage.waitForTimeout(300);
    await accountPage.screenshot({ path: join(shots, "field-log-" + variant.tag + ".png") });
    await accountPage.locator(".field-summary-section").scrollIntoViewIfNeeded();
    await accountPage.waitForTimeout(700);
    await accountPage.screenshot({ path: join(shots, "field-log-summary-" + variant.tag + ".png") });
    await accountPage.screenshot({ path: join(shots, "field-log-full-" + variant.tag + ".png"), fullPage: true });
    assert.equal(await overflow(accountPage), 0, "field log overflow " + variant.tag);
    await accountPage.close();
    // The public checklist.
    if (!variant.theme) {
      const guide = await context.newPage();
      await guide.goto(site + "/field-test.html", { waitUntil: "networkidle" });
      await guide.screenshot({ path: join(shots, "field-test-page-" + variant.tag + ".png") });
      await guide.screenshot({ path: join(shots, "field-test-page-full-" + variant.tag + ".png"), fullPage: true });
      assert.equal(await overflow(guide), 0, "field-test.html overflow " + variant.tag);
      await guide.close();
    }
    assert.deepEqual(errors, [], "no page errors in screenshots " + variant.tag);
    await context.close();
  }
  const wide = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", serviceWorkers: "block" });
  const guide = await wide.newPage();
  await guide.goto(site + "/field-test.html", { waitUntil: "networkidle" });
  await guide.screenshot({ path: join(shots, "field-test-page-1280-light.png"), fullPage: true });
  await guide.emulateMedia({ media: "print" });
  const pdf = await guide.pdf({ format: "Letter" });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pages, 1, "the checklist prints on one page");
  await guide.screenshot({ path: join(shots, "field-test-page-print.png"), fullPage: true });
  await wide.close();
  console.log("Screenshots in " + shots);
}

await browser.close();
server.close();
console.log("Field test browser QA passed.");
