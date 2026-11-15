// Theme studio QA: collapsible groups (defaults, remembered state, summaries, nested Adjust glass) and
// scroll-safe sliders verified with REAL touch input (CDP Input.dispatchTouchEvent on a touch-emulated mobile
// context): a vertical swipe that starts on the Vibrance slider scrolls the page and leaves the value alone;
// a horizontal drag on the thumb changes it.
// Run: CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/theme-studio-qa.mjs   (GVDG_STUDIO_SHOTS=<dir> keeps screenshots)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

import { buildTheme } from "../../src/shared/dashboard-theme-model.js";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";

const member = { sub: "m_studio_fixture", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: false };
const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide5.jpg")).toString("base64");
const pageName = "/member-studio.html";
const apiRoot = "/member-studio-api";
const images = process.env.GVDG_STUDIO_SHOTS || join(tmpdir(), "gvdg-studio-qa");

function themeFor(query) {
  if (query.theme === "none") return null;
  return buildTheme({ mode: query.mode === "light" ? "light" : "dark", preset: "Frost", wallpaper: query.theme === "preset" ? null : wallpaper });
}

function response(path, query) {
  if (path === "/me") return member;
  if (path === "/me/dashboard-theme") return { theme: themeFor(query) };
  if (path === "/my-live-rounds") return { rounds: [] };
  if (path === "/events" || path === "/registration/open") return { events: [] };
  if (path === "/bag-tags/mine") return { series: null, mine: null, holders: [], challenges: [] };
  if (path === "/my-results") return { results: query.tp == null ? [] : [{ event_id: 9, event_name: "Sunday Bag Tag Round", event_date: "2026-11-08", to_par: Number(query.tp), total: 57 + Number(query.tp), place: 3 }], casual: [] };
  if (path === "/my-ratings") return { competitive: { rounds: [] }, casual: { rounds: [] } };
  return {};
}

const vite = await createServer({
  configFile: false, cacheDir: await mkdtemp(join(tmpdir(), "gvdg-studio-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_STUDIO_PORT || 5191), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{
    name: "member-studio-qa",
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response(path, Object.fromEntries(ref?.searchParams || []))));
        } else next();
      });
    },
  }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
await mkdir(images, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function open(width, height, { theme = "wallpaper", mode = "dark", touch = false, init, tp = null, route = "appearance" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, serviceWorkers: "block", reducedMotion: "reduce",
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  await context.route(/^https?:/, (r) => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + pageName + "?theme=" + theme + "&mode=" + mode + (tp == null ? "" : "&tp=" + tp) + "#" + route, { waitUntil: "commit" });
  await page.locator(route === "appearance" ? ".dash-theme-studio" : "[data-react-home-last-round=ready]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context, errors };
}

const section = (page, id) => page.locator('[data-studio-section="' + id + '"]');
const isOpen = (page, id) => section(page, id).evaluate((el) => el.open);

async function touchSequence(session, points) {
  const [first, ...rest] = points;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first.x, y: first.y, id: 1 }] });
  for (const point of rest) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const results = {};
try {
  // 1. Defaults: Presets + Glass open, Wallpaper closed with a wallpaper set, Colors/Generate/Adjust closed.
  {
    const { page, context, errors } = await open(390, 844);
    for (const [id, expected] of [["presets", true], ["glass", true], ["wallpaper", false], ["colors", false], ["generate", false], ["adjust", false]]) {
      assert.equal(await isOpen(page, id), expected, id + " default open state");
    }
    assert.equal(await page.locator('.dash-theme-glass-seg button[data-glass-preset="off"]').isVisible(), true, "glass segmented control visible");
    assert.equal(await page.locator('input[aria-label="Blur"]').count(), 1);
    assert.equal(await page.locator('input[aria-label="Blur"]').isVisible(), false, "Adjust glass is collapsed by default");
    // The action bar stays reachable.
    for (const name of ["Extract", "Reset", "Apply Theme"]) assert.equal(await page.getByRole("button", { name, exact: true }).count() > 0, true, name);
    assert.match(await section(page, "adjust").locator("> summary").innerText(), /Adjust[\s\S]*Default/i);
    assert.match(await section(page, "glass").locator("> summary").innerText(), /Glass[\s\S]*Off/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal overflow");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Wallpaper opens by default when no wallpaper is set.
  {
    const { page, context } = await open(390, 844, { theme: "none" });
    assert.equal(await isOpen(page, "wallpaper"), true, "wallpaper open without a wallpaper");
    await context.close();
  }

  // 2. Toggle, summary state, remembered per device, glass Custom opens Adjust glass.
  {
    const { page, context } = await open(390, 1400);
    await section(page, "adjust").locator("> summary").click();
    assert.equal(await isOpen(page, "adjust"), true);
    await page.getByRole("slider", { name: "Vibrance" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    assert.match(await section(page, "adjust").locator("> summary").innerText(), /1 changed/);
    await section(page, "presets").locator("> summary").click();
    assert.equal(await isOpen(page, "presets"), false);
    await section(page, "glass").locator('button[data-glass-preset="frosted"]').click();
    assert.match(await section(page, "glass").locator("> summary").innerText(), /Frosted/);
    assert.equal(await page.locator('input[aria-label="Blur"]').isVisible(), false);
    await section(page, "glass").locator('button[data-glass-preset="custom"]').click();
    await page.locator('input[aria-label="Blur"]').waitFor({ state: "visible" });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("gvdg-theme-studio-open")));
    assert.equal(stored.adjust, true);
    assert.equal(stored.presets, false);
    await page.reload({ waitUntil: "commit" });
    await page.locator(".dash-theme-studio").waitFor();
    assert.equal(await isOpen(page, "adjust"), true, "remembered open");
    assert.equal(await isOpen(page, "presets"), false, "remembered closed");
    await context.close();
  }
  // Blocked storage must not break the studio.
  {
    const { page, context, errors } = await open(390, 844, { init: () => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (String(key).startsWith("gvdg-theme-studio")) throw new Error("blocked");
        return original.call(this, key, value);
      };
    } });
    await section(page, "colors").locator("> summary").click();
    assert.equal(await isOpen(page, "colors"), true);
    assert.deepEqual(errors.filter((message) => !/blocked/.test(message)), []);
    await context.close();
  }

  // 3. Real touch: vertical swipe on the Vibrance slider scrolls the page and does not change it;
  //    a horizontal drag on the thumb does.
  {
    const { page, context } = await open(390, 844, { touch: true });
    const session = await context.newCDPSession(page);
    await section(page, "adjust").locator("> summary").tap();
    const slider = page.getByRole("slider", { name: "Vibrance" });
    await slider.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -120));
    await page.waitForTimeout(300);
    const box = await slider.boundingBox();
    assert.ok(box.height >= 43.5, "slider hit area >= 44px: " + box.height);
    const thumbCss = await slider.evaluate((el) => {
      const style = getComputedStyle(el, "::-webkit-slider-thumb");
      return { width: parseFloat(style.width), height: parseFloat(style.height), touchAction: getComputedStyle(el).touchAction };
    });
    assert.equal(thumbCss.touchAction, "pan-y");
    const before = { y: await page.evaluate(() => window.scrollY), value: await slider.inputValue() };
    const x = box.x + box.width * 0.25;
    const y = box.y + box.height / 2;
    // Vertical swipe starting ON the track, away from the thumb (the common mis-fire), then one starting on the thumb.
    const up = Array.from({ length: 12 }, (_, i) => ({ x: x + (i % 2), y: y - i * 12 }));
    await touchSequence(session, up);
    const afterTrack = { y: await page.evaluate(() => window.scrollY), value: await slider.inputValue() };
    const thumbX = box.x + box.width / 2;
    const down = Array.from({ length: 12 }, (_, i) => ({ x: thumbX + (i % 2), y: y + i * 6 }));
    await touchSequence(session, down);
    const afterThumb = { y: await page.evaluate(() => window.scrollY), value: await slider.inputValue() };
    results.vertical = { before, afterTrack, afterThumb };
    assert.ok(Math.abs(afterTrack.y - before.y) > 40, "vertical swipe on the track scrolled the page: " + JSON.stringify(results.vertical));
    assert.equal(afterTrack.value, before.value, "vertical swipe on the track left Vibrance alone");
    assert.notEqual(afterThumb.y, afterTrack.y, "vertical swipe on the thumb scrolled the page");
    assert.equal(afterThumb.value, before.value, "vertical swipe on the thumb left Vibrance alone");

    await slider.scrollIntoViewIfNeeded();
    const box2 = await slider.boundingBox();
    const startX = box2.x + box2.width / 2;
    const startY = box2.y + box2.height / 2;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const right = Array.from({ length: 14 }, (_, i) => ({ x: startX + i * 6, y: startY }));
    await touchSequence(session, right);
    const dragged = { value: await slider.inputValue(), y: await page.evaluate(() => window.scrollY) };
    results.horizontal = { from: before.value, to: dragged.value, scrollDelta: dragged.y - scrollBefore };
    assert.ok(Number(dragged.value) > Number(before.value), "horizontal drag on the thumb changed Vibrance: " + JSON.stringify(results.horizontal));
    assert.ok(Math.abs(dragged.y - scrollBefore) < 4, "horizontal drag did not scroll the page");
    await page.screenshot({ path: join(images, "touch-finetune-390.png"), animations: "disabled" });
    await context.close();
  }

  // Leaving Appearance keeps the saved custom theme on the rest of the app (regression: the studio's unmount
  // used to clear it until the next reload). After Reset, leaving shows the club default.
  {
    const { page, context, errors } = await open(390, 844, { theme: "preset" });
    const themed = () => page.evaluate(() => document.body.classList.contains("player-theme-page"));
    const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(700); };
    assert.equal(await themed(), true, "custom theme painted on Appearance");
    await go("account");
    assert.equal(await themed(), true, "custom theme kept after leaving Appearance for Account");
    await go("home");
    assert.equal(await themed(), true, "custom theme kept on Home");
    await go("appearance");
    await page.locator(".dash-theme-studio").waitFor();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForFunction(() => !document.body.classList.contains("player-theme-page"));
    await go("account");
    assert.equal(await themed(), false, "after Reset, leaving Appearance shows the club default");
    assert.deepEqual(errors.filter((message) => !/blocked/.test(message)), []);
    results.leaveAppearance = "kept theme; Reset leaves club default";
    await context.close();
  }

  // 4. Screenshots: all collapsed, Glass + Custom expanded, desktop.
  for (const mode of ["dark", "light"]) {
    const { page, context } = await open(390, 844, { mode });
    for (const id of ["presets", "glass"]) if (await isOpen(page, id)) await section(page, id).locator("> summary").click();
    await page.locator("[data-react-dashboard-theme]").scrollIntoViewIfNeeded();
    await page.locator("[data-react-dashboard-theme]").screenshot({ path: join(images, "appearance-collapsed-" + mode + "-390.png"), animations: "disabled" });
    await context.close();
  }
  for (const mode of ["dark", "light"]) {
    const { page, context } = await open(390, 1100, { mode });
    await section(page, "glass").locator('button[data-glass-preset="frosted"]').click();
    await section(page, "glass").locator('button[data-glass-preset="custom"]').click();
    await section(page, "glass").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(images, "appearance-glass-custom-" + mode + "-390.png"), animations: "disabled" });
    await context.close();
  }
  {
    const { page, context } = await open(1280, 1000);
    await page.locator("[data-react-dashboard-theme]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(images, "appearance-1280.png"), animations: "disabled" });
    await context.close();
  }
  console.log("theme studio QA passed", JSON.stringify(results), "screenshots in " + images);
} finally {
  await browser.close();
  await vite.close();
}
