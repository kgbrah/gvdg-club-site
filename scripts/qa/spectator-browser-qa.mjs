import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const code = "SAFE44";
const key = "7b".repeat(24);
const scope = "river-scorecard";
const token = "qa-card-owner";
const targetUrl = "/score.html?watch=1#wl=" + key;
const startedAt = new Date(Date.now() - 90_000).toISOString();
const holes = [1, 2, 3].map((hole) => ({
  hole, par: 3, distance_ft: 295 + hole * 11,
  tee: { lat: 35.6307 + hole * 0.0002, lng: -77.3198 },
  target: { lat: 35.6312 + hole * 0.0002, lng: -77.3191 },
}));
const players = ["Avery Brooks", "Jordan Reyes"].map((name, index) => ({
  name, index, cardId: "c0", scores: { 1: index + 2 }, scorecards: {}, isMe: index === 0, canEnterScorecard: index === 0,
  throws: { 1: [{ lat: 35.6311, lng: -77.31945, n: 1 }], 2: [{ lat: 35.6313, lng: -77.31935, n: 1 }] },
}));
const standings = players.map(({ index, name, scores }) => ({
  name, playerIndexes: [index], targetType: "player", targetId: "p" + index, thru: 1, total: scores[1], toPar: scores[1] - 3,
  scorecard: [{ hole: 1, par: 3, strokes: scores[1] }],
}));
const clip = {
  id: 1, playerName: players[0].name, playerIndex: 0, hole: 1, highlight: true, moment: "birdie",
  generation: scope, visibility: "private", mediaPath: "/rounds/" + code + "/live/clips/1/media",
};
const snapshot = {
  status: "live", recoveryRoundId: scope, updatedAt: startedAt, rev: 1, courseName: "River Park", layoutName: "Blue tees",
  layoutId: 1, courseId: 1, holes, players, standings, scoreTargets: players.map(({ index, name }) => ({ id: "p" + index, type: "player", label: name, members: [name], playerIndexes: [index] })),
};
let visibility, includeMarked, clipVisibility, revoked, rev, final, movie, failedClip;
function reset() { visibility = "card"; includeMarked = false; clipVisibility = "private"; revoked = false; rev = 1; final = false; failedClip = false; }

const imageDir = process.env.GVDG_SPECTATOR_SCREENSHOTS;
if (imageDir) await mkdir(imageDir, { recursive: true });
process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const vite = await createServer({
  configFile: false, cacheDir: "/tmp/gvdg-spectator-browser-qa",
  server: { host: "127.0.0.1", hmr: false }, optimizeDeps: { entries: ["src/score-app/main.js"] },
  plugins: [{ name: "spectator-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/score.html") return next();
      const html = (await readFile("score.html", "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
        .replace('data-api-base=""', 'data-api-base="' + url.origin.replace("localhost", request.headers.host) + '/fixture"')
        .replace(/src="score-app\/score-app.js[^"]+"/, 'src="/src/score-app/main.js"');
      response.setHeader("Content-Type", "text/html");
      response.end(await server.transformIndexHtml(request.url, html));
    });
  }}],
});

await vite.listen(0);
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ["--no-sandbox"] });

async function pageFor(context, errors, ws) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  if (process.env.GVDG_SPECTATOR_DEBUG) page.on("console", (message) => console.log(message.type(), message.text()));
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/fixture/")) return route.continue();
    const path = url.pathname.slice("/fixture".length);
    const request = route.request();
    const authorization = await request.headerValue("authorization");
    const owner = authorization === "Bearer " + token;
    const watch = !revoked && visibility === "link" && (authorization === "Watch " + key || url.searchParams.get("wl") === key);
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path.endsWith("/live/mine") && owner) return reply({ ...snapshot, cardId: "c0", playerIndex: 0, cardmates: players });
    if (path.endsWith("/live/sharing") && owner) {
      if (request.method() === "PUT") {
        ({ visibility, includeMarked } = request.postDataJSON());
        revoked = visibility !== "link";
        return reply({ owner: true, visibility, includeMarked, ...(visibility === "link" ? { watchKey: key } : {}) });
      }
      return reply({ owner: true, visibility, includeMarked });
    }
    if (path === "/watch-round" || path === "/watch-round/results") {
      return watch ? reply({ ...snapshot, rev, status: final ? "final" : "live", observedAt: Date.now() }) : reply({}, 404);
    }
    if (path.endsWith("/messages")) return reply({ open: true, messages: [] });
    if (path.endsWith("/clips/1/visibility") && owner) {
      clipVisibility = request.postDataJSON().visibility;
      return reply({ id: 1, visibility: clipVisibility });
    }
    if (path.endsWith("/clips")) {
      const visible = owner || (watch && clipVisibility === "round");
      return reply({ clips: visible ? [{ ...clip, visibility: clipVisibility, canManage: owner, requiresAuth: clipVisibility === "private", mediaPath: owner ? clip.mediaPath : "/watch-round/clips/1/media" }] : [] });
    }
    if (path.endsWith("/clips/1/media")) {
      if ((!owner && !watch) || (owner && !failedClip)) {
        failedClip = true;
        return route.fulfill({ status: 403, body: "fixture denied byte request" });
      }
      return route.fulfill({ status: 200, contentType: "video/webm", body: movie });
    }
    if (path === "/me") return reply({ name: players[0].name, sub: "qa-owner" });
    if (path.startsWith("/layouts/")) return reply({ hole: 1, drives: [], lies: [], you: [] });
    if (path.startsWith("/courses/")) return reply({ layouts: [], positions: [] });
    return reply({});
  });
  await page.routeWebSocket("**/fixture/**", (socket) => {
    socket.onMessage((message) => { if (message === "ping") socket.send(JSON.stringify({ type: "pong" })); });
    if (socket.url().includes("/watch-round/ws")) {
      ws.push(socket);
      socket.send(JSON.stringify({ type: "snapshot", ...snapshot, rev, observedAt: Date.now() }));
    }
  });
  return page;
}

try {
  for (const [size, options] of [["desktop", { viewport: { width: 1320, height: 920 } }],
    ["mobile", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }]]) {
    const errors = [];
    const ws = [];
    reset();
    const ownerContext = await browser.newContext({ ...options, permissions: ["clipboard-read", "clipboard-write"], serviceWorkers: "block" });
    await ownerContext.addInitScript((session) => localStorage.setItem("gvdg_member_token", session), token);
    const owner = await pageFor(ownerContext, errors, ws);
    await owner.goto(origin + "/score.html?round=" + code, { waitUntil: "commit", timeout: 60_000 });
    await owner.getByRole("button", { name: "Round tools", exact: true }).click({ timeout: 60_000 });
    await owner.getByRole("button", { name: "Invite to score", exact: true }).first().waitFor();
    await owner.getByText("Share watch link", { exact: true }).click();
    const audience = owner.getByLabel("Who can watch");
    assert.equal(await audience.inputValue(), "card");
    await audience.selectOption("link");
    await owner.getByLabel("Include marked lies").check();
    await owner.getByRole("button", { name: "Create watch link" }).click();
    await owner.getByText("Watch link ready to copy.").waitFor();
    await owner.getByRole("button", { name: "Copy watch link" }).click();
    assert.equal(await owner.evaluate(() => navigator.clipboard.readText()), origin + targetUrl);
    if (imageDir) await owner.screenshot({ path: join(imageDir, "watch-sharing-" + size + ".png") });
    if (!movie) movie = Buffer.from(await owner.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 248;
      canvas.height = 140;
      const ctx = canvas.getContext("2d");
      const stream = canvas.captureStream(12);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = "#25382b";
        ctx.fillRect(0, 0, 248, 140);
        ctx.font = "14px sans-serif";
        ctx.fillStyle = "#f1f5e9";
        ctx.fillText("Video playback fixture", 48, 40);
        ctx.fillRect(30 + x * 14, 70, 14, 7);
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    }));
    await owner.getByRole("button", { name: "Back to round", exact: true }).click();
    await owner.getByRole("button", { name: "Expand throw videos" }).click();
    await owner.getByRole("button", { name: "Load Avery Brooks · Birdie · Hole 1" }).click();
    await owner.getByText("Couldn’t load this clip.", { exact: false }).waitFor();
    await owner.getByRole("button", { name: "Load Avery Brooks · Birdie · Hole 1" }).click();
    await owner.waitForFunction(() => document.querySelector(".throw-highlights video")?.readyState >= 1);
    await owner.getByRole("button", { name: "Share with round viewers" }).click();
    await owner.getByText("Clip shared with round viewers.").waitFor();

    const spectatorContext = await browser.newContext({ ...options, serviceWorkers: "block" });
    const viewer = await pageFor(spectatorContext, errors, ws);
    await viewer.goto(origin + targetUrl, { waitUntil: "commit", timeout: 60_000 });
    await viewer.locator(".watch-banner").getByRole("status").getByText("Live", { exact: true }).waitFor();
    await viewer.getByText(/Last update .* ago/).waitFor();
    const jordan = viewer.getByRole("button", { name: "Jordan Reyes", exact: true }).first();
    await jordan.focus();
    await viewer.keyboard.press("Enter");
    await viewer.getByText("Jordan Reyes's lies", { exact: true }).waitFor();
    await viewer.getByRole("button", { name: "Hole 2", exact: true }).click();
    await viewer.getByText("Hole 2 · Par 3 · 317 ft", { exact: true }).waitFor();
    if (imageDir) { await viewer.evaluate(() => window.scrollTo(0, 0)); await viewer.screenshot({ path: join(imageDir, "watch-live-" + size + ".png") }); }
    rev = 4;
    const watched = ws.at(-1);
    watched.close({ code: 1001, reason: "testing reconnect" });
    await viewer.locator(".watch-banner").getByText("Reconnecting", { exact: true }).waitFor();
    await viewer.locator(".watch-banner").getByText("Live", { exact: true }).waitFor();
    await viewer.getByText("Jordan Reyes's lies", { exact: true }).waitFor();
    await viewer.getByText("Hole 2 · Par 3 · 317 ft", { exact: true }).waitFor();
    await viewer.getByRole("button", { name: "Expand throw videos" }).click();
    await viewer.locator('.throw-highlights video[aria-label="Avery Brooks · Birdie · Hole 1"]').waitFor();
    await viewer.waitForFunction(() => document.querySelector(".throw-highlights video")?.readyState >= 1);
    final = true;
    ws.at(-1).send(JSON.stringify({ type: "snapshot", ...snapshot, rev: 5, status: "final", observedAt: Date.now() }));
    await viewer.locator(".watch-banner").getByText("Final", { exact: true }).waitFor();
    if (imageDir) await viewer.screenshot({ path: join(imageDir, "watch-final-" + size + ".png") });
    revoked = true;
    await viewer.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await viewer.locator(".watch-banner").getByText("Unavailable").waitFor();
    assert.equal(await viewer.getByText("Final leaderboard", { exact: false }).count(), 0);
    assert.deepEqual(errors, []);
    await spectatorContext.close();
    await ownerContext.close();
    console.log(size + " completed watch-link sharing, clip failure recovery, keyboard follow, reconnect, final replay and revocation");
  }
} finally {
  await browser.close();
  await vite.close();
}
