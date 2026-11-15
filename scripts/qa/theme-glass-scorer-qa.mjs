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
          return { filter: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundColor, top: Math.round(el.getBoundingClientRect().top), height: Math.round(el.getBoundingClientRect().height) };
        };
        return {
          header: style("#scoreRoot .topbar"), weather: style(".scorecard-weather"), stats: style(".score-advanced"),
          holes: style(".score-glove-stage .holegrid"), dock: style(".score-glove-dock"),
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
        assert.ok(dockAlpha >= 0.849, "dock stays >= 85% opaque at " + glass + ": " + read.dock.bg);
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
