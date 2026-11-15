import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";
import { buildTheme, contrastRatio } from "../../src/shared/dashboard-theme-model.js";
import { HOLE_MAP_COMPACT_SIZE, projectHoleMap } from "../../src/shared/hole-map-model.js";

const out = process.env.GVDG_SCORER_SCREENSHOTS || "/tmp/gvdg-scorer-polish";
await mkdir(out, { recursive: true });
const fontDir = process.env.GVDG_SCORE_FONT_DIR;
const serve = process.env.GVDG_SCORER_SERVE === "1";
const bottomPreview = process.env.GVDG_SCORER_BOTTOM === "1";
const headerPreview = process.env.GVDG_SCORER_HEADER_CONTRAST === "1";
const sampleCourse = bottomPreview || process.env.GVDG_SCORER_PREVIEW_DATA === "1";
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
      const players = Number(url.searchParams.get("players"));
      if (sampleCourse && (players === 1 || players === 4)) session.players = roster("singles", players);
      if (theme === "light" || theme === "dark" || theme === "ocean" || theme === "blue") session.appearance = theme;
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
const browser = serve ? null : await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const initials = { starts: { 1: 3, 2: 2, 3: 3 }, other: { 1: 4, 2: 3, 3: 4 } };
const place = sampleCourse ? { lat: 35.604686, lng: -77.576533 } : { lat: 34.95595, lng: -82.18772 };
const holes = Array.from({ length: sampleCourse ? 18 : 9 }, (_, index) => ({
  hole: index + 1, par: 3, distance_ft: 272 + index * 18,
  tee: { label: "Long", lat: place.lat + (index - 3) * 0.00022, lng: place.lng },
  target: { label: "Basket", lat: place.lat + (index - 3) * 0.00022 + 0.00056, lng: place.lng + 0.00055 },
  ...(sampleCourse && index === 3 ? { tee_sign_id: 4 } : {}),
}));
const course = { id: 100, name: sampleCourse ? "Farmville DiscGolfPark" : "Rocky Ford", ...place,
  location: sampleCourse ? "Farmville" : "Greenville", coverage: "full" };
const sampleWeather = {
  location: { ...place, label: course.name }, updatedAt: "2026-11-14T21:50:00.000Z",
  current: { condition: "Partly cloudy", weatherCode: 2, temperatureF: 57, windDirectionDeg: 292,
    windSpeedMph: 8, windGustMph: 13, relativeHumidity: 52, fetchedAt: "2026-11-14T21:50:00.000Z" },
};
const sampleLie = { lat: place.lat + .00028, lng: place.lng + .00024, n: 1 };
function heatmap(hole) {
  const tee = holes[Number(hole) - 1]?.tee || holes[3].tee;
  return { lies: Array.from({ length: 8 }, (_, index) => ({ lat: tee.lat + .00023 + index * .000009,
    lng: tee.lng + .0002 + (index % 3) * .000026, n: 1 })), you: [] };
}
const layout = { id: 101, name: sampleCourse ? "Blue tees" : "Long tees", course_id: 100, expected_holes: holes.length, holes };
const code = "GVDG44";
const roundId = "qa-visual-round-v1";
const edit = { kind: "throw", attempt: "throw", outcome: "missed", originLie: "tee", landingLie: "fairway",
  id: "10000000-0000-4000-8000-000000000001", recordedAt: Date.now(), distanceFt: 219, distanceSource: "manual" };

function roster(group, playerCount) {
  const names = group === "doubles" ? ["Taylor Morgan", "Avery Brooks", "Jordan Reyes", "Morgan Lee"]
    : ["Taylor Morgan", "Avery Brooks", "Jordan Reyes", "Morgan Lee"].slice(0, playerCount || 3);
  return names.map((name, index) => {
    const scores = { ...(index < (group === "doubles" ? 2 : 1) ? initials.starts : initials.other) };
    return {
      index, cardId: "c0", name, isMe: index === 0, canEnterScorecard: index === 0,
      startingHole: 4, scores, scorecards: Object.fromEntries(Object.entries(scores).map(([hole, strokes]) => [hole, { "player:0": strokes }])),
      throws: index === 0 ? { 4: [sampleLie] } : {},
    };
  });
}

const customTheme = buildTheme({ mode: "dark", preset: "Frost",
  wallpaper: "data:image/jpeg;base64," + (await readFile("img/slide4.jpg")).toString("base64") });
assert.ok(customTheme?.wallpaper);
// Sample member palette matched to the reference preview, without account information.
const bluePalette = ["#263b64", "#ee938c", "#86d695", "#e9c775", "#3c5c82", "#8999d4", "#7ec5da", "#deeffa",
  "#8ea4c1", "#f99d96", "#96f5a0", "#ffd997", "#6aa1d7", "#a9b4f1", "#a6e7ff", "#edfcff"];
const blueTheme = buildTheme({ mode: "dark", sourcePalette: bluePalette, palette: bluePalette });
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
      roundConfig: { groupFormat: "singles", scoringStyle: "stroke" }, startingHole: 4, weather: sampleWeather };
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
  if (path.endsWith("/live/sharing")) return reply({ owner: true, visibility: "public", includeMarked: true, clips: true });
  if (path.endsWith("/heatmap")) return reply(heatmap(url.searchParams.get("hole")));
  if (sampleCourse && path === "/tee-signs/4/image") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    return response.end(teeSign);
  }
  if (path.endsWith("/live/clips")) return reply({ clips: [] });
  if (path === "/me/dashboard-theme") return reply({ theme: state.appearance === "blue" ? blueTheme : state.appearance === "ocean" ? customTheme : null });
  if (path === "/me") return reply({ sub: "m_scorer_qa", name: players[0].name });
  if (path === "/courses") return reply({ courses: [course] });
  if (path === "/courses/100/layouts") return reply({ layouts: [layout] });
  if (path === "/rounds") return reply({ code });
  return reply({ rounds: [], events: [], devices: [], rows: [] });
}

const teeSign = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 390" role="img">
  <rect width="640" height="390" fill="#154136"/><rect x="28" y="26" width="584" height="338" rx="12" fill="#f2efdf"/>
  <text x="54" y="91" font-size="41" font-family="sans-serif" fill="#154136">Farmville · Sample sign</text>
  <path stroke="#35694b" stroke-width="15" fill="none" stroke-dasharray="13 14" d="M130 295 C183 217 292 243 433 145"/>
  <circle cx="433" cy="145" r="17" fill="#c76a32"/><rect x="102" y="286" width="42" height="14" fill="#154136"/>
  <text x="438" y="288" font-size="30" font-family="sans-serif" fill="#154136">Hole 4</text>
  <text x="438" y="326" font-size="24" font-family="sans-serif" fill="#154136">326 ft · Par 3</text>
  </svg>`;

async function makePage({ width, height, scheme = "light", scale = 1, group = "singles", locked = false, complete = false,
  playerCount, dashboardTheme, weather = sampleWeather, gps = true, scoringStyle = group === "doubles" ? "matchplay" : "stroke" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme === "light" ? "light" : "dark",
    permissions: gps ? ["geolocation", "camera", "microphone"] : ["camera", "microphone"],
    geolocation: gps ? { latitude: gps.lat ?? sampleLie.lat, longitude: gps.lng ?? sampleLie.lng, accuracy: 4 } : undefined,
    serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.setDefaultNavigationTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const players = roster(group, playerCount);
  const playedHoles = scoringStyle === "putting" ? holes.map((hole, index) => ({
    ...hole, par: 5, distance_ft: 18 + 2 * index, points: index >= 3 ? 2 : 1,
  })) : holes;
  if (complete) for (const player of players) for (const { hole } of playedHoles) {
    player.scores[hole] = 3;
    player.scorecards[hole] = { "player:0": 3 };
  }
  let finished = locked;
  const controls = group === "doubles" ? [[0, 1], [2, 3]] : players.map(({ index }) => [index]);
  const scoreTargets = controls.map((indexes, index) => group === "doubles"
    ? { id: "pair:team " + (index + 1), type: "pair", label: "Team " + (index + 1),
      playerIndexes: indexes, members: indexes.map((i) => players[i].name) }
    : { id: "player:" + index, type: "player", label: players[index].name, playerIndexes: indexes, members: [players[index].name] });
  const theme = dashboardTheme ?? (scheme === "blue" ? blueTheme : scheme === "ocean" ? customTheme : null);
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
      const scorecard = Object.entries(row.scores).map(([hole, strokes]) => ({ hole: Number(hole), strokes, par: playedHoles[Number(hole) - 1]?.par ?? 3 }));
      return { name: target.label, targetId: target.id, playerIndexes: target.playerIndexes, targetType: target.type, thru: scorecard.length,
        total: scorecard.reduce((sum, value) => sum + value.strokes, 0), toPar: scorecard.reduce((sum, value) => sum + value.strokes - value.par, 0), scorecard,
        ...(scoringStyle === "matchplay" ? { match: { status: target.id.endsWith("1") ? "1 UP" : "1 DN", outcome: target.id.endsWith("1") ? "leading" : "trailing" } } : {}) };
    });
    return { status: finished ? "final" : "live", cardLocked: finished, roundCode: code, courseId: course.id, layoutId: layout.id,
      courseName: course.name, layoutName: layout.name, recoveryRoundId: roundId, rev, holes: playedHoles, scoreTargets, standings,
      cardId: "c0", playerIndex: 0, players, cardmates: players, shotLedgers, conflicts: [], missing: [],
      roundConfig: { groupFormat: group, scoringStyle }, startingHole: 4, weather };
  }
  await context.routeWebSocket("ws://127.0.0.1:8788/**", () => {});
  await context.route(/^https?:\/\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === site) return route.continue();
    if (sampleCourse && url.hostname === "server.arcgisonline.com") {
      return url.searchParams.get("size") !== "320,180" ? route.continue() : route.abort();
    }
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
    if (path.endsWith("/live/sharing")) return reply({ owner: true, visibility: "public", includeMarked: true, clips: true });
    if (path.endsWith("/heatmap")) return reply(heatmap(url.searchParams.get("hole")));
    if (sampleCourse && path === "/tee-signs/4/image") return route.fulfill({ contentType: "image/svg+xml", body: teeSign, headers: allow });
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
    document.addEventListener("DOMContentLoaded", () => {
      if (scale !== 1) document.documentElement.style.fontSize = 16 * scale + "px";
    });
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

async function checkHeaderContrast(page, label, custom) {
  const header = page.locator("#scoreRoot .topbar");
  const colors = await header.evaluate((root) => {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const sample = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const background = sample(getComputedStyle(root).backgroundColor);
    const details = [...root.querySelectorAll("h1, h1 small, .top-link, .iconbtn")].filter((element) => element.getClientRects().length);
    return {
      background,
      themeBackground: sample(getComputedStyle(root).getPropertyValue("--bg-secondary").trim()),
      details: details.map((element) => {
        const style = getComputedStyle(element);
        const button = element.matches(".top-link, .iconbtn");
        const icon = element.querySelector("svg");
        return {
          name: element.getAttribute("aria-label") || (element.tagName === "SMALL" ? "Course and layout" : "Round title"),
          foreground: sample(icon ? getComputedStyle(icon).stroke : style.color),
          backdrop: button ? sample(style.backgroundColor) : background,
          focus: element.matches(":focus-visible") ? sample(style.outlineColor) : null,
          opacity: Number(style.opacity),
          minimum: button && !element.querySelector(".top-link-label") ? 3 : 4.5,
        };
      }),
    };
  });
  const rgb = ([r, g, b]) => ({ r, g, b });
  const blend = (upper, lower, opacity = 1) => {
    const weight = upper[3] / 255 * opacity;
    return lower.map((channel, index) => Math.round(channel + (upper[index] - channel) * weight));
  };
  if (custom) assert.deepEqual(colors.background, colors.themeBackground, label + " keeps the chosen header surface");
  assert.equal(colors.background[3], 255, label + " uses an opaque header");
  assert.equal(colors.details.length, 6, label + " has a title, course and four visible actions");
  for (const item of colors.details) {
    const background = blend(item.backdrop, colors.background);
    const ratio = contrastRatio(rgb(blend(item.foreground, background, item.opacity)), rgb(background));
    assert.ok(ratio >= item.minimum, `${label} / ${item.name} contrast ${ratio.toFixed(2)} below ${item.minimum}:1`);
    if (item.focus) assert.ok(contrastRatio(rgb(item.focus), rgb(background)) >= 3, label + " / " + item.name + " focus ring contrast");
  }
}

if (serve) {
  console.log("Preview scorecard " + site + "/score.html?round=" + code);
  console.log("Preview dark theme " + site + "/score.html?round=" + code + "&appearance=dark");
  await new Promise((stop) => { process.once("SIGINT", stop); process.once("SIGTERM", stop); });
  await new Promise((done) => server.close(done));
} else if (headerPreview) {
  const lightTheme = buildTheme({ mode: "light", preset: "Frost",
    wallpaper: "data:image/jpeg;base64," + (await readFile("img/slide4.jpg")).toString("base64") });
  try {
    for (const [width, height, scale] of [[390, 844, 1], [320, 720, 1.25], [1280, 900, 1]]) {
      for (const [name, scheme, dashboardTheme] of [
        ["custom-light", "light", lightTheme], ["custom-dark", "dark", blueTheme],
        ["default-light", "light", null], ["default-dark", "dark", null],
      ]) {
        const sample = await makePage({ width, height, scale, scheme, dashboardTheme, playerCount: 1 });
        await sample.go("?round=" + code);
        await sample.ready();
        const label = width + "-" + name;
        await sample.screenshot("score-header-" + label);
        await checkHeaderContrast(sample.page, label, dashboardTheme !== null);
        await sample.page.getByRole("region", { name: "Round weather" }).getByText(/Wind WNW 8 mph/).waitFor();
        const footer = sample.page.getByRole("navigation", { name: "Hole navigation" });
        await footer.getByRole("button", { name: "Next hole" }).waitFor();
        const { y, height: footerHeight } = await footer.boundingBox();
        assert.ok(y + footerHeight >= height - 60 && y + footerHeight <= height, "Hole navigation stays at the bottom");
        const help = sample.button("Help");
        await help.hover();
        await checkHeaderContrast(sample.page, label + "-hover", dashboardTheme !== null);
        await sample.page.keyboard.press("Tab");
        await help.focus();
        assert.equal(await help.evaluate((element) => element.matches(":focus-visible")), true);
        await checkHeaderContrast(sample.page, label + "-keyboard-focus", dashboardTheme !== null);
        if (width === 390 && name === "custom-light") {
          await sample.button("Switch to dark mode").click();
          await sample.button("Switch to light mode").waitFor();
          await checkHeaderContrast(sample.page, label + "-toggled-dark", true);
          await sample.button("Switch to light mode").click();
          await sample.button("Switch to dark mode").waitFor();
          await checkHeaderContrast(sample.page, label + "-toggled-light", true);
        }
        await sample.noOverflow();
        await sample.context.close();
      }
    }
    console.log("Scorecard header contrast passed for 12 layouts and both custom theme toggle directions.");
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
} else if (bottomPreview) {
  try {
    for (const [playerCount, width, height, scheme, scale] of [
      [1, 390, 844, "blue"], [4, 390, 844, "blue"], [1, 390, 844, "light"], [4, 390, 844, "light"], [2, 390, 720, "blue"], [3, 320, 844, "dark"],
      [4, 320, 720, "dark", 1.25], [4, 320, 568, "dark", 1.25], [4, 844, 390, "blue"], [4, 1280, 900, "ocean", 1],
    ]) {
      const preview = await makePage({ width, height, scheme, scale, playerCount });
      await preview.go("?round=" + code);
      await preview.ready();
      const weather = preview.page.getByRole("region", { name: "Round weather" });
      await weather.getByText("Partly cloudy", { exact: true }).waitFor();
      await weather.getByText("Wind WNW 8 mph", { exact: true }).waitFor();
      await weather.getByText("Gusts 13 mph", { exact: true }).waitFor();
      const stage = preview.page.locator(".score-glove-stage");
      const frame = stage.locator(".hole-map-frame");
      await frame.getByRole("button", { name: "Heat" }).waitFor();
      await frame.locator(".hole-map-satellite").evaluate((image) => image.decode());
      const outcomes = stage.getByRole("region", { name: "Scoring outcomes" });
      assert.deepEqual(await outcomes.locator(".live-stats-k").allTextContents(), ["Ace", "Eagle", "Birdie", "Par", "Bogey", "Double+"]);
      assert.deepEqual(await outcomes.locator("b").allTextContents(), ["0", "0", "1", "2", "0", "0"]);
      const suffix = scheme ? "-" + scheme : "-light";
      const file = "bottom-scorecard-" + width + "x" + height + "-" + playerCount + "p" + suffix;
      const geometry = await preview.page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const nav = [...document.querySelectorAll('[aria-label="Previous hole"], [aria-label="Next hole"]')];
        const scores = [...document.querySelectorAll(".score-glove-dock .stepper .plus")];
        const scroller = document.querySelector(".score-glove-scores").getBoundingClientRect();
        const frame = document.querySelector(".hole-map-frame");
        const frameBounds = frame.getBoundingClientRect();
        const stage = document.querySelector(".score-glove-stage");
        const tally = document.querySelector(".score-outcomes");
        const tallyBounds = tally.getBoundingClientRect();
        const photo = frame.querySelector(".hole-map-satellite");
        const { width, height } = frame.querySelector("svg[aria-label]").viewBox.baseVal;
        return {
          height: innerHeight, scroll: scrollY, dockTop: rect(".score-glove-dock").top,
          buttons: nav.map((button) => ({
            docked: Boolean(button.closest(".score-glove-dock")), height: button.offsetHeight, width: button.offsetWidth,
            bottom: button.getBoundingClientRect().bottom,
          })),
          scoreButtons: scores.map((button) => {
            const { top, bottom } = button.getBoundingClientRect();
            return { visible: top >= scroller.top && bottom <= scroller.bottom, height: button.offsetHeight, width: button.offsetWidth };
          }),
          mapHeight: frame.clientHeight,
          frameWidth: frame.clientWidth,
          mapDims: { width, height, photoWidth: photo.naturalWidth, photoHeight: photo.naturalHeight, objectFit: getComputedStyle(photo).objectFit },
          stageFit: stage.scrollHeight <= stage.clientHeight + 1 && !["auto", "scroll"].includes(getComputedStyle(stage).overflowY),
          mapEndsAtTally: frameBounds.bottom <= tallyBounds.top && tallyBounds.top - frameBounds.bottom < 6,
          tallyVisible: tallyBounds.top >= 0 && tallyBounds.bottom <= innerHeight
            && [...tally.querySelectorAll(".live-stats-k")].every((label) => label.clientWidth >= label.scrollWidth),
          onMap: [...frame.querySelectorAll("button")].map((button) => {
            const { left, right, top, bottom, width, height } = button.getBoundingClientRect();
            return { label: button.textContent, width, height,
              tappable: button.contains(document.elementFromPoint(left + width / 2, top + height / 2)),
              within: left >= frameBounds.left && right <= frameBounds.right && top >= frameBounds.top && bottom <= frameBounds.bottom };
          }),
          weatherAboveMap: rect(".scorecard-weather").bottom <= frame.getBoundingClientRect().top,
        };
      });
      assert.equal(geometry.scroll, 0);
      assert.equal(geometry.buttons.length, 2);
      for (const button of geometry.buttons) {
        assert.equal(button.docked, true);
        assert.ok(button.width >= 44 && button.height >= 44);
        assert.ok(button.bottom <= geometry.height && button.bottom >= geometry.height - 60, "Hole navigation stays at the viewport bottom");
      }
      if (width === 390 && height >= 720) {
        assert.ok(geometry.dockTop >= height * .55, "Scores are in the lower half of the phone");
        assert.equal(geometry.scoreButtons.filter((button) => button.visible && button.width >= 44 && button.height >= 44).length, playerCount);
        assert.ok(geometry.mapHeight >= (playerCount === 1 ? 320 : 240));
      }
      assert.equal(geometry.weatherAboveMap, true);
      assert.ok(geometry.stageFit && geometry.mapEndsAtTally && geometry.tallyVisible, JSON.stringify(geometry));
      assert.ok(geometry.mapHeight >= 130, JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.mapDims.width - geometry.frameWidth) <= 1);
      assert.ok(Math.abs(geometry.mapDims.height - geometry.mapHeight) <= 1);
      assert.equal(geometry.mapDims.width, geometry.mapDims.photoWidth);
      assert.equal(geometry.mapDims.height, geometry.mapDims.photoHeight);
      assert.equal(geometry.mapDims.objectFit, "contain");
      const hud = frame.locator(".hole-range-hud");
      assert.match(await hud.innerText(), /137 ft\s+to basket\s+125 ft throw 1/i);
      assert.doesNotMatch(await hud.innerText(), /326 ft/);
      assert.match(await preview.page.getByRole("navigation", { name: "Hole navigation" }).innerText(), /326 ft/);
      const hudRect = await hud.boundingBox();
      const markRect = await frame.getByRole("button", { name: "Mark lie" }).boundingBox();
      assert.ok(hudRect.width <= hudRect.height * 1.7, "Distance badge hugs the readable values");
      assert.ok(hudRect.x + hudRect.width < markRect.x, "Distance badge stays clear of Mark lie");
      for (const label of ["Hole", "C2", "C1", "Heat", "Tee sign", "Mark lie", "Undo"]) {
        assert.ok(geometry.onMap.some((button) => button.label === label && button.width >= 44 && button.height >= 44 && button.within && button.tappable),
          `${label} must be fully inside the map with a 44px hit target. ${JSON.stringify(geometry.onMap)}`);
      }
      assert.match(await stage.locator(".hole-map-frame .hole-map-credit").innerText(), /Imagery: Esri, Maxar, Earthstar Geographics/);
      assert.equal(await stage.locator(".hole-map-card > .hole-map-credit").count(), 0);
      assert.equal(await stage.getByRole("button", { name: "Mark tee", exact: true }).count(), 0);
      assert.equal(await stage.getByRole("button", { name: "Mark pin", exact: true }).count(), 0);
      for (const target of [preview.page.locator(".round-quick-tools button").first(), ...[
        "Share watch link", "Round tools", "Mark lie", "Tee sign", "Undo",
      ].map(preview.button)]) {
        const size = await target.boundingBox();
        assert.ok(size && size.height >= 44 && size.width >= 44);
      }
      await preview.screenshot(file);
      if (width === 320 && playerCount === 4) {
        if (height >= 720) assert.equal(geometry.scoreButtons.filter(({ visible }) => visible).length, playerCount, "All four scorers fit in the narrow tray");
        else assert.ok(geometry.scoreButtons.some(({ visible }) => !visible), "The shortest viewport reserves map space by scrolling the player tray");
        const name = preview.page.locator(".prow .pname").first();
        assert.equal(await name.locator(".score-name-given").innerText(), "Taylor");
        assert.equal(await name.locator(".score-name-surname").innerText(), "Morgan");
        assert.equal(await name.getAttribute("title"), "Taylor Morgan");
        const finalPlayer = preview.button("Increase Morgan Lee on hole 4");
        const initialNav = await preview.button("Next hole").boundingBox();
        await finalPlayer.scrollIntoViewIfNeeded();
        const scores = await preview.page.getByRole("region", { name: "Player scores" }).boundingBox();
        const player = await finalPlayer.boundingBox();
        assert.ok(player.y >= scores.y - 1 && player.y + player.height <= scores.y + scores.height + 1, "Final score row can scroll fully into view");
        await finalPlayer.click();
        await preview.page.locator(".score-entry-card .prow").last().locator(".val .n").getByText("3", { exact: true }).waitFor();
        const mark = preview.button("Mark lie");
        const stageBounds = await stage.boundingBox();
        const markBounds = await mark.boundingBox();
        assert.ok(markBounds.y + markBounds.height <= stageBounds.y + stageBounds.height, "Mark lie is fully visible without a map scroll");
        assert.deepEqual(await preview.button("Next hole").boundingBox(), initialNav);
      }
      if (width === 320 && height === 568) {
        const sync = preview.page.getByRole("region", { name: "Card sync" });
        await sync.waitFor({ state: "hidden" });
        await preview.offlineMode(true);
        await preview.button("Increase Morgan Lee on hole 4").click();
        await sync.getByText("1 change awaiting sync", { exact: true }).waitFor();
        preview.editElsewhere(3, 4, 7);
        await preview.offlineMode(false);
        await sync.getByText("1 change needs attention", { exact: true }).waitFor();
        assert.equal(await frame.evaluate((element) => [...element.querySelectorAll("button")].every((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return [.28, .5, .72].every((position) =>
            button.contains(document.elementFromPoint(x + width / 2, y + height * position)));
        })), true, "Map controls remain tappable during a sync conflict");
        assert.deepEqual(await outcomes.locator(".live-stats-k").allTextContents(), ["Ace", "Eagle", "Birdie", "Par", "Bogey", "Double+"]);
        await frame.locator(".hole-map-satellite").evaluate((image) => image.decode());
        await preview.screenshot(file + "-conflict");
        await sync.getByRole("button", { name: "1 change needs attention" }).click();
        const recovery = preview.page.getByRole("dialog", { name: "Card sync" });
        await recovery.getByText(/edited on another device/).waitFor();
        await recovery.getByRole("button", { name: "Retry sync" }).waitFor();
        await preview.screenshot(file + "-recovery");
        await recovery.getByRole("button", { name: "Discard change" }).click();
        await sync.waitFor({ state: "hidden" });
        await preview.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Player scores");
      }
      if (width === 390 && playerCount === 4 && scheme === "light") {
        await preview.button("Increase Taylor Morgan on hole 4").click();
        await preview.page.locator(".score-entry-card .prow").first().locator(".val .n").getByText("3", { exact: true }).waitFor();
        const score = preview.button("Enter score for Taylor Morgan on hole 4");
        await score.click();
        const keypad = preview.page.locator(".score-pad-sheet");
        await keypad.waitFor();
        await keypad.getByRole("heading").focus();
        await preview.page.keyboard.press("Shift+Tab");
        assert.equal(await keypad.evaluate((sheet) => sheet.contains(document.activeElement)), true);
        await preview.page.keyboard.press("Escape");
        assert.equal(await score.evaluate((button) => document.activeElement === button), true);
        await preview.button("Share watch link").click();
        await preview.page.getByRole("dialog", { name: "Share watch link" }).getByRole("button", { name: "Copy watch link" }).waitFor();
        await preview.page.keyboard.press("Escape");
        await preview.button("Round tools").click();
        const tools = preview.page.getByRole("dialog", { name: "Round tools" });
        for (const label of ["Mark tee", "Mark pin", "Shot details", "Invite to score", "Measure"]) await tools.getByRole("button", { name: label, exact: true }).waitFor();
        const originalMap = await frame.boundingBox();
        async function assertMapInPlace() {
          const current = await frame.boundingBox();
          for (const side of ["x", "y", "width", "height"]) {
            assert.ok(Math.abs(current[side] - originalMap[side]) <= 1, "Round details and map controls leave the map in place");
          }
        }
        await tools.getByRole("button", { name: "Round details", exact: true }).click();
        const details = preview.page.getByRole("dialog", { name: "Round details" });
        await details.getByRole("region", { name: "Live round stats" }).getByText("Singles · Stroke · Thru 4/18", { exact: true }).waitFor();
        await details.getByRole("button", { name: /^Hole 6(?:,|$)/ }).click();
        await preview.page.getByRole("heading", { name: "Hole 6" }).waitFor();
        await preview.button("Previous hole").click();
        await preview.button("Previous hole").click();
        await preview.page.getByRole("heading", { name: "Hole 4" }).waitFor();
        await preview.button("Tee sign").click();
        await preview.page.getByRole("dialog", { name: "Tee sign · Hole 4" }).getByAltText("Tee sign for hole 4").waitFor();
        await preview.page.keyboard.press("Escape");
        assert.equal(await preview.button("Tee sign").evaluate((button) => button === document.activeElement), true);
        await assertMapInPlace();
        const focus = frame.getByRole("group", { name: "Map overlay" });
        for (const label of ["C1", "C2", "Hole"]) {
          await focus.getByRole("button", { name: label, exact: true }).click();
          assert.equal(await focus.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"), "true");
        }
        const heat = focus.getByRole("button", { name: "Heat" });
        await heat.click();
        assert.equal(await heat.getAttribute("aria-pressed"), "false");
        await heat.click();
        assert.equal(await heat.getAttribute("aria-pressed"), "true");
        await frame.getByRole("button", { name: "Undo" }).click();
        await frame.getByRole("button", { name: "Undo" }).waitFor({ state: "detached" });
        await frame.getByRole("button", { name: "Mark lie" }).click();
        await frame.getByRole("button", { name: "Undo" }).waitFor();
        assert.deepEqual(await outcomes.locator("b").allTextContents(), ["0", "0", "1", "3", "0", "0"]);
        await preview.button("Next hole").click();
        await preview.page.getByRole("heading", { name: "Hole 5" }).waitFor();
        await preview.button("Previous hole").click();
        await preview.page.getByRole("heading", { name: "Hole 4" }).waitFor();
        await weather.getByText("Wind WNW 8 mph", { exact: true }).waitFor();
        await stage.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        assert.equal(await stage.evaluate((el) => el.scrollTop), 0, "The map stage never scrolls");
        await assertMapInPlace();
        await preview.button("Round tools").click();
        await preview.button("Add player").click();
        const input = preview.page.getByRole("textbox", { name: "Player name" });
        await input.focus();
        await preview.page.evaluate(() => {
          Object.defineProperty(visualViewport, "height", { configurable: true, value: innerHeight - 240 });
          visualViewport.dispatchEvent(new Event("resize"));
        });
        assert.equal(await preview.page.evaluate(() => document.documentElement.style.getPropertyValue("--score-nav-bottom")), "240px");
        const dialog = await preview.page.getByRole("dialog", { name: "Add player" }).boundingBox();
        const navigation = await preview.page.locator(".score-bottom-layout .hole-head").boundingBox();
        assert.ok(dialog.y + dialog.height <= height - 240, "Focused text form sits above the simulated viewport inset");
        assert.ok(navigation.y + navigation.height <= height - 240, "The footer sits above the simulated viewport inset");
        assert.equal(await input.evaluate((element) => document.activeElement === element), true);
        await input.fill("Sample walk-on");
        await preview.page.keyboard.press("Escape");
        await preview.page.evaluate(() => {
          delete visualViewport.height;
          visualViewport.dispatchEvent(new Event("resize"));
        });
      }
      if (width === 390 && height === 844 && playerCount === 1 && scheme === "blue") {
        const legacy = projectHoleMap(holes[3], HOLE_MAP_COMPACT_SIZE);
        await preview.page.evaluate(async (url) => {
          const cache = await caches.open("gvdg-maps-v2");
          await cache.put(url, new Response('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>', {
            headers: { "Content-Type": "image/svg+xml" },
          }));
        }, legacy.satelliteUrl);
        await preview.context.route("https://server.arcgisonline.com/**", (route) => route.abort("internetdisconnected"));
        await preview.page.setViewportSize({ width: 320, height: 720 });
        const fallback = frame.locator(".hole-map-satellite-backdrop");
        await fallback.evaluate((image) => image.decode());
        const placement = await fallback.evaluate((image) => {
          const fit = image.closest(".hole-map-frame").getBoundingClientRect();
          const rect = image.getBoundingClientRect();
          return {
            fitWidth: fit.width, fitHeight: fit.height, width: rect.width, height: rect.height,
            offsetX: rect.x - fit.x, offsetY: rect.y - fit.y,
          };
        });
        assert.ok(Math.abs(placement.width / placement.height - 320 / 180) < .02, "The cached aerial retains its source ratio");
        assert.ok(Math.abs(placement.offsetX - (placement.fitWidth - placement.width) / 2) < 1);
        assert.ok(Math.abs(placement.offsetY - (placement.fitHeight - placement.height) / 2) < 1);
        await preview.page.setViewportSize({ width, height });
      }
      await preview.noOverflow();
      await preview.context.close();
    }
    async function stageConflict(fixture) {
      await fixture.go("?round=" + code);
      await fixture.ready();
      await fixture.offlineMode(true);
      await fixture.button("Increase Taylor Morgan on hole 4").click();
      const sync = fixture.page.getByRole("region", { name: "Card sync" });
      await sync.getByText("1 change awaiting sync", { exact: true }).waitFor();
      fixture.editElsewhere(0, 4, 7);
      await fixture.offlineMode(false);
      await sync.getByText("1 change needs attention", { exact: true }).waitFor();
    }
    async function checkShortMap(page) {
      const frame = page.locator(".score-glove-stage .hole-map-frame");
      assert.ok(await frame.evaluate((element) => [...element.querySelectorAll("button")].every((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return width >= 44 && height >= 44
          && button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      })), "Short-map controls are reachable with touch");
      assert.ok(await frame.evaluate((element) => {
        const badge = element.querySelector(".hole-range-hud").getBoundingClientRect();
        return [...element.querySelectorAll(".hole-map-options button")].every((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const text = range.getBoundingClientRect();
          return badge.right <= text.left || badge.left >= text.right || badge.top >= text.bottom;
        });
      }), "Distance badge does not paint over the map control labels");
    }
    const nearBasket = await makePage({ width: 320, height: 540, scale: 1.25, playerCount: 4,
      gps: { lat: holes[3].target.lat - .00002, lng: holes[3].target.lng } });
    await stageConflict(nearBasket);
    await nearBasket.page.locator(".hole-range-hud.in-c1 .hole-range-hud-next").getByText(/next tee/).waitFor();
    await nearBasket.page.locator(".hole-range-hud-throw").getByText(/throw 1/).waitFor();
    await checkShortMap(nearBasket.page);
    await nearBasket.context.close();

    const noFix = await makePage({ width: 320, height: 540, scale: 1.25, playerCount: 4, gps: false });
    await stageConflict(noFix);
    const nav = noFix.page.getByRole("navigation", { name: "Hole navigation" });
    await noFix.button("Next hole").click();
    await nav.getByRole("heading", { name: "Hole 5" }).waitFor();
    const enableGps = noFix.page.getByRole("button", { name: /GPS/ });
    const gpsRect = await enableGps.boundingBox();
    assert.ok(gpsRect && gpsRect.width >= 44 && gpsRect.height >= 44, "GPS badge has a full tap target");
    assert.doesNotMatch(await enableGps.innerText(), /\d+ ft/, "The GPS badge omits the footer's hole length");
    await checkShortMap(noFix.page);

    const scores = noFix.page.getByRole("region", { name: "Player scores" });
    const missing = noFix.button("Hole 4 needs a score");
    await scores.getByRole("button", { name: "Hole 4 needs a score" }).waitFor();
    assert.equal(await missing.count(), 1, "There is one finish reminder");
    await noFix.page.setViewportSize({ width: 320, height: 568 });
    await noFix.page.locator(".score-glove-dock > .score-glove-finish").waitFor();
    await noFix.page.setViewportSize({ width: 320, height: 540 });
    await scores.getByRole("button", { name: "Hole 4 needs a score" }).waitFor();
    await missing.click();
    await nav.getByRole("heading", { name: "Hole 4" }).waitFor();
    assert.equal(await scores.evaluate((region) => region.scrollTop === 0 && document.activeElement === region), true);
    await noFix.button("Next hole").click();
    await scores.getByRole("button", { name: "Dismiss" }).click();
    await missing.waitFor({ state: "hidden" });
    await noFix.page.setViewportSize({ width: 320, height: 568 });
    await nav.getByRole("heading", { name: "Hole 5" }).waitFor();
    assert.equal(await missing.count(), 0, "Resizing does not restore a dismissed reminder");
    await noFix.context.close();
    console.log("Bottom-dock scorer previews with sample weather and aerial imagery " + out);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
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
  const holeFooter = phone.page.getByRole("navigation", { name: "Hole navigation" });
  assert.equal(await holeFooter.getByRole("heading").textContent(), "Hole 4");
  assert.equal(await holeFooter.evaluate((heading) => Boolean(heading.closest(".score-glove-dock"))), true);
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
    if (await phone.page.locator(".hole-head .hnum").textContent() !== "Hole 4") {
      await phone.button("Round tools").click();
      await phone.button("Round details").click();
      await phone.page.locator(".holegrid").getByRole("button", { name: /^Hole 4(?:,|$)/ }).click();
    }
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
  await phone.page.getByRole("region", { name: "Card sync", exact: true }).waitFor({ state: "hidden" });
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
  assert.ok(geometry.holeTop >= geometry.headerBottom && geometry.nextBottom <= 720 && geometry.nextBottom >= 660, "hole navigation remains at the bottom");
  assert.equal(await narrow.page.locator(".prow .score-name-compact").count(), 0, "Doubles team labels stay whole");
  const teamScoreSaved = narrow.page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/live/score") && response.ok());
  await narrow.button("Increase Team 1 on hole 4").click();
  await teamScoreSaved;
  await narrow.page.waitForFunction(() => !document.querySelector('[aria-label="Card sync"]')?.textContent.includes("awaiting sync"));
  assert.equal(narrow.data[0].scores[4], 3);
  assert.equal(narrow.data[1].scores[4], 3);
  assert.match(await narrow.page.locator(".hole-head .pmeta").textContent(), /Match:/);
  await narrow.screenshot("scorecard-320-large-dark");
  await narrow.button("Next hole").click();
  assert.equal(await narrow.page.locator(".hnum").textContent(), "Hole 5");
  await narrow.button("Previous hole").click();
  assert.equal(await narrow.page.locator(".hnum").textContent(), "Hole 4");
  for (const name of ["Round tools", "Next hole", "Increase Team 1 on hole 4", "Enter score for Team 2 on hole 4", "Mark lie"]) {
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

  const putting = await makePage({ width: 390, height: 600, playerCount: 4, scoringStyle: "putting" });
  await putting.go("?round=" + code);
  await putting.ready();
  await putting.page.getByRole("region", { name: "Round weather" }).getByText(/Wind WNW 8 mph/).waitFor();
  assert.equal(await putting.page.locator(".hole-map-frame").count(), 0);
  const makes = putting.button("Enter score for Taylor Morgan on hole 4");
  await makes.click();
  await putting.page.getByRole("dialog").getByRole("button", { name: "2", exact: true }).click();
  await makes.locator(".n").getByText("2", { exact: true }).waitFor();
  const puttNav = await putting.button("Next hole").boundingBox();
  assert.ok(puttNav.y + puttNav.height <= 600 && puttNav.y + puttNav.height >= 550);
  await putting.button("Next hole").click();
  await putting.page.getByRole("navigation", { name: "Hole navigation" }).getByRole("heading", { name: "26 ft" }).waitFor();
  await putting.button("Previous hole").click();
  await makes.locator(".n").getByText("2", { exact: true }).waitFor();
  await putting.screenshot("putting-short-phone");
  await putting.noOverflow();
  await putting.context.close();

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
  await desktop.page.keyboard.press("Escape");
  await desktop.page.getByRole("dialog", { name: "Round tools" }).waitFor({ state: "hidden" });
  await desktop.button("Switch to light mode").click();
  await desktop.button("Switch to dark mode").waitFor();
  await checkHeaderContrast(desktop.page, "default QA / custom light after a theme toggle", true);
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
