// Sitewide glass QA: with Frosted on, the public pages (pro shop, events, home) and the scorecard setup / course-pick
// screens carry neutral glass containers (blur >= 16px, saturate <= 120%, neutral fill, alpha <= 0.6); AA text contrast over a
// bright photo wallpaper has no new misses vs Off; Off has no glass; reduced transparency falls back to solid.
// Run: CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/theme-glass-sitewide-qa.mjs   (needs `npm run build` first)
//   GVDG_SITEWIDE_OFF_DIR=<dir>      write Off full-page screenshots (run it on the baseline checkout)
//   GVDG_SITEWIDE_COMPARE_DIR=<dir>  assert today's Off screenshots are byte-identical to those
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { measureContrast } from "./theme-glass-contrast.mjs";
import { openPage, startSite } from "./theme-glass-sitewide-lib.mjs";

const SCREENS = {
  "pro-shop": { path: "/pro-shop.html", ready: ".product-card", surfaces: ".wallet-panel, .shop-filters, .product-card, .shop-head > :first-child", chrome: true },
  events: { path: "/events.html", ready: ".event-card", surfaces: ".events-intro, .event-card", chrome: true },
  home: { path: "/index.html", ready: "#membership .membership-step", surfaces: "#scoring-app-teaser, #membership, #about", chrome: true },
  "score-keep-score": { path: "/score.html", ready: ".card", surfaces: "#scoreRoot .card, #scoreRoot .install-coach", seed: 'localStorage.setItem("gvdg_recent_rounds", JSON.stringify([{code:"K7M2QX",label:"Sunday Bag Tag"}]))' },
  "score-pick-course": { path: "/score.html", ready: ".card", click: "Start a casual round", after: ".tap-row-main", surfaces: "#scoreRoot .course-filters, #scoreRoot .stack > .tap-row" },
};
const site = await startSite();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

function parseColor(value) {
  const m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)|rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? ?\/? ?([\d.]+))?\)/.exec(value);
  if (!m) return null;
  if (m[1] !== undefined) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : Number(m[4]) };
  return { r: Number(m[5]), g: Number(m[6]), b: Number(m[7]), a: m[8] === undefined ? 1 : Number(m[8]) };
}

async function load(name, options) {
  const screen = SCREENS[name];
  for (let attempt = 0; ; attempt += 1) {
    const opened = await openPage(browser, site.origin, screen.path, { ...options, seed: screen.seed });
    try {
      // A cold dev-server load occasionally misses the window; one reload, then fail for real.
      try { await opened.page.waitForSelector(screen.ready, { state: "attached", timeout: 20_000 }); }
      catch { await opened.page.reload({ waitUntil: "load" }); await opened.page.waitForSelector(screen.ready, { state: "attached", timeout: 30_000 }); }
      if (screen.click) {
        await opened.page.getByRole("button", { name: screen.click }).first().click();
        await opened.page.waitForSelector(screen.after, { state: "attached" });
      }
      await opened.page.evaluate(() => document.fonts.ready);
      await opened.page.waitForTimeout(900);
      return opened;
    } catch (error) {
      await opened.context.close();
      if (attempt >= 2) throw error;
    }
  }
}

async function surfaces(page, selector, chrome) {
  return page.evaluate(({ selector, chrome }) => {
    const read = (el, pseudo) => {
      const s = getComputedStyle(el, pseudo);
      return { label: el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0], filter: s.backdropFilter || s.webkitBackdropFilter || "none", bg: s.backgroundColor };
    };
    const rows = [...document.querySelectorAll(selector)].filter((el) => el.getBoundingClientRect().height > 20 && el.checkVisibility()).map((el) => read(el));
    if (chrome) {
      const header = document.querySelector("#homeReactPageChromeApp > header, #publicReactPageChrome > header");
      if (header) rows.push({ ...read(header, "::before"), label: "header" });
    }
    return rows;
  }, { selector, chrome });
}

const fails = [];
async function check(label, fn) {
  try { await fn(); } catch (error) { fails.push(label + ": " + error.message); console.error("FAIL " + label + ": " + error.message); }
}

const offDir = process.env.GVDG_SITEWIDE_OFF_DIR;
const compareDir = process.env.GVDG_SITEWIDE_COMPARE_DIR;
if (offDir) await mkdir(offDir, { recursive: true });

try {
  for (const mode of ["dark", "light"]) {
    for (const [name, screen] of Object.entries(SCREENS)) {
      // Off: no glass class, no backdrop blur on the surfaces, optionally byte-identical to the baseline.
      const offBase = new Set();
      {
        const { page, context, errors } = await load(name, { glass: "off", mode });
        await check(name + " " + mode + " off", async () => {
          assert.equal(await page.evaluate(() => document.body.classList.contains("player-theme-glass")), false);
          for (const row of await surfaces(page, screen.surfaces, false)) {
            if (row.label.startsWith("aside.install-coach") || /^(div|section)\.card/.test(row.label)) continue; // score.html's own themed blur(10px)
            assert.equal(row.filter, "none", name + " Off " + row.label + " has backdrop-filter " + row.filter);
          }
          assert.deepEqual(errors, []);
        });
        const shotPath = name + "-" + mode + "-off.png";
        const shot = await page.screenshot({ animations: "disabled", fullPage: false });
        if (offDir) await writeFile(join(offDir, shotPath), shot);
        if (compareDir) await check(name + " " + mode + " off pixel-identical", async () => {
          const before = await readFile(join(compareDir, shotPath));
          assert.ok(before.equals(shot), "Off screenshot differs from the baseline (" + shotPath + ")");
        });
        for (const f of await measureContrast(page, "body")) offBase.add(f.split("|")[0]);
        await context.close();
      }
      if (offDir) continue;
      // Frosted: neutral blurred containers, AA no worse than Off.
      for (const kind of ["photo", "default"]) {
        const { page, context, errors } = await load(name, { glass: "frosted", mode, kind });
        await check(name + " " + mode + " " + kind + " frosted", async () => {
          assert.equal(await page.evaluate(() => document.body.classList.contains("player-theme-glass")), true, "glass class");
          const rows = await surfaces(page, screen.surfaces, screen.chrome);
          assert.ok(rows.length >= 2, "glassed containers found: " + rows.length);
          for (const row of rows) {
            const blur = Number(/blur\(([\d.]+)px\)/.exec(row.filter)?.[1]);
            assert.ok(blur >= 16, row.label + " blur >= 16px: " + row.filter);
            const sat = Number(/saturate\(([\d.]+)(%?)\)/.exec(row.filter)?.[1]);
            assert.ok(sat > 0 && (sat <= 1.2 || (sat > 5 && sat <= 120)), row.label + " saturate <= 120%: " + row.filter);
            const color = parseColor(row.bg);
            assert.ok(color && color.a <= 0.6 && color.a > 0.39, row.label + " fill alpha in (0.39, 0.6]: " + row.bg);
            assert.ok(Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 12, row.label + " fill is neutral: " + row.bg);
          }
          assert.deepEqual(errors, []);
        });
        if (kind === "photo") {
          await check(name + " " + mode + " AA over photo", async () => {
            const misses = (await measureContrast(page, "body")).filter((f) => !offBase.has(f.split("|")[0]));
            assert.deepEqual(misses, [], "new AA misses vs Off");
          });
        }
        await context.close();
      }
      // Reduced transparency falls back to solid (same as Off: no blur on the surfaces).
      {
        const { page, context } = await load(name, { glass: "frosted", mode, reducedTransparency: true });
        await check(name + " " + mode + " reduced transparency", async () => {
          for (const row of await surfaces(page, screen.surfaces, screen.chrome)) {
            if (row.label.startsWith("aside.install-coach") || /^(div|section)\.card/.test(row.label)) continue;
            assert.equal(row.filter, "none", row.label + " keeps backdrop-filter under reduced transparency: " + row.filter);
            assert.ok(parseColor(row.bg).a >= 0.85 || row.label === "header" || row.label.startsWith("div.course-filters"), row.label + " is solid: " + row.bg);
          }
        });
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await site.close();
}
if (fails.length) {
  console.error("theme glass sitewide QA failed:\n" + fails.join("\n"));
  process.exit(1);
}
console.log(offDir ? "Off screenshots written to " + offDir : "theme glass sitewide QA passed");
