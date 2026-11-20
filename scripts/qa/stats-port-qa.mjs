// Member Stats page QA: new rating trend, score distribution, metric bars, jump bar, CSV export,
// skeleton/empty/error states, header collision, stacked play history, and that every pre-existing
// element is still on the page. Fixtures: ~40 rated rounds (880-940). Never touches a real API.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createServer } from "vite";
import { PLAY_CATEGORIES } from "../../src/shared/play-stats.js";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const shotDir = process.env.GVDG_STATS_SHOTS || join(tmpdir(), "gvdg-stats-port");
const member = { sub: "m_qa", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: false };
const apiRoot = "/fixture";
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const nowMs = Date.now();

// ~40 rounds across ~14 months, ratings 880-940, deterministic.
const ratedRounds = Array.from({ length: 40 }, (_, i) => {
  const rating = 880 + Math.round(30 + 30 * Math.sin(i / 4.2) + (i % 5) * 0.8 - 15 + i * 0.35);
  return {
    id: "r" + i, date: iso(nowMs - (3 + i * 10.5) * DAY), rating: Math.min(940, Math.max(880, rating)), rating_method: i % 7 === 0 ? "archived" : "stable",
    total: 54 + (i % 6), to_par: (i % 6) - 1, label: "Round " + i,
  };
}).reverse();
const casualRounds = ratedRounds.slice(0, 12).map((r, i) => ({ ...r, id: "c" + i, rating: r.rating - 8, date: iso(nowMs - (6 + i * 21) * DAY) }));
const ratings = {
  competitive: { rounds: ratedRounds, live_rating: 918, eligible_rated_rounds: 31, minimum_rated_rounds: 8, rated_rounds: 40 },
  casual: { rounds: casualRounds, live_rating: 904, eligible_rated_rounds: 12, minimum_rated_rounds: 8, rated_rounds: 12 },
};
const thisYear = new Date().getFullYear();
const events = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i, event_id: 10 + i, event_name: i % 2 ? "Sunday Bag Tag Round" : "October Club Championship", event_date: `${thisYear}-0${(i % 9) + 1}-1${i % 9}`,
  place: (i % 5) + 1, total: 55 + (i % 4), to_par: (i % 5) - 2, layout_name: "Main", rating: 900 + i * 3,
})).filter((row) => new Date(row.event_date).getTime() < nowMs);
const casual = Array.from({ length: 4 }, (_, i) => ({
  id: 200 + i, round_code: "FORD" + i, course_name: "Rocky Ford, \"Short\" tees", layout_name: "Main", finalized_at: iso(nowMs - (2 + i * 6) * DAY) + "T15:00:00Z",
  total: 57 + i, to_par: 3 - i,
}));

function mineFor(spec, id) {
  const [hit, att] = spec[id] || [0, 0];
  return { pct: att ? Math.round((hit / att) * 1000) / 10 : 0, rank: 2, field: 12, hit, att };
}
function kindPayload(holes, mix, shots) {
  const spec = {
    ace: [mix[0], holes], eagle: [mix[1], holes], birdieMix: [mix[2], holes], parMix: [mix[3], holes], bogey: [mix[4], holes], double: [mix[5], holes],
    birdie: [mix[2], holes], par: [mix[3], holes], ...shots,
  };
  return {
    mine: { memberId: member.sub, name: member.name, totals: { holes, aces: mix[0], eagles: mix[1], birdies: mix[2], pars: mix[3], bogeys: mix[4], doubles_plus: mix[5], birdie_hit: mix[2], par_hit: mix[3] } },
    categories: PLAY_CATEGORIES.map((cat) => ({
      id: cat.id, group: cat.group, label: cat.label, short: cat.short, tone: cat.tone, min: cat.min, field: 12,
      mine: mineFor(spec, cat.id),
      leaders: cat.group === "mix" ? [] : [{ memberId: "a", name: "Jordan Parker", pct: 71.2 }, { memberId: "b", name: "Casey Lee", pct: 66 }],
    })),
  };
}
const playStats = {
  year: thisYear, kinds: ["competitive", "casual"],
  competitive: kindPayload(54, [0, 1, 11, 28, 11, 3], { c1Putt: [30, 36], c1xPutt: [14, 22], c2Putt: [3, 12], fir: [20, 40], c1r: [18, 54], parked: [9, 54], scramble: [6, 20] }),
  casual: kindPayload(36, [0, 0, 6, 20, 8, 2], { c1Putt: [18, 22], c1xPutt: [9, 14] }),
};
const playHistory = {
  options: { courses: [{ key: "id:7", label: "West Meadowbrook" }], layouts: [], holes: [1] },
  filters: { source: "all", group: "singles", style: "stroke", course: "", layout: "" },
  roundCount: 3, scoreTrend: { averageToParPerHole: .17, scoreHoles: 54 },
  totals: { c1_putt_hit: 14, c1_putt_att: 18, c1x_putt_hit: 8, c1x_putt_att: 12, c2_putt_hit: 1, c2_putt_att: 4, shot_verified_holes: 8, shot_eligible_holes: 18, shot_count_matched_holes: 5, shot_incomplete_holes: 5 },
  latest: { rounds: 1, averageToParPerHole: .17, scoreHoles: 18, c1x: { percentage: 66.7, attempts: 12 } },
  previous: { rounds: 0, averageToParPerHole: null, scoreHoles: 0, c1x: { percentage: null, attempts: 0 } }, coverage: {},
  recentRounds: Array.from({ length: 3 }, (_, i) => ({ id: "casual:" + i, source: "casual", date: "Nov " + (13 - i) + ", " + thisYear, course: "Rocky Ford - Short tees, extra long course name for wrapping", layout: "Main",
    scoredHoles: 18, strokes: 57 + i, toPar: 3 - i * 2, group: "singles", explicitLedgerHoles: 0 })),
};

function handler(scenario) {
  return async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(apiRoot.length);
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (path === "/me") return json({ ...member, mustChangePin: false });
    if (path === "/pdga-stats") return json({ name: member.name, official_rating: 912, rating_date: "2026-11-01", live_rating: null, peak_rating: null, events_count: 0, events: [], source: "pdga-api" });
    if (path === "/my-results") return json({ results: scenario === "empty" ? [] : events, casual: scenario === "empty" ? [] : casual });
    if (path === "/my-ratings") {
      if (scenario === "error") return json({ error: "x" }, 503);
      if (scenario === "loading") await new Promise((resolve) => setTimeout(resolve, 2500));
      return json(scenario === "empty" ? { competitive: { rounds: [], live_rating: null, eligible_rated_rounds: 0, minimum_rated_rounds: 8 }, casual: { rounds: [] } } : ratings);
    }
    if (path === "/play-stats") return json(playStats);
    if (path === "/my-play-history") return json(playHistory);
    if (path === "/my-registrations") return json({ registrations: [] });
    if (path === "/leagues/active") return json({ leagues: [] });
    return json({});
  };
}

await mkdir(shotDir, { recursive: true });
const vite = await createServer({
  configFile: false, cacheDir: await mkdtemp(join(tmpdir(), "gvdg-stats-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_STATS_PORT || 5197), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{ name: "stats-port-html", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/gvdg-members.html") { next(); return; }
      const mode = url.searchParams.get("mode") || "light";
      const seed = '<script>localStorage.setItem("gvdg_member_token","member-token");localStorage.setItem("theme",' + JSON.stringify(mode) + ");</script>";
      const html = (await readFile("gvdg-members.html", "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
        .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
        .replace('data-auth-base=""', 'data-auth-base="' + apiRoot + '"')
        .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"')
        .replace("<head>", "<head>" + seed + (url.searchParams.has("large") ? "<style>html{font-size:20px}</style>" : ""));
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(await server.transformIndexHtml(url.pathname, html));
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function open(width, mode, scenario = "populated", large = false) {
  const context = await browser.newContext({ viewport: { width, height: 870 }, serviceWorkers: "block", acceptDownloads: true });
  await context.route(/^https?:/, (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin) return route.abort();
    if (u.pathname.startsWith(apiRoot + "/")) return handler(scenario)(route);
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(30_000);
  await page.goto(`${origin}/gvdg-members.html?mode=${mode}${large ? "&large" : ""}#stats`, { waitUntil: "commit" });
  return { page, context, errors };
}

async function shoot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const node = page.locator(".react-season-page");
  await page.screenshot({ path: join(shotDir, name + ".png"), fullPage: true, animations: "disabled" });
  return node;
}

async function populated(width, mode, large = false) {
  const view = await open(width, mode, "populated", large);
  const { page } = view;
  await page.locator("[data-react-season-page='ready']").waitFor();
  await page.locator("[data-stats-trend='ready']").waitFor();
  await page.locator("[data-react-club-ratings='ready']").waitFor();
  await page.waitForTimeout(400);
  const tag = `${width}-${mode}${large ? "-large" : ""}`;

  // ---- every pre-existing element still present ----
  const body = page.locator(".react-season-page");
  for (const label of ["Event rounds", "Event avg", "Best finish"]) assert.ok(await body.getByText(label, { exact: true }).count(), label);
  assert.equal(await body.getByText("Club rating", { exact: true }).count() > 0, true, "Club rating label (live value) present");
  assert.ok(await body.getByText("My play history").count() || await body.locator(".member-history-panel").count(), "play history");
  for (const group of ["Group format", "Scoring style"]) assert.ok(await body.getByRole("tablist", { name: group }).count(), group);
  assert.ok(await body.locator(".play-score-mix").count() >= 2, "existing score mix bars");
  assert.ok(await body.locator(".play-score-legend").count() >= 2, "existing score mix legends");
  assert.ok(await body.locator(".play-stat-card").count() >= 6, "stat cards");
  assert.ok(await body.locator(".play-stat-leaders").count() >= 1, "club leaders lists");
  assert.ok(await body.getByText("Club results", { exact: true }).count(), "club results");
  assert.ok(await body.getByText("Coming up", { exact: true }).count(), "coming up");
  assert.ok(await body.locator(".dash-rating-row").count(), "pdga tiles");
  // PDGA's official rating only (PDGA's API); no PDGA-derived estimate (PDGA's terms).
  assert.ok(await body.getByText("PDGA official rating", { exact: true }).count() && !(await body.getByText("Live rating estimate", { exact: true }).count()), "PDGA labels");
  assert.ok(await body.locator("[data-react-club-ratings]").count(), "club ratings list");
  assert.ok(await body.getByText("Import UDisc history").count(), "import link");
  // rank notes survive next to the bars
  assert.ok(await body.locator(".play-stat-card .play-stat-s", { hasText: /\d+\/\d+/ }).count(), "hit/attempt counts");
  assert.ok(await body.locator(".play-stat-card .stats-metric-bar").count() >= 4, "metric bars");

  // ---- new modules ----
  const trend = page.locator("#stats-trend");
  assert.ok(await trend.locator("svg[role='img']").count(), "trend svg");
  assert.ok(/High \d+ on [A-Z][a-z]{2} \d+, \d{4}/.test(await trend.locator(".stats-note").innerText()), "high caption with formatted date");
  assert.ok(await trend.locator(".stats-label").count(), "direct last-point label");
  const ticks = await trend.locator(".stats-axis").allInnerTexts();
  assert.ok(ticks.length >= 4, "axis ticks + date labels");
  const before = await trend.locator(".stats-line").getAttribute("d");
  await trend.getByRole("button", { name: "3 mo", exact: true }).click();
  assert.notEqual(await trend.locator(".stats-line").getAttribute("d"), before, "range changes the line");
  await trend.getByRole("button", { name: "All", exact: true }).click();
  await trend.getByRole("button", { name: "Casual", exact: true }).click();
  assert.ok(await trend.getByText("Club rating (casual)").count(), "casual club rating label");
  await trend.getByRole("button", { name: "Competitive", exact: true }).click();
  // one label, one number
  const keyText = await trend.locator(".stats-rating-key").innerText();
  assert.ok(/Club rating\s*918/.test(keyText) && /PDGA official rating\s*912/.test(keyText) && !/Live rating estimate/.test(keyText), "rating key: " + keyText);
  const dist = body.locator(".stats-dist").first();
  assert.ok(await dist.locator(".stats-dist-row").count() >= 4, "distribution rows: " + (await body.locator(".play-score-mix-wrap").first().innerHTML()).slice(0, 600));
  assert.ok(/\d+ holes?/.test(await dist.innerText()) && /%/.test(await dist.innerText()), "counts and percents");
  // no ISO dates in additions
  const added = (await page.locator(".stats-trend, .stats-dist, .stats-jump").allInnerTexts()).join(" ");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(added), "no raw ISO dates in added modules");

  // ---- jump bar ----
  const jump = page.locator(".stats-jump");
  assert.equal(await jump.evaluate((el) => el.scrollLeft), 0, "jump bar starts at scrollLeft 0 " + tag);
  assert.ok(await jump.getByRole("button", { name: "Overview", exact: true }).evaluate((el) => el.getBoundingClientRect().left >= 0), "Overview chip fully visible " + tag);
  console.log("jump", tag, JSON.stringify(await jump.evaluate((el) => { const r = el.getBoundingClientRect(); const chain = []; for (let n = el; n && chain.length < 8; n = n.parentElement) chain.push(n.tagName + "." + String(n.className).slice(0, 30) + ":" + Math.round(n.getBoundingClientRect().width) + ":" + getComputedStyle(n).display); return [r.left, r.right, r.top, el.scrollWidth, el.clientWidth, innerWidth, chain]; })));
  await jump.getByRole("button", { name: "Results", exact: true }).click({ timeout: 5000 });
  await page.waitForFunction(() => { const t = document.querySelector("#stats-results").getBoundingClientRect().top; return t < 300; }, null, { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500);
  assert.equal(page.url().endsWith("#stats"), true, "hash unchanged by jump");
  const top = await page.locator("#stats-results").evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(top < 400 && top > -50, "jumped to results, top=" + top);
  const jumpTop = await jump.evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(jumpTop >= 0 && jumpTop < 140, "jump bar stays sticky, top=" + jumpTop + " " + await jump.evaluate((el) => { const out = []; for (let n = el.parentElement; n; n = n.parentElement) { const c = getComputedStyle(n); if (c.overflow !== "visible" || c.contain !== "none") out.push(n.tagName + "." + n.className + "#" + n.id + ":" + c.overflow + "/" + c.contain); } return out.join(" | "); }));
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForFunction(() => document.querySelector(".stats-jump").scrollLeft === 0, null, { timeout: 5000 });

  // ---- header collision ----
  const boxes = await page.evaluate(() => {
    const t = document.querySelector(".react-season-page .my-dashboard-title").getBoundingClientRect();
    return [...document.querySelectorAll(".react-season-page .stats-actions > *")].map((el) => {
      const r = el.getBoundingClientRect();
      return !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom);
    });
  });
  assert.ok(boxes.length >= 2 && boxes.every((hit) => !hit), "title overlaps action buttons: " + boxes);

  // ---- no horizontal scroll ----
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page width fits " + tag);
  const wide = await page.evaluate(() => [...document.querySelectorAll(".react-season-page *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest(".stats-jump") && !el.closest("svg")).map((el) => el.tagName + "." + String(el.className).slice(0, 40) + ":" + Math.round(el.getBoundingClientRect().right)).slice(0, 8));
  assert.deepEqual(wide, [], "elements past viewport " + tag);

  // ---- history stacked below 640 ----
  if (width < 640) {
    const info = await page.locator(".member-history-table").first().evaluate((el) => ({
      rowDisplay: getComputedStyle(el.querySelector("tbody tr")).display, headVisible: el.querySelector("thead").getBoundingClientRect().width,
      headCount: el.querySelectorAll("thead th").length, over: el.scrollWidth > el.clientWidth + 1,
    }));
    assert.equal(info.rowDisplay, "grid"); assert.ok(info.headCount === 5 && info.headVisible <= 1.5, "thead kept for AT"); assert.equal(info.over, false);
  }
  await shoot(page, "stats-" + tag);
  assert.deepEqual(view.errors, []);
  return view;
}

async function csv() {
  const view = await populated(390, "dark");
  const [download] = await Promise.all([
    view.page.waitForEvent("download"),
    view.page.getByRole("button", { name: "Export rounds (CSV)", exact: true }).click(),
  ]);
  assert.match(download.suggestedFilename(), /^gvdg-\d{4}-rounds\.csv$/);
  const text = await readFile(await download.path(), "utf8");
  const lines = text.trim().split("\r\n");
  assert.equal(lines[0], "date,kind,event_or_course,layout,place,total,to_par,round_rating");
  assert.ok(lines.length > events.length, "rows exported: " + lines.length);
  assert.ok(text.includes('"Rocky Ford, ""Short"" tees"'), "csv quoting");
  await view.context.close();
}

async function states() {
  for (const scenario of ["empty", "loading", "error"]) {
    const view = await open(390, "dark", scenario);
    const { page } = view;
    if (scenario === "loading") {
      await page.locator("[data-stats-trend='loading']").waitFor();
      assert.ok(await page.locator("[data-stats-trend='loading'] [aria-busy='true']").count(), "skeleton");
      await page.waitForTimeout(300);
    } else {
      await page.locator(`[data-stats-trend='${scenario}']`).waitFor({ timeout: 20_000 });
      await page.locator("[data-react-season-page='ready']").waitFor();
      if (scenario === "error") assert.ok(await page.locator("[data-stats-trend='error'][role], [data-stats-trend='error'] [role='alert']").count(), "error alert");
    }
    await shoot(page, "state-" + scenario);
    assert.deepEqual(view.errors, []);
    await view.context.close();
  }
}

try {
  for (const [w, mode, large] of [[390, "dark", false], [390, "light", false], [1280, "dark", false], [320, "dark", true], [320, "light", true]]) {
    const view = await populated(w, mode, large);
    await view.context.close();
    console.log(`stats ${w}px ${mode}${large ? " large" : ""} ok`);
  }
  await csv();
  console.log("csv export ok");
  await states();
  console.log("empty / loading / error states ok");
  console.log("stats-port QA passed; screenshots in " + shotDir);
} finally {
  await browser.close();
  await vite.close();
}
