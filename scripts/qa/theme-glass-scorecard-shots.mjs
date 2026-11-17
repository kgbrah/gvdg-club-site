// Active-round scorecard strips: Off | Frosted | Clear at 375 and 390, dark and light, plus crops of the stats row and hole strip edges.
// Needs the scorer fixture: GVDG_SCORER_SERVE=1 GVDG_SCORER_BOTTOM=1 GVDG_SCORER_PORT=5442 node scripts/qa/scorer-polish-browser-qa.mjs
// Run: CHROMIUM_PATH=/usr/bin/chromium GVDG_SHOTS_OUT=<dir> node scripts/qa/theme-glass-scorecard-shots.mjs
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { GLASS_PRESETS, buildTheme } from "../../src/shared/dashboard-theme-model.js";

const base = "http://127.0.0.1:" + (process.env.GVDG_SCORER_PORT || 5442);
const out = process.env.GVDG_SHOTS_OUT || "/tmp/gvdg-scorecard-shots";
await mkdir(out, { recursive: true });
const wallpaper = "data:image/jpeg;base64," + (await readFile(process.env.GVDG_WALLPAPER || "img/slide5.jpg")).toString("base64");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
async function shot(glass, mode, width) {
  const context = await browser.newContext({ viewport: { width, height: 812 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const theme = buildTheme({ mode, preset: "Frost", wallpaper, glass: GLASS_PRESETS[glass] });
  await context.route("**/qa-api/me/dashboard-theme", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ theme }) }));
  const page = await context.newPage();
  await page.goto(base + "/score.html?round=GVDG44&appearance=" + mode, { waitUntil: "commit" });
  await page.waitForSelector("body.score-glove.player-theme-active");
  await page.locator(".score-glove-dock .stepper").first().waitFor();
  await page.locator(".hole-map-satellite").first().evaluate((i) => i.decode()).catch(() => {});
  await page.waitForTimeout(900);
  const full = await page.screenshot({ animations: "disabled" });
  const crops = {};
  for (const [key, selector] of [["stats", ".score-advanced"], ["holes", ".score-glove-stage .holegrid"]]) {
    const box = await page.locator(selector).first().boundingBox();
    if (box) crops[key] = await page.screenshot({ animations: "disabled", clip: { x: 0, y: Math.max(0, box.y - 8), width, height: Math.min(box.height + 16, 812 - Math.max(0, box.y - 8)) } });
  }
  await context.close();
  return { full, ...crops };
}
async function strip(name, bufs, labels, width, height) {
  const page = await browser.newPage({ viewport: { width: width * bufs.length + 12 * (bufs.length + 1), height } });
  await page.setContent(`<body style="margin:0;background:#222;display:flex;gap:12px;padding:12px;font:600 14px sans-serif;color:#fff"><style>figure{margin:0}img{display:block;width:${width}px}figcaption{text-align:center;padding-top:6px}</style>${bufs.map((b, i) => `<figure><img src="data:image/png;base64,${b.toString("base64")}"><figcaption>${labels[i]}</figcaption></figure>`).join("")}</body>`);
  await page.screenshot({ path: join(out, name + ".png"), fullPage: true });
  await page.close();
  console.log(join(out, name + ".png"));
}
const glasses = ["off", "frosted", "clear"];
for (const mode of ["dark", "light"]) for (const width of [375, 390]) {
  const shots = [];
  for (const glass of glasses) shots.push(await shot(glass, mode, width));
  await strip("scorecard-" + mode + "-" + width, shots.map((s) => s.full), ["Off", "Frosted", "Clear"], width, 850);
  if (width === 375) for (const key of ["stats", "holes"]) {
    const set = shots.map((s) => s[key]).filter(Boolean);
    if (set.length === glasses.length) await strip("scorecard-" + key + "-edges-" + mode, set, ["Off", "Frosted", "Clear"], width, 160);
  }
}
await browser.close();
