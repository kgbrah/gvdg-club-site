// Glass theme QA for the member app: Appearance controls (Off / Frosted / Custom), Home, Club and Wallet over a
// photo wallpaper in dark and light, with computed-style assertions for the glass guardrails.
// Run: CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/theme-glass-qa.mjs   (GVDG_GLASS_SHOTS=<dir> keeps screenshots)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

import { GLASS_PRESETS, buildGlassOnlyTheme, buildTheme } from "../../src/shared/dashboard-theme-model.js";
import { measureContrast } from "./theme-glass-contrast.mjs";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";

const member = { sub: "m_glass_fixture", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: false };
const activeEvent = { id: 51, name: "Sunday Bag Tag Round", status: "scheduled", type: "league_round",
  date: "2026-11-22", course_name: "West Meadowbrook Park", layout_name: "Main" };
const wallpapers = {};
for (const name of ["slide4", "slide5"]) {
  wallpapers[name] = "data:image/jpeg;base64," + (await readFile("img/" + name + ".jpg")).toString("base64");
}
const pageName = "/member-glass.html";
const apiRoot = "/member-glass-api";
const images = process.env.GVDG_GLASS_SHOTS || join(tmpdir(), "gvdg-glass-qa");

const WARM = ["#c2410c", "#f59e0b", "#7c2d12", "#fde68a", "#1c1917"];
function themeFor(query) {
  if (query.glass === "none") return null;
  if (query.wp === "default") {
    // Glass on the club default: no custom palette or wallpaper.
    const only = GLASS_PRESETS[query.glass] || GLASS_PRESETS.off;
    return only.opacity || only.blur ? buildGlassOnlyTheme({ opacity: only.opacity, blur: only.blur }, query.mode === "light" ? "light" : "dark") : null;
  }
  const custom = /^(\d+)-(\d+)$/.exec(query.glass || "");
  const preset = custom ? { opacity: Number(custom[1]), blur: Number(custom[2]) } : GLASS_PRESETS[query.glass] || GLASS_PRESETS.off;
  return buildTheme({
    mode: query.mode === "light" ? "light" : "dark", wallpaper: wallpapers[query.wp || "slide5"],
    ...(query.pal === "warm" ? { sourcePalette: WARM } : { preset: "Frost" }),
    glass: { opacity: preset.opacity, blur: preset.blur },
  });
}

function response(path, query) {
  if (path === "/me") return member;
  if (path === "/me/dashboard-theme") return { theme: themeFor(query) };
  // PDGA membership (an expired one, so Home shows the renewal card) with the club's code.
  if (path === "/pdga/membership") return { pdgaNumber: "123456", lookup: "ok", joinUrl: "https://www.pdga.com/membership", renewUrl: "https://www.pdga.com/membership/renew",
    player: { name: member.name, membershipStatus: "expired", membershipExpires: "2025-12-31", url: "https://www.pdga.com/player/123456" },
    promo: { code: "GVDG2026", validThrough: "2026" }, clubDiscountAvailable: true, attribution: "Player, event, and course data provided by PDGA" };
  if (path === "/rounds/RIVER7/live/mine") return { status: "live", cardId: 1, cardmates: [{ name: "Morgan" }] };
  if (path === "/my-live-rounds") return { rounds: [] };
  if (path === "/pdga-stats") return { name: member.name, official_rating: 913, live_rating: 918, previous_rating: 910,
    events: [{ tournament: "Greenville Open", date: "Oct 21, 2026", division: "MA2", rounds: [{ rating: 919, score: 55 }] }] };
  if (path === "/shop/wallet") return { balance_cents: 3250,
    transactions: [{ id: 1, amount_cents: 3250, source: "event_payout", created_at: "2026-11-13T19:30:00Z" },
      { id: 2, amount_cents: -1200, source: "shop_purchase", created_at: "2026-11-10T15:00:00Z" }] };
  if (path === "/events" || path === "/registration/open") return { events: [activeEvent] };
  if (path === "/bag-tags/mine") return { series: { id: 1, name: "Greenville 2026" }, mine: { memberId: member.sub, tagNumber: 12 }, holders: [], challenges: [] };
  if (path === "/my-results") return { results: [], casual: [] };
  if (path === "/my-ratings") return { competitive: { rounds: [] }, casual: { rounds: [] } };
  return {};
}

const vite = await createServer({
  configFile: false, cacheDir: await mkdtemp(join(tmpdir(), "gvdg-glass-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_GLASS_PORT || 5189), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{
    name: "member-glass-qa",
    configureServer(server) {
      server.middlewares.use(async (request, res, next) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === pageName) {
          const mode = url.searchParams.get("mode") === "light" ? "light" : "dark";
          const seed = '<script>localStorage.setItem("gvdg_member_token","fixture-member");localStorage.setItem("theme",' +
            JSON.stringify(mode) + ');</script>';
          const html = (await readFile("gvdg-members.html", "utf8"))
            .replace(/<link[^>]+https:[^>]+>/g, "")
            .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
            .replace('data-auth-base=""', 'data-auth-base="' + apiRoot + '"')
            .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"')
            .replace("<head>", "<head>" + seed);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(await server.transformIndexHtml(pageName, html));
        } else if (url.pathname.startsWith(apiRoot + "/")) {
          const path = url.pathname.slice(apiRoot.length);
          const ref = request.headers.referer ? new URL(request.headers.referer) : null;
          const query = Object.fromEntries(ref?.searchParams || []);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response(path, query)));
        } else next();
      });
    },
  }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
if (process.env.GVDG_GLASS_SERVE) {
  console.log(origin + pageName + "?glass=frosted&mode=dark#home");
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  await vite.close();
  process.exit(0);
}
await mkdir(images, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
function parseRgba(value) {
  const match = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)|rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? ?\/? ?([\d.]+))?\)/.exec(value);
  if (!match) return null;
  if (match[1] !== undefined) return { r: match[1] * 255, g: match[2] * 255, b: match[3] * 255, a: match[4] === undefined ? 1 : Number(match[4]) };
  return { r: Number(match[5]), g: Number(match[6]), b: Number(match[7]), a: match[8] === undefined ? 1 : Number(match[8]) };
}

async function open(width, height, route, { glass = "frosted", mode = "dark", wp = "slide5", pal = "", reduced = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, serviceWorkers: "block", reducedMotion: "reduce",
    ...(reduced ? { forcedColors: "none" } : {}),
  });
  await context.route(/^https?:/, (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + pageName + "?glass=" + glass + "&mode=" + mode + "&wp=" + wp + (pal ? "&pal=" + pal : "") + "#" + route, { waitUntil: "commit" });
  await page.waitForSelector(wp === "default" ? "body[data-member-shell]" : "body.player-theme-active");
  if (wp === "default" && glass !== "off") await page.waitForSelector("body.player-theme-glass");
  await page.evaluate(() => document.fonts.ready);
  return { page, context, errors };
}

try {
  // 1. Member surfaces with glass: Home, Club hub, Wallet, in dark and light, plus Off for comparison.
  for (const mode of ["dark", "light"]) {
    for (const glass of ["frosted", "off"]) {
      for (const [route, ready] of [["home", ".player-home"], ["club-hub", "#members"], ["wallet", ".wallet-panel, #members"]]) {
        const { page, context, errors } = await open(390, 844, route, { glass, mode });
        await page.locator(ready).first().waitFor();
        await page.waitForTimeout(500);
        const body = await page.evaluate(() => ({
          glass: document.body.classList.contains("player-theme-glass"),
          alpha: document.body.style.getPropertyValue("--glass-alpha"),
          blur: document.body.style.getPropertyValue("--glass-blur"),
          overflow: document.documentElement.scrollWidth > innerWidth,
        }));
        assert.equal(body.glass, glass === "frosted", route + " " + mode + " glass class");
        assert.equal(body.overflow, false, route + " horizontal overflow");
        if (glass === "frosted") assert.deepEqual([body.alpha, body.blur], ["45%", "20px"]);
        await page.screenshot({ path: join(images, "member-" + route + "-" + glass + "-" + mode + "-390.png"), animations: "disabled" });
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }

  // 2. Guardrail checks on Home (frosted): header + dock + at least one panel carry a backdrop blur, and
  // the panels are translucent but never below 40% opaque.
  for (const [mode, pal] of [["dark", ""], ["light", ""], ["dark", "warm"], ["light", "warm"]]) {
    const { page, context } = await open(390, 844, "home", { glass: "frosted", mode, pal });
    await page.locator(".player-home").waitFor();
    const result = await page.evaluate(() => {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const style = getComputedStyle(el);
        return { filter: style.backdropFilter || style.webkitBackdropFilter, bg: style.backgroundColor };
      };
      return { header: read(".member-app-header"), dock: read(".player-app-nav"), hero: read("#members .member-round-hero"), panel: read("#members .member-list-rows, #members .bag-tag-home, #members .play-stats-panel, #members .member-home-services") };
    });
    for (const key of ["header", "dock", "panel", "hero"]) {
      assert.ok(result[key], key + " exists");
      const label = key + " " + mode + (pal ? " " + pal : "");
      const blur = Number(/blur\(([\d.]+)px\)/.exec(result[key].filter)?.[1]);
      assert.ok(blur >= 16, key + " blur is >= 16px: " + result[key].filter);
      const sat = Number(/saturate\(([\d.]+)(%?)\)/.exec(result[key].filter)?.[1]);
      assert.ok(sat > 0 && (sat <= 1.2 || (sat > 5 && sat <= 120)), key + " saturate <= 120%: " + result[key].filter);
      const color = parseRgba(result[key].bg);
      // Visibility: Frosted must be obviously see-through (alpha <= 0.6) yet never below 40% opaque.
      assert.ok(color && color.a > 0.39 && color.a <= 0.6, key + " is visibly see-through but readable: " + result[key].bg);
      // Neutral glass: no theme colour in the fill (r, g, b nearly equal), even under a strongly warm theme.
      assert.ok(Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 12, key + " fill is neutral: " + result[key].bg);
    }
    await context.close();
  }

  // 2b. WCAG AA over a busy, bright photo wallpaper: render with text hidden, then check every text
  // element's colour against the worst-case (95th percentile) background pixels beneath it.
  // Texts that already miss AA with glass Off (palette/disabled styling) are the base's, not glass's.
  for (const mode of ["dark", "light"]) {
    for (const route of ["home", "club-hub"]) {
      const baseline = new Set();
      for (const glass of ["off", "frosted", "clear", "60-0"]) {
        const { page, context } = await open(390, 844, route, { glass, mode });
        await page.locator("#members").first().waitFor();
        await page.waitForTimeout(500);
        const fails = await measureContrast(page, "#members");
        const key = (f) => f.split("|")[0];
        if (glass === "off") {
          fails.forEach((f) => baseline.add(key(f)));
          console.log("  base-AA misses (" + mode + " " + route + "): " + (fails.join("; ") || "none"));
        } else {
          assert.deepEqual(fails.filter((f) => !baseline.has(key(f))), [], "AA over wallpaper " + mode + " " + glass + " " + route);
        }
        await context.close();
      }
    }
  }

  // 3. Reduced transparency and Off fall back to solid surfaces.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
    await context.route(/^https?:/, (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    const page = await context.newPage();
    await page.emulateMedia({ media: "screen", reducedMotion: "reduce" });
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await page.goto(origin + pageName + "?glass=frosted&mode=dark&wp=slide5#home", { waitUntil: "commit" });
    await page.locator(".player-home").waitFor();
    await page.waitForTimeout(300);
    const solid = await page.evaluate(() => {
      const el = document.querySelector(".player-app-nav");
      const style = getComputedStyle(el);
      return { filter: style.backdropFilter, bg: style.backgroundColor };
    });
    assert.equal(solid.filter, "none", "reduced transparency drops the blur");
    assert.ok(parseRgba(solid.bg).a >= 0.99, "reduced transparency is solid: " + solid.bg);
    await page.screenshot({ path: join(images, "member-home-frosted-reduced-transparency-390.png"), animations: "disabled" });
    await context.close();
  }

  // 4. Appearance: the Glass group — presets, Custom on slider move, keyboard, Reset.
  for (const [width, height] of [[390, 1400], [1280, 1100]]) {
    const { page, context, errors } = await open(width, height, "appearance", { glass: "off", mode: "dark" });
    const group = page.locator(".dash-theme-glass");
    await group.waitFor();
    await group.scrollIntoViewIfNeeded();
    const active = async () => group.locator(".dash-theme-glass-seg button.is-active").getAttribute("data-glass-preset");
    assert.equal(await active(), "off");
    assert.equal(await page.evaluate(() => document.body.classList.contains("player-theme-glass")), false);
    await page.screenshot({ path: join(images, "appearance-glass-off-" + width + ".png"), animations: "disabled" });
    for (const button of await group.locator(".dash-theme-glass-seg button").all()) {
      const box = await button.boundingBox();
      assert.ok(box.height >= 43.5, "preset buttons are 44px tall: " + box.height);
    }
    await group.getByRole("button", { name: "Frosted" }).click();
    assert.equal(await active(), "frosted");
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--glass-blur")), "20px");
    assert.equal(await page.evaluate(() => document.body.classList.contains("player-theme-glass")), true);
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(images, "appearance-glass-frosted-" + width + ".png"), animations: "disabled" });
    await group.getByRole("button", { name: "Custom" }).click();
    assert.equal(await active(), "custom");
    const blurSlider = group.getByRole("slider", { name: "Blur" });
    await blurSlider.waitFor();
    await blurSlider.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await active(), "custom");
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--glass-blur")), "19px");
    const slider = group.getByRole("slider", { name: "Glass" });
    for (const range of [slider, blurSlider]) {
      const box = await range.boundingBox();
      assert.ok(box.height >= 43.5, "slider target is 44px tall");
    }
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(images, "appearance-glass-custom-" + width + ".png"), animations: "disabled" });
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("gvdg_dashboard_theme:")).map(([, value]) => JSON.parse(value).glass));
    assert.ok(stored.some((glass) => glass.opacity === 45 && glass.blur === 19), "glass saved locally: " + JSON.stringify(stored));
    await group.getByRole("button", { name: "Off" }).click();
    assert.equal(await active(), "off");
    assert.equal(await page.evaluate(() => document.body.classList.contains("player-theme-glass")), false);
    await group.getByRole("button", { name: "Clear" }).click();
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--glass-alpha")), "60%");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForFunction(() => !document.body.classList.contains("player-theme-glass"));
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--glass-alpha")), "");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 4b. Glass without a custom theme: the club default forest shows through, colors stay the club's own,
  // saved locally and synced; Off and Reset return to the true default.
  for (const mode of ["dark", "light"]) {
    for (const [route, ready] of [["home", ".player-home"], ["club-hub", "#members"]]) {
      const baseline = new Set();
      for (const glass of ["off", "frosted", "clear"]) {
        const { page, context, errors } = await open(390, 844, route, { glass, mode, wp: "default" });
        await page.locator(ready).first().waitFor();
        await page.waitForTimeout(500);
        const state = await page.evaluate(() => ({
          glass: document.body.classList.contains("player-theme-glass"),
          page: document.body.classList.contains("player-theme-page"),
          active: document.body.classList.contains("player-theme-active"),
          before: getComputedStyle(document.body, "::before").display,
          dark: document.documentElement.getAttribute("data-theme") === "dark",
        }));
        assert.equal(state.glass, glass !== "off");
        assert.equal(state.page, false, "club colors untouched");
        assert.equal(state.active, false);
        assert.notEqual(state.before, "none", "default forest layer stays");
        assert.equal(state.dark, mode === "dark", "site light/dark mode untouched");
        await page.screenshot({ path: join(images, "default-" + route + "-" + glass + "-" + mode + "-390.png"), animations: "disabled" });
        const fails = await measureContrast(page, "#members");
        if (glass === "off") fails.forEach((f) => baseline.add(f.split("|")[0]));
        else assert.deepEqual(fails.filter((f) => !baseline.has(f.split("|")[0])), [], "AA over default forest " + mode + " " + glass + " " + route);
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }
  {
    const puts = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 1200 }, serviceWorkers: "block" });
    await context.route(/^https?:/, (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    await context.route("**/member-glass-api/me/dashboard-theme", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ theme: null }) });
      puts.push({ method: request.method(), body: request.postData() });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ theme: null }) });
    });
    const page = await context.newPage();
    await page.goto(origin + pageName + "?glass=none&mode=dark#appearance", { waitUntil: "commit" });
    const group = page.locator(".dash-theme-glass");
    await group.waitFor();
    assert.equal(await page.locator(".dash-theme-glass-seg button:disabled").count(), 0, "glass is usable without a theme");
    await group.getByRole("button", { name: "Frosted" }).click();
    await page.waitForFunction(() => document.body.classList.contains("player-theme-glass"));
    assert.equal(await page.evaluate(() => document.body.classList.contains("player-theme-page")), false);
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("gvdg_dashboard_theme:")).map(([, value]) => JSON.parse(value)));
    assert.ok(stored.some((theme) => theme.glassOnly === true && theme.glass.blur === 20 && !theme.palette.length), "glass-only theme saved locally");
    await page.waitForTimeout(300);
    const last = puts.at(-1);
    assert.equal(last.method, "PUT");
    assert.equal(JSON.parse(last.body).theme.glassOnly, true);
    await group.getByRole("button", { name: "Off" }).click();
    await page.waitForFunction(() => !document.body.classList.contains("player-theme-glass"));
    await page.waitForTimeout(300);
    assert.equal(puts.at(-1).method, "DELETE", "Off clears the saved theme");
    await group.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForFunction(() => !document.body.classList.contains("player-theme-glass"));
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("gvdg_dashboard_theme:"))), []);
    await context.close();
  }

  // 5. A server that drops `glass` must not wipe the locally saved value.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await context.route(/^https?:/, (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    await context.route("**/member-glass-api/me/dashboard-theme", async (route) => {
      const theme = themeFor({ glass: "off", mode: "dark", wp: "slide5" });
      const { glass: _glass, ...legacy } = theme;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ theme: legacy }) });
    });
    const page = await context.newPage();
    const local = themeFor({ glass: "frosted", mode: "dark", wp: "slide5" });
    await page.addInitScript((value) => {
      for (const id of ["m_glass_fixture", "123456", "me"]) localStorage.setItem("gvdg_dashboard_theme:" + id, value);
    }, JSON.stringify(local));
    await page.goto(origin + pageName + "?glass=off&mode=dark#home", { waitUntil: "commit" });
    await page.locator(".player-home").waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue("--glass-blur")), "20px", "legacy server response keeps local glass");
    await context.close();
  }
  console.log("theme glass member QA passed; screenshots in " + images);
} finally {
  await browser.close();
  await vite.close();
}

// 6. Sitewide glass (public pages + scorecard setup / course pick): its own script, run against the built site.
if (!process.env.GVDG_GLASS_SERVE && !process.env.GVDG_GLASS_SKIP_SITEWIDE) {
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["scripts/qa/theme-glass-sitewide-qa.mjs"], { stdio: "inherit", env: process.env });
  if (run.status !== 0) process.exit(run.status || 1);
}
