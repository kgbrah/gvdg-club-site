// Glass theme QA for the scorecard: frosted header / weather / stats / hole strip / tools dock over a photo
// wallpaper, with the score-entry dock held >= 85% opaque, AA text contrast, and solid fallbacks.
// Boots the scorer fixture (scorer-polish-browser-qa.mjs in serve mode) as a child process.
// Run: CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/theme-glass-scorer-qa.mjs   (GVDG_GLASS_SHOTS=<dir> keeps screenshots)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { GLASS_PRESETS, buildTheme } from "../../src/shared/dashboard-theme-model.js";
import { measureContrast } from "./theme-glass-contrast.mjs";

const port = Number(process.env.GVDG_GLASS_SCORER_PORT || 5302);
const images = process.env.GVDG_GLASS_SHOTS || join(tmpdir(), "gvdg-glass-qa");
await mkdir(images, { recursive: true });
const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide5.jpg")).toString("base64");

function themeFor(glass, mode) {
  const custom = /^(\d+)-(\d+)$/.exec(glass);
  const preset = custom ? { opacity: Number(custom[1]), blur: Number(custom[2]) } : GLASS_PRESETS[glass] || GLASS_PRESETS.off;
  return buildTheme({ mode, preset: "Frost", wallpaper, glass: preset });
}

const server = spawn(process.execPath, ["scripts/qa/scorer-polish-browser-qa.mjs"], {
  env: { ...process.env, GVDG_SCORER_SERVE: "1", GVDG_SCORER_BOTTOM: "1", GVDG_SCORER_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
const origin = "http://127.0.0.1:" + port;
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("scorer fixture did not start")), 90_000);
  server.stdout.on("data", (chunk) => { if (String(chunk).includes("Preview scorecard")) { clearTimeout(timer); resolve(); } });
  server.on("exit", () => reject(new Error("scorer fixture exited")));
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

async function open(glass, mode, { reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.route("**/qa-api/me/dashboard-theme", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ theme: glass === "none" ? null : themeFor(glass, mode) }),
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (reduced) {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  }
  await page.goto(origin + "/score.html?round=GVDG44&appearance=" + mode, { waitUntil: "commit" });
  await page.waitForSelector("body.score-glove.player-theme-active");
  await page.locator(".score-glove-dock .stepper").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  // The satellite imagery is fetched live; wait for it so screenshots and pixel checks never catch a grey frame.
  await page.locator(".hole-map-satellite").first().evaluate((image) => image.decode()).catch(() => {});
  await page.waitForTimeout(600);
  return { page, context, errors };
}

const alpha = (value) => {
  const m = /[\d.]+/g;
  const parts = value.match(m).map(Number);
  if (value.startsWith("color(")) return parts.length > 3 ? parts[3] : 1;
  return parts.length > 3 ? parts[3] : 1;
};

try {
  for (const mode of ["dark", "light"]) {
    for (const glass of ["off", "frosted"]) {
      const { page, context, errors } = await open(glass === "off" ? "off" : glass, mode);
      const state = await page.evaluate(() => ({
        glass: document.body.classList.contains("player-theme-glass"),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      assert.equal(state.glass, glass === "frosted");
      assert.equal(state.overflow, false);
      await page.screenshot({ path: join(images, "scorecard-" + glass + "-" + mode + "-390.png"), animations: "disabled" });
      assert.deepEqual(errors, []);
      await context.close();
    }
  }

  // The map and its controls are never glassed or tinted: the map frame renders the same pixels with glass Off
  // and Frosted in both themes, and no ancestor of the imagery carries a filter.
  for (const mode of ["dark", "light"]) {
    const shots = {};
    for (const glass of ["off", "frosted", "60-24"]) {
      const { page, context } = await open(glass, mode);
      const chain = await page.evaluate(() => {
        const out = [];
        for (let el = document.querySelector(".hole-map-satellite"); el && el !== document.body; el = el.parentElement) {
          const s = getComputedStyle(el);
          if ((s.backdropFilter && s.backdropFilter !== "none") || (s.filter && s.filter !== "none")) out.push(el.className);
        }
        return out;
      });
      assert.deepEqual(chain, [], "no filter on the map ancestors (" + glass + " " + mode + ")");
      const naturalWidth = await page.locator(".hole-map-satellite").first().evaluate((image) => image.naturalWidth);
      assert.ok(naturalWidth > 0, "satellite tiles loaded (" + glass + " " + mode + ")");
      shots[glass] = (await page.locator(".hole-map-frame").first().screenshot({ animations: "disabled" })).toString("base64");
      if (glass !== "off") {
        const diff = await page.evaluate(async ([a, b]) => {
          const load = (data) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = "data:image/png;base64," + data; });
          const [one, two] = await Promise.all([load(a), load(b)]);
          const read = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
          const da = read(one); const db = read(two);
          let total = 0;
          for (let i = 0; i < da.length; i += 4) total += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
          return { size: [one.width, one.height, two.width, two.height], mean: total / (da.length / 4 * 3) };
        }, [shots.off, shots[glass]]);
        assert.deepEqual(diff.size.slice(0, 2), diff.size.slice(2), "map frame size unchanged " + glass + " " + mode);
        assert.ok(diff.mean < 1, "map pixels identical with glass " + glass + " vs Off (" + mode + "): mean diff " + diff.mean.toFixed(2));
      }
      await context.close();
    }
  }

  // Surfaces carry the blur; the dock and score rows stay solid enough; no layout shift vs Off.
  for (const mode of ["dark", "light"]) {
    const layout = {};
    for (const glass of ["off", "frosted", "clear", "60-24"]) {
      const { page, context } = await open(glass, mode);
      const read = await page.evaluate(() => {
        const style = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const s = getComputedStyle(el);
          return { filter: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundColor, radius: s.borderTopLeftRadius, padL: parseFloat(s.paddingLeft), top: Math.round(el.getBoundingClientRect().top), height: Math.round(el.getBoundingClientRect().height) };
        };
        return {
          header: style("#scoreRoot .topbar"), weather: style(".scorecard-weather"), stats: style(".score-advanced"),
          holes: style(".score-glove-stage .score-holestrip"), strip: style(".score-glove-stage .holegrid"), dock: style(".score-glove-dock"),
          minus: style(".score-glove-dock .stepper .minus"), plus: style(".score-glove-dock .stepper .plus"),
          nav: style(".score-glove-dock .navbtn"),
        };
      });
      layout[glass] = ["header", "weather", "stats", "holes", "dock"].map((key) => read[key].top + ":" + read[key].height).join(",");
      if (glass !== "off") {
        for (const key of ["header", "weather", "stats", "holes", "dock"]) {
          assert.match(read[key].filter, /blur\(/, key + " blurs (" + glass + " " + mode + "): " + read[key].filter);
        }
        const dockAlpha = alpha(read.dock.bg);
        assert.ok(dockAlpha >= 0.699, "dock is at most 30% see-through at " + glass + ": " + read.dock.bg);
        const dockBlur = Number(/blur\(([\d.]+)px\)/.exec(read.dock.filter)?.[1]);
        const panelBlur = Number(/blur\(([\d.]+)px\)/.exec(read.stats.filter)?.[1]);
        assert.ok(dockBlur >= panelBlur && dockBlur >= 16, "dock blur is strong at " + glass + ": " + read.dock.filter);
        assert.ok(alpha(read.header.bg) < 0.99, "top bar is glass at " + glass + " " + mode + ": " + read.header.bg);
        assert.ok(Math.abs(parseFloat(read.weather.radius) - parseFloat(read.stats.radius)) < 0.5 && parseFloat(read.weather.radius) >= 12, "weather, stats and hole strip share the panel radius: " + [read.weather.radius, read.stats.radius, read.holes.radius]);
        assert.equal(read.holes.radius, read.stats.radius, "hole strip radius");
        assert.ok(read.stats.padL >= 6 && read.strip.padL >= 6, "stats row and hole strip keep inner padding: " + [read.stats.padL, read.holes.padL]);
        for (const key of ["minus", "plus", "nav"]) assert.ok(alpha(read[key].bg) >= 0.99, key + " stays solid: " + read[key].bg);
        const weatherAlpha = alpha(read.weather.bg);
        assert.ok(weatherAlpha < 0.99, "weather strip is translucent: " + read.weather.bg);
      }
      await context.close();
    }
    for (const glass of ["frosted", "clear", "60-24"]) assert.equal(layout[glass], layout.off, "no layout shift " + glass + " " + mode);
  }

  // Text contrast over the bright wallpaper, even at the most see-through setting.
  for (const mode of ["dark", "light"]) {
    const baseline = new Set();
    for (const glass of ["off", "frosted", "clear", "60-0"]) {
      const { page, context } = await open(glass, mode);
      const fails = await measureContrast(page, "#scoreRoot", { top: 0, bottomInset: 0 });
      const key = (f) => f.split("|")[0];
      if (glass === "off") {
        fails.forEach((f) => baseline.add(key(f)));
        console.log("  base-AA misses (scorecard " + mode + "): " + (fails.join("; ") || "none"));
      } else {
        assert.deepEqual(fails.filter((f) => !baseline.has(key(f))), [], "scorecard AA " + mode + " " + glass);
      }
      await context.close();
    }
  }

  // Solid fallback with reduced transparency.
  {
    const { page, context } = await open("frosted", "dark", { reduced: true });
    const solid = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector(".scorecard-weather"));
      return { filter: s.backdropFilter, bg: s.backgroundColor };
    });
    assert.equal(solid.filter, "none");
    assert.ok(alpha(solid.bg) >= 0.99, "reduced transparency is solid: " + solid.bg);
    await context.close();
  }
  console.log("theme glass scorecard QA passed; screenshots in " + images);
} finally {
  await browser.close();
  server.kill();
}
