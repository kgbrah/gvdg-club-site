import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";
import { buildTheme } from "../../src/shared/dashboard-theme-model.js";

const out = process.env.GVDG_SCORER_SCREENSHOTS || "/tmp/gvdg-scorer-polish";
await mkdir(out, { recursive: true });
const fontDir = process.env.GVDG_SCORE_FONT_DIR;
const serve = process.env.GVDG_SCORER_SERVE === "1";
const compiled = await build({
  configFile: false, mode: "production", logLevel: "silent",
  build: { write: false, emptyOutDir: false,
    rolldownOptions: { input: "src/score-app/main.js", output: { entryFileNames: "qa-score.js" } } },
});
const output = (Array.isArray(compiled) ? compiled : [compiled]).flatMap((result) => result.output);
const bundles = new Map(output.map((file) => ["/" + file.fileName, file.type === "chunk" ? file.code : file.source]));
let html = (await readFile("score.html", "utf8")).replace(/src="score-app\/score-app\.js[^"]*"/, 'src="/qa-score.js"')
  .replace('<script src="pwa.js" defer></script>', "");
if (fontDir) {
  html = html.replace("</head>", '<style>@font-face{font-family:Archivo;font-style:normal;font-weight:400 900;src:url("/img/fonts/archivo.woff2") format("woff2")}</style></head>');
}
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (serve && path.startsWith("/qa-api/")) return await previewReply(request, response, url);
    if (serve && path === "/score.html") {
      const session = previewSession(request, response);
      const theme = url.searchParams.get("appearance");
      if (theme === "light" || theme === "dark" || theme === "ocean") session.appearance = theme;
      response.setHeader("Content-Type", "text/html");
      const seeded = html.replace('data-api-base=""', 'data-api-base="' + site + '/qa-api"')
        .replace("</head>", '<script>localStorage.setItem("gvdg_member_token", "qa-scorer-visual");localStorage.setItem("theme",' +
          JSON.stringify(session.appearance === "light" ? "light" : "dark") + ');</script></head>');
      return response.end(seeded);
    }
    const localAsset = /^(?:\/(?:img|src\/shared)\/|\/(?:tokens|watch-pairing|score-polish)\.css$)/.test(path);
    if (path !== "/score.html" && !bundles.has(path) && !localAsset) return response.writeHead(404).end();
    const body = path === "/score.html" ? html : bundles.get(path) ??
      await readFile(fontDir && path === "/img/fonts/archivo.woff2" ? join(fontDir, "archivo.woff2") : "." + path);
    response.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(Number(process.env.GVDG_SCORER_PORT || 0), "127.0.0.1", ready));
const site = "http://127.0.0.1:" + server.address().port;
console.log("Scorer QA fixture " + site);
const api = "http://127.0.0.1:8788";
const browser = serve ? null : await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const initials = { starts: { 1: 3, 2: 2, 3: 3 }, other: { 1: 4, 2: 3, 3: 4 } };
const holes = Array.from({ length: 9 }, (_, index) => ({
  hole: index + 1, par: 3, distance_ft: 272 + index * 18,
  tee: { label: "Long", lat: 34.95490 + index * 0.00035, lng: -82.18772 },
  target: { label: "Basket", lat: 34.95536 + index * 0.00035, lng: -82.18713 },
}));
const course = { id: 100, name: "Rocky Ford", lat: 34.955, lng: -82.188, location: "Greenville", coverage: "full" };
const layout = { id: 101, name: "Long tees", course_id: 100, expected_holes: 9, holes };
const code = "GVDG44";
const roundId = "qa-visual-round-v1";
const edit = { kind: "throw", attempt: "throw", outcome: "missed", originLie: "tee", landingLie: "fairway",
  id: "10000000-0000-4000-8000-000000000001", recordedAt: Date.now(), distanceFt: 219, distanceSource: "manual" };

function roster(group) {
  const names = group === "doubles" ? ["Taylor Morgan", "Avery Brooks", "Jordan Reyes", "Morgan Lee"]
    : ["Taylor Morgan", "Avery Brooks", "Jordan Reyes"];
  return names.map((name, index) => {
    const scores = { ...(index < (group === "doubles" ? 2 : 1) ? initials.starts : initials.other) };
    return {
      index, cardId: "c0", name, isMe: index === 0, canEnterScorecard: index === 0,
      startingHole: 4, scores, scorecards: Object.fromEntries(Object.entries(scores).map(([hole, strokes]) => [hole, { "player:0": strokes }])),
      throws: index === 0 ? { 4: [{ lat: 34.9561, lng: -82.1876, n: 1 }] } : {},
    };
  });
}

const customTheme = buildTheme({ mode: "dark", preset: "Frost",
  wallpaper: "data:image/jpeg;base64," + (await readFile("img/slide4.jpg")).toString("base64") });
assert.ok(customTheme?.wallpaper);
const previewSessions = new Map();
function previewSession(request, response) {
  const current = /(?:^|; *)qa-scorer=([0-9a-f-]+)(?:;|$)/.exec(request.headers.cookie || "")?.[1];
  const prior = previewSessions.get(current);
  if (prior) return prior;
  const id = randomUUID();
  const session = { appearance: "light", players: roster("singles"), rev: 1, receipts: new Map() };
  previewSessions.set(id, session);
  response.setHeader("Set-Cookie", "qa-scorer=" + id + "; HttpOnly; Path=/; SameSite=Strict");
  return session;
}

async function previewReply(request, response, url) {
  const state = previewSession(request, response);
  const players = state.players;
  const scoreTargets = players.map(({ index, name }) => ({ id: "player:" + index, type: "player", label: name,
    playerIndexes: [index], members: [name] }));
  const path = url.pathname.slice("/qa-api".length);
  const reply = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return response.end(JSON.stringify(value));
  };
  const shotLedgers = { 0: { 4: { version: 1, targetId: "player:0", binding: "0", label: players[0].name, scope: "player",
    revision: "0000000000000000:10000000-0000-4000-8000-000000000005", rows: [edit],
    geometry: { tee: holes[3].tee, target: holes[3].target } } } };
  function snapshot() {
    const standings = players.map(({ index, name, scores }) => ({
      name, targetId: "player:" + index, playerIndexes: [index], targetType: "player",
      thru: Object.keys(scores).length, total: Object.values(scores).reduce((sum, value) => sum + value, 0),
      toPar: Object.values(scores).reduce((sum, value) => sum + value - 3, 0),
      scorecard: Object.entries(scores).map(([hole, strokes]) => ({ hole: Number(hole), strokes, par: 3 })),
    }));
    return { status: "live", roundCode: code, courseId: course.id, layoutId: layout.id, courseName: course.name,
      layoutName: layout.name, recoveryRoundId: roundId, rev: state.rev, holes, scoreTargets, standings,
      cardId: "c0", playerIndex: 0, players, cardmates: players, shotLedgers, conflicts: [], missing: [],
      roundConfig: { groupFormat: "singles", scoringStyle: "stroke" }, startingHole: 4 };
  }
  if (path.endsWith("/live/score") && request.method === "POST") {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 8000) return reply({ error: "request_too_large" }, 413);
    }
    const body = JSON.parse(raw);
    const player = players[body.index];
    const order = body.recovery?.order;
    if (!player || !order) return reply({ error: "invalid_score" }, 400);
    if (state.receipts.has(order)) return reply(snapshot());
    if ((player.scorecards[body.hole]?.["player:0"] ?? null) !== body.recovery.previous) return reply({ error: "recovery_edit_conflict" }, 409);
    if (body.strokes == null) { delete player.scores[body.hole]; delete player.scorecards[body.hole]; }
    else { player.scores[body.hole] = body.strokes; player.scorecards[body.hole] = { "player:0": body.strokes }; }
    state.receipts.set(order, true);
    state.rev += 1;
    return reply(snapshot());
  }
  if (path.endsWith("/live/mine") || path.endsWith("/live")) return reply(snapshot());
  if (path.endsWith("/live/throws")) return reply({ shotLedgers });
  if (path.endsWith("/live/sharing")) return reply({ visibility: "card", includeMarked: false, clips: false });
  if (path.endsWith("/live/clips")) return reply({ clips: [] });
  if (path === "/me/dashboard-theme") return reply({ theme: state.appearance === "ocean" ? customTheme : null });
  if (path === "/me") return reply({ sub: "m_scorer_qa", name: players[0].name });
  if (path === "/courses") return reply({ courses: [course] });
  if (path === "/courses/100/layouts") return reply({ layouts: [layout] });
  if (path === "/rounds") return reply({ code });
  return reply({ rounds: [], events: [], devices: [], rows: [] });
}

async function makePage({ width, height, scheme = "light", scale = 1, group = "singles", locked = false, complete = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme === "light" ? "light" : "dark",
    permissions: ["geolocation", "camera", "microphone"], geolocation: { latitude: 34.9561, longitude: -82.1876, accuracy: 4 },
    serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.setDefaultNavigationTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const players = roster(group);
  if (complete) for (const player of players) for (const { hole } of holes) {
    player.scores[hole] = 3;
    player.scorecards[hole] = { "player:0": 3 };
  }
  let finished = locked;
  const controls = group === "doubles" ? [[0, 1], [2, 3]] : players.map(({ index }) => [index]);
  const scoreTargets = controls.map((indexes, index) => group === "doubles"
    ? { id: "pair:team " + (index + 1), type: "pair", label: "Team " + (index + 1),
      playerIndexes: indexes, members: indexes.map((i) => players[i].name) }
    : { id: "player:" + index, type: "player", label: players[index].name, playerIndexes: indexes, members: [players[index].name] });
  const theme = scheme === "ocean" ? customTheme : null;
  let writes = [];
  let rev = 1;
  let offline = false;
  let dropReply = false;
  const ack = new Map();
  const shotLedgers = { 0: { 4: {
    revision: "0000000000000000:10000000-0000-4000-8000-000000000005", version: 1,
    targetId: scoreTargets[0].id, binding: controls[0].join(","), label: scoreTargets[0].label,
    scope: group === "doubles" ? "team" : "player", rows: [edit], geometry: { tee: holes[3].tee, target: holes[3].target },
  } } };
  function snapshot() {
    const standings = scoreTargets.map((target) => {
      const row = players[target.playerIndexes[0]];
      const scorecard = Object.entries(row.scores).map(([hole, strokes]) => ({ hole: Number(hole), strokes, par: 3 }));
      return { name: target.label, targetId: target.id, playerIndexes: target.playerIndexes, targetType: target.type, thru: scorecard.length,
        total: scorecard.reduce((sum, value) => sum + value.strokes, 0), toPar: scorecard.reduce((sum, value) => sum + value.strokes - 3, 0), scorecard,
        ...(group === "doubles" ? { match: { status: target.id.endsWith("1") ? "1 UP" : "1 DN", outcome: target.id.endsWith("1") ? "leading" : "trailing" } } : {}) };
    });
    return { status: finished ? "final" : "live", cardLocked: finished, roundCode: code, courseId: course.id, layoutId: layout.id,
      courseName: course.name, layoutName: layout.name, recoveryRoundId: roundId, rev, holes, scoreTargets, standings,
      cardId: "c0", playerIndex: 0, players, cardmates: players, shotLedgers, conflicts: [], missing: [],
      roundConfig: { groupFormat: group, scoringStyle: group === "doubles" ? "matchplay" : "stroke" }, startingHole: 4 };
  }
  await context.routeWebSocket("ws://127.0.0.1:8788/**", () => {});
  await context.route(/^https?:\/\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === site) return route.continue();
    if (url.origin !== api) return route.abort();
    const allow = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization,Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH, PUT, DELETE" };
    const reply = (json, status = 200) => route.fulfill({ json, status, headers: allow });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: allow });
    const path = url.pathname;
    if (path.endsWith("/live/mine")) {
      if (offline) return route.abort("internetdisconnected");
      const data = snapshot();
      if (path.startsWith("/rounds/ALT44/")) return reply({ ...data, roundCode: "ALT44", recoveryRoundId: "alternate-visual-round" });
      if (request.headers().authorization === "Bearer qa-another-actor") {
        const mates = data.cardmates.map((mate) => ({ ...mate, isMe: mate.index === 1, canEnterScorecard: mate.index === 1 }));
        return reply({ ...data, playerIndex: 1, cardmates: mates, players: mates, shotLedgers: {} });
      }
      return reply(data);
    }
    if (path.endsWith("/live/score") && request.method() === "POST") {
      if (offline) return route.abort("internetdisconnected");
      const body = request.postDataJSON();
      const { order, previous, actorIndex } = body.recovery;
      assert.equal(actorIndex, 0);
      const target = scoreTargets.find((entry) => entry.id === body.targetId);
      const anchors = target?.playerIndexes || [body.index];
      const player = players[anchors[0]];
      writes.push({ order, previous, strokes: body.strokes });
      if (ack.has(order)) {
        assert.equal(ack.get(order), body.strokes);
        return reply(snapshot());
      }
      const old = player.scorecards[body.hole]?.["player:0"] ?? null;
      if (old !== previous) return reply({ error: "recovery_edit_conflict" }, 409);
      for (const index of anchors) {
        if (body.strokes == null) { delete players[index].scores[body.hole]; delete players[index].scorecards[body.hole]; }
        else { players[index].scores[body.hole] = body.strokes; players[index].scorecards[body.hole] = { "player:0": body.strokes }; }
      }
      ack.set(order, body.strokes);
      rev += 1;
      if (dropReply) { dropReply = false; return route.abort("connectionreset"); }
      return reply(snapshot());
    }
    if (path.endsWith("/live/finish-card") && request.method() === "POST") {
      if (!complete) return reply({ error: "scorecard_incomplete", missing: [{ hole: 5, playerIndex: 0 }] }, 409);
      const body = request.postDataJSON();
      assert.deepEqual(body.recovery, { roundId, cardId: "c0", actorIndex: 0 });
      finished = true;
      rev += 1;
      return reply(snapshot());
    }
    if (path.endsWith("/live/throws") && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.throws) { players[0].throws[body.hole] = body.throws; rev += 1; }
      return reply({ snapshot: snapshot() });
    }
    if (path.endsWith("/live/throws")) return reply({ shotLedgers });
    if (path.endsWith("/live/sharing")) return reply({ visibility: "card", includeMarked: false, clips: false });
    if (path.endsWith("/live/clips")) return reply({ clips: [] });
    if (path.endsWith("/live")) return reply(snapshot());
    if (path === "/me/dashboard-theme") return reply({ theme });
    if (path === "/me") return reply({ sub: "m_scorer_qa", name: "Taylor Morgan" });
    if (path === "/activity/pairings" || path.startsWith("/watch/pairings")) return reply({ devices: [] });
    if (path === "/courses") return reply({ courses: [course] });
    if (path === "/courses/100/layouts") return reply({ layouts: [layout] });
    if (path === "/rounds") return reply({ code });
    return reply({ rounds: [], events: [], rows: [] });
  });
  await page.addInitScript(({ scheme, scale }) => {
    localStorage.setItem("gvdg_member_token", localStorage.getItem("qa-scorer-actor") || "qa-scorer-visual");
    localStorage.setItem("gvdg_member_name", "Taylor Morgan");
    localStorage.setItem("theme", scheme === "light" ? "light" : "dark");
    Object.defineProperty(navigator, "onLine", { get: () => localStorage.getItem("qa-offline") !== "yes" });
    if (scale !== 1) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = 16 * scale + "px"; });
  }, { scheme, scale });
  const button = (label) => page.getByRole("button", { name: label, exact: true });
  const go = (query = "") => page.goto(site + "/score.html" + query, { waitUntil: "domcontentloaded" });
  async function ready() {
    await button("Round tools").waitFor();
    if (theme) await page.locator("body.player-theme-page").waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
  async function noOverflow() {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.deepEqual(errors, []);
  }
  async function offlineMode(value) {
    offline = value;
    await page.evaluate((next) => {
      if (next) localStorage.setItem("qa-offline", "yes");
      else localStorage.removeItem("qa-offline");
      window.dispatchEvent(new Event(next ? "offline" : "online"));
    }, value);
  }
  function changeScope(actor) {
    offline = false;
    return page.evaluate((next) => {
      localStorage.removeItem("qa-offline");
      if (next) localStorage.setItem("qa-scorer-actor", next);
      else localStorage.removeItem("qa-scorer-actor");
    }, actor);
  }
  const screenshot = (name) => page.screenshot({ path: join(out, name + ".png"), animations: "disabled", fullPage: width <= 320 });
  return { page, context, button, go, ready, noOverflow, offlineMode, screenshot, changeScope, writes: () => writes, data: players,
    editElsewhere(index, hole, strokes) {
      players[index].scores[hole] = strokes;
      players[index].scorecards[hole] = { "player:0": strokes };
      rev += 1;
    },
    lostReply() { dropReply = true; writes = []; } };
}

async function feedbackMetrics(fixture) {
  const rate = Number(process.env.GVDG_SCORER_CPU_RATE || 2);
  const cdp = await fixture.context.newCDPSession(fixture.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await fixture.offlineMode(true);
  try {
    const result = await fixture.page.evaluate(async () => {
      const tasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      });
      observer.observe({ type: "longtask" });
      const samples = { score: [], keypad: [], hole: [] };
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const visible = (element) => Boolean(element?.getBoundingClientRect().width && element?.getBoundingClientRect().height);
      async function measure(type, button, changed) {
        if (!button || button.disabled) throw new Error("Cannot measure " + type);
        const start = performance.now();
        button.click();
        while (!changed()) {
          if (performance.now() - start > 1200) throw new Error("Feedback timeout: " + type);
          await frame();
        }
        await frame(); // The new visible DOM gets a paint opportunity before the sample ends.
        samples[type].push(performance.now() - start);
      }
      const valueButton = () => document.querySelector(".score-entry-card .prow .stepper .val");
      const value = () => valueButton()?.querySelector(".n").textContent;
      const hole = () => document.querySelector(".hole-head .hnum").textContent;
      for (let index = 0; index < 12; index++) {
        const old = value();
        await measure("score", document.querySelector(".score-entry-card .prow .stepper ." + (index % 2 ? "minus" : "plus")),
          () => value() !== old && visible(valueButton()));
        await measure("keypad", valueButton(), () => visible(document.querySelector(".score-pad-sheet")));
        document.querySelector(".score-pad-sheet .sheet-close").click();
        while (document.querySelector(".score-pad-sheet")) await frame();
        const active = hole();
        await measure("hole", document.querySelector(`[aria-label="${index % 2 ? "Previous" : "Next"} hole"]`), () => hole() !== active);
      }
      await frame();
      observer.disconnect();
      const summary = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
        const durations = values.sort((a, b) => a - b);
        return [name, {
          samples: durations.length,
          medianMs: Math.round((durations[5] + durations[6]) / 2),
          p95Ms: Math.round(durations[Math.ceil(durations.length * .95) - 1]),
        }];
      }));
      return { summary, longTasks: tasks.length, maxLongTaskMs: Math.round(Math.max(0, ...tasks)) };
    });
    console.log("Chromium lab feedback at " + rate + "x CPU throttle " + JSON.stringify(result));
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await fixture.offlineMode(false);
  }
}

if (serve) {
  console.log("Preview scorecard " + site + "/score.html?round=" + code);
  console.log("Preview dark theme " + site + "/score.html?round=" + code + "&appearance=dark");
  await new Promise((stop) => { process.once("SIGINT", stop); process.once("SIGTERM", stop); });
  await new Promise((done) => server.close(done));
} else try {
  const phone = await makePage({ width: 390, height: 844 });
  await phone.go();
  await phone.button("Start a casual round").waitFor();
  await phone.screenshot("scoring-home-phone");
  await phone.page.evaluate(async ({ course, layout }) => {
    const { coursePackStore } = await import("/src/shared/course-packs.js");
    const result = await coursePackStore.save(course, layout);
    if (!result.ok) throw new Error("Saved-layout fixture failed");
  }, { course, layout });
  await phone.page.getByRole("link", { name: "Offline rounds", exact: true }).click();
  await phone.button("Start offline round").waitFor();
  await phone.screenshot("offline-setup-phone");
  await phone.go();
  await phone.button("Start a casual round").click();
  await phone.page.locator("#courseSearch").fill("Rocky Ford");
  await phone.page.locator(".tap-row-main").filter({ hasText: "Rocky Ford" }).click();
  await phone.page.getByRole("button", { name: /Long tees/ }).first().click();
  await phone.page.getByRole("heading", { name: "Round setup" }).waitFor();
  await phone.screenshot("round-setup-phone");
  await phone.page.locator("[data-create-round='casual']").click();
  await phone.ready();
  assert.equal(await phone.page.locator(".score-glove-layout > .hole-head .hnum").textContent(), "Hole 4");
  assert.equal(await phone.page.locator(".hole-head").evaluate((heading) => heading.nextElementSibling?.classList.contains("score-glove-stage")), true);
  assert.equal(await phone.button("Finish card").count(), 0, "No finish action on an incomplete card with missing entries omitted");
  await phone.screenshot("scorecard-phone-light");
  await phone.button("Round tools").click();
  await phone.page.getByRole("dialog", { name: "Round tools" }).waitFor();
  await phone.screenshot("round-tools-phone");
  await phone.button("Shot details").click();
  await phone.button("Edit stroke 1").click();
  await phone.page.getByLabel("Outcome", { exact: true }).selectOption("missed");
  await phone.screenshot("shot-editor-phone");
  await phone.page.keyboard.press("Escape");
  await phone.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Round tools");
  await phone.button("Film a throw").click();
  await phone.button("Record").waitFor();
  await phone.screenshot("film-phone");
  await phone.button("Close").click();
  await phone.button("Round tools").click();
  await phone.button("Open wrist layout").click();
  await phone.page.locator(".wrist-score").waitFor();
  await phone.screenshot("wrist-phone");
  await phone.button("Phone").click();

  async function selectFourth() {
    if (await phone.page.locator(".hole-head .hnum").textContent() !== "Hole 4")
      await phone.page.locator(".holegrid").getByRole("button", { name: /^Hole 4(?:,|$)/ }).click();
  }
  const score = phone.button("Enter score for Taylor Morgan on hole 4");
  await score.click();
  await phone.page.getByRole("dialog", { name: /Taylor Morgan/ }).waitFor();
  await phone.screenshot("score-keypad-phone");
  await phone.page.getByRole("dialog").getByRole("button", { name: "3", exact: true }).click();
  await score.locator(".n").getByText("3", { exact: true }).waitFor();
  await phone.page.waitForFunction(() => !document.querySelector('[aria-label="Card sync"]')?.textContent.includes("awaiting sync"));
  await phone.offlineMode(true);
  phone.lostReply();
  const increase = phone.button("Increase Taylor Morgan on hole 4");
  const stepper = await increase.boundingBox();
  assert.ok(stepper);
  for (let index = 0; index < 5; index++) await phone.page.mouse.click(stepper.x + stepper.width / 2, stepper.y + stepper.height / 2);
  await score.locator(".n").getByText("8", { exact: true }).waitFor({ timeout: 1200 });
  assert.equal(phone.writes().length, 0);
  await phone.screenshot("pending-score-phone");
  await phone.page.reload({ waitUntil: "domcontentloaded" });
  await phone.ready();
  await score.locator(".n").getByText("8", { exact: true }).waitFor();
  await phone.offlineMode(false);
  await phone.page.waitForFunction(() => !document.querySelector('[aria-label="Card sync"]')?.textContent.includes("awaiting sync"));
  assert.equal(phone.data[0].scores[4], 8);
  assert.equal(new Set(phone.writes().map((operation) => operation.order)).size, 5);
  assert.equal(phone.writes().length, 6);
  await phone.button("Next hole").click();
  assert.equal(await phone.page.locator(".hnum").textContent(), "Hole 5");
  await phone.button("Previous hole").click();
  assert.equal(await phone.page.locator(".hnum").textContent(), "Hole 4");
  await phone.button("Round tools").click();
  await phone.button("Full scorecard").click();
  await phone.page.getByRole("heading", { name: /Leaderboard|Scorecard/i }).waitFor();
  assert.equal(await phone.page.getByText(/All holes scored/).count(), 0);
  await phone.screenshot("full-scorecard-phone");
  await phone.page.keyboard.press("Escape");
  await phone.offlineMode(true);
  await increase.click();
  await score.locator(".n").getByText("9", { exact: true }).waitFor();
  phone.editElsewhere(0, 4, 7);
  await phone.offlineMode(false);
  await phone.page.getByText("1 change needs attention", { exact: true }).click();
  await phone.page.getByText(/edited on another device/).waitFor();
  await phone.screenshot("score-conflict-phone");
  await phone.button("Discard change").click();
  await phone.page.getByText("1 change needs attention", { exact: true }).waitFor({ state: "hidden" });
  await phone.page.reload({ waitUntil: "domcontentloaded" });
  await phone.ready();
  await selectFourth();
  await score.locator(".n").getByText("7", { exact: true }).waitFor();
  await phone.offlineMode(true);
  await increase.click();
  await score.locator(".n").getByText("8", { exact: true }).waitFor();
  const priorWrites = phone.writes().length;
  await phone.changeScope("qa-another-actor");
  await phone.go("?round=" + code);
  await phone.ready();
  await selectFourth();
  await score.locator(".n").getByText("7", { exact: true }).waitFor();
  assert.equal(phone.writes().length, priorWrites);
  await phone.changeScope(null);
  await phone.go("?round=ALT44");
  await phone.ready();
  await selectFourth();
  await score.locator(".n").getByText("7", { exact: true }).waitFor();
  assert.equal(phone.writes().length, priorWrites);
  await phone.go("?round=" + code);
  await phone.ready();
  await selectFourth();
  await score.locator(".n").getByText("8", { exact: true }).waitFor();
  await phone.page.waitForFunction(() => !document.querySelector('[aria-label="Card sync"]')?.textContent.includes("awaiting sync"));
  assert.equal(phone.writes().length, priorWrites + 1);
  await feedbackMetrics(phone);
  await phone.page.waitForFunction(() => !document.querySelector('[aria-label="Card sync"]')?.textContent.includes("awaiting sync"));
  await phone.noOverflow();
  await phone.context.close();

  const narrow = await makePage({ width: 320, height: 720, scale: 1.3, scheme: "dark", group: "doubles" });
  await narrow.go("?round=" + code);
  await narrow.ready();
  await narrow.page.getByText("Team 1", { exact: true }).first().waitFor();
  const geometry = await narrow.page.evaluate(() => {
    const header = document.querySelector(".topbar").getBoundingClientRect();
    const hole = document.querySelector(".hole-head").getBoundingClientRect();
    const next = document.querySelector('[aria-label="Next hole"]').getBoundingClientRect();
    return { y: scrollY, headerTop: header.top, headerBottom: header.bottom, holeTop: hole.top, nextBottom: next.bottom };
  });
  assert.equal(geometry.y, 0, "hole strip must not vertically scroll the document");
  assert.equal(geometry.headerTop, 0);
  assert.ok(geometry.holeTop >= geometry.headerBottom && geometry.nextBottom < 720, "header must not cover hole navigation");
  await narrow.screenshot("scorecard-320-large-dark");
  await narrow.button("Next hole").click();
  assert.equal(await narrow.page.locator(".hnum").textContent(), "Hole 5");
  await narrow.button("Previous hole").click();
  assert.equal(await narrow.page.locator(".hnum").textContent(), "Hole 4");
  for (const name of ["Round tools", "Next hole", "Increase Team 1 on hole 4", "Enter score for Team 2 on hole 4", "Lie 2"]) {
    const found = narrow.button(name);
    if (await found.count()) {
      const size = await found.boundingBox();
      assert.ok(size?.width >= 44 && size?.height >= 44, name + " has a 44px target");
    }
  }
  await narrow.button("Round tools").click();
  await narrow.button("Shot details").click();
  await narrow.button("Edit stroke 1").click();
  await narrow.page.getByLabel("Landing or resting lie").selectOption("rough");
  await narrow.screenshot("shot-editor-320-large-dark");
  await narrow.noOverflow();
  await narrow.context.close();

  const desktop = await makePage({ width: 1280, height: 900, scheme: "ocean", group: "doubles" });
  await desktop.go("?round=" + code);
  await desktop.ready();
  await desktop.page.locator("body.player-theme-active").waitFor();
  const personalized = await desktop.page.evaluate(() => ({
    paint: document.body.style.getPropertyValue("--bg-primary"),
    wallpaper: getComputedStyle(document.body).backgroundImage.includes("data:image/jpeg;base64,"),
  }));
  assert.equal(personalized.paint.trim(), customTheme.tokens["bg-primary"]);
  assert.equal(personalized.wallpaper, true);
  await desktop.screenshot("scorecard-desktop-custom");
  await desktop.button("Round tools").click();
  await desktop.screenshot("round-tools-desktop-custom");
  await desktop.noOverflow();
  await desktop.context.close();

  const final = await makePage({ width: 390, height: 844, complete: true });
  await final.go("?round=" + code);
  await final.ready();
  await final.button("Finish card").click();
  await final.page.getByRole("button", { name: /Looks good.*lock card/ }).click();
  await final.page.getByText(/scores are locked/).waitFor();
  assert.equal(await final.page.locator(".score-glove-dock .stepper .plus").first().isDisabled(), true);
  await final.screenshot("finished-scorecard-phone");
  await final.context.close();

  console.log("Scorer source passed layout, keyboard focus, rapid offline edits, lost acknowledgement, and final state QA.");
  console.log("Screenshots " + out);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
