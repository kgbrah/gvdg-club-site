// Builds Off | Frosted | Clear side-by-side strips for the glass work (member Home, Club + dialog, header, scorecard).
// Run: CHROMIUM_PATH=/usr/bin/chromium GVDG_SHOTS_OUT=<dir> node scripts/qa/theme-glass-shots.mjs
// Starts the member glass QA fixture in serve mode (GVDG_GLASS_SERVE) and the scorer fixture as child processes.
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

import { GLASS_PRESETS, buildTheme } from "../../src/shared/dashboard-theme-model.js";

const out = process.env.GVDG_SHOTS_OUT || "/tmp/gvdg-glass-shots";
await mkdir(out, { recursive: true });
function boot(file, env, ready) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(file + " did not start")), 90_000);
    child.stdout.on("data", (chunk) => { const m = ready(String(chunk)); if (m) { clearTimeout(timer); resolve({ child, m }); } });
  });
}
const member = await boot("scripts/qa/theme-glass-qa.mjs", { GVDG_GLASS_SERVE: "1", GVDG_GLASS_PORT: "5391" }, (t) => /http:\/\/\S+member-glass\.html/.exec(t)?.[0]);
const scorer = await boot("scripts/qa/scorer-polish-browser-qa.mjs", { GVDG_SCORER_SERVE: "1", GVDG_SCORER_BOTTOM: "1", GVDG_SCORER_PORT: "5392" }, (t) => t.includes("Preview scorecard") || null);
const base = member.m.split("/member-glass.html")[0];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const GLASS = ["off", "frosted", "clear"];
const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide5.jpg")).toString("base64");

async function shot(glass, { mode, route, wp = "slide5", pal = "", prep, clip }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.route(/^https?:/, (r) => /127\.0\.0\.1|localhost/.test(new URL(r.request().url()).host) ? r.continue() : r.abort());
  const page = await context.newPage();
  await page.goto(base + "/member-glass.html?glass=" + glass + "&mode=" + mode + "&wp=" + wp + (pal ? "&pal=" + pal : "") + "#" + route, { waitUntil: "commit" });
  await page.waitForSelector(wp === "default" ? "body[data-member-shell]" : "body.player-theme-active");
  await page.locator(".player-home, #members").first().waitFor();
  await page.waitForTimeout(700);
  if (prep) await prep(page);
  const buf = await page.screenshot({ animations: "disabled", clip });
  await context.close();
  return buf;
}
async function scorecard(glass, mode) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const theme = buildTheme({ mode, preset: "Frost", wallpaper, glass: GLASS_PRESETS[glass] });
  await context.route("**/qa-api/me/dashboard-theme", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ theme }) }));
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:5392/score.html?round=GVDG44&appearance=" + mode, { waitUntil: "commit" });
  await page.waitForSelector("body.score-glove.player-theme-active");
  await page.locator(".score-glove-dock .stepper").first().waitFor();
  await page.locator(".hole-map-satellite").first().evaluate((i) => i.decode()).catch(() => {});
  await page.waitForTimeout(800);
  const buf = await page.screenshot({ animations: "disabled" });
  await context.close();
  return buf;
}
async function strip(name, bufs, labels, height = 880) {
  const page = await browser.newPage({ viewport: { width: 390 * bufs.length + 12 * (bufs.length + 1), height } });
  const imgs = bufs.map((b, i) => `<figure><img src="data:image/png;base64,${b.toString("base64")}"><figcaption>${labels[i]}</figcaption></figure>`).join("");
  await page.setContent(`<body style="margin:0;background:#222;display:flex;gap:12px;padding:12px;font:600 14px sans-serif;color:#fff"><style>figure{margin:0}img{display:block;width:390px}figcaption{text-align:center;padding-top:6px}</style>${imgs}</body>`);
  await page.screenshot({ path: join(out, name + ".png"), fullPage: true });
  await page.close();
  console.log(join(out, name + ".png"));
}
const labels = ["Off", "Frosted", "Clear"];
for (const mode of ["dark", "light"]) {
  await strip("home-photo-" + mode, await Promise.all(GLASS.map((g) => shot(g, { mode, route: "home" }))), labels);
  await strip("home-forest-" + mode, await Promise.all(GLASS.map((g) => shot(g, { mode, route: "home", wp: "default" }))), labels);
}
await strip("home-warm-dark", await Promise.all(GLASS.map((g) => shot(g, { mode: "dark", route: "home", pal: "warm" }))), labels);
await strip("home-warm-light", await Promise.all(GLASS.map((g) => shot(g, { mode: "light", route: "home", pal: "warm" }))), labels);
const dialog = async (page) => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<div class="member-dialog-overlay active"><div class="member-dialog" role="dialog"><div class="member-dialog-title">Report course conditions?</div><p class="member-dialog-message">Let the club know about fallen trees, flooding or closures. Reports expire after 48 hours.</p><div class="member-dialog-actions"><button class="member-dialog-btn secondary">Cancel</button><button class="member-dialog-btn">Send report</button></div></div></div>');
  });
  await page.waitForTimeout(200);
};
await strip("club-dialog-dark", await Promise.all(GLASS.map((g) => shot(g, { mode: "dark", route: "club-hub", prep: dialog }))), labels);
await strip("club-dialog-light", await Promise.all(GLASS.map((g) => shot(g, { mode: "light", route: "club-hub", prep: dialog }))), labels);
await strip("scorecard-dark", await Promise.all(GLASS.map((g) => scorecard(g, "dark"))), labels);
const clip = { x: 0, y: 0, width: 390, height: 300 };
const bars = [
  await shot("off", { mode: "dark", route: "home", wp: "default", clip }),
  await shot("off", { mode: "light", route: "home", pal: "warm", clip }),
  await shot("off", { mode: "dark", route: "home", pal: "warm", clip }),
  await shot("frosted", { mode: "light", route: "home", pal: "warm", clip }),
  await shot("frosted", { mode: "dark", route: "home", pal: "warm", clip }),
];
await strip("topbar-themes", bars, ["No theme", "Light theme", "Dark theme", "Light + Frosted", "Dark + Frosted"], 340);
await browser.close();
member.child.kill();
scorer.child.kill();
process.exit(0);
