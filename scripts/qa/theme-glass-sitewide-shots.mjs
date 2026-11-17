// Off | Frosted strips for the sitewide glass work. Run: CHROMIUM_PATH=/usr/bin/chromium GVDG_SHOTS_OUT=<dir> node scripts/qa/theme-glass-sitewide-shots.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { openPage, startSite } from "./theme-glass-sitewide-lib.mjs";

const out = process.env.GVDG_SHOTS_OUT || "/tmp/gvdg-glass-sitewide-shots";
await mkdir(out, { recursive: true });
const site = await startSite();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
export const SCREENS = {
  "pro-shop": { path: "/pro-shop.html", ready: ".product-card" },
  events: { path: "/events.html", ready: ".event-card" },
  home: { path: "/index.html", ready: "#membership .membership-step", scroll: "#scoring-app-teaser" },
  "score-keep-score": { path: "/score.html", ready: ".card", seed: 'localStorage.setItem("gvdg_recent_rounds", JSON.stringify([{code:"K7M2QX",label:"Sunday Bag Tag"}]))' },
  "score-pick-course": { path: "/score.html", ready: ".card", click: "Start a casual round" },
};
async function shot(name, glass, mode, kind = "photo") {
  const s = SCREENS[name];
  const { page, context } = await openPage(browser, site.origin, s.path, { glass, mode, kind, seed: s.seed });
  await page.waitForSelector(s.ready, { state: "attached" });
  if (s.click) { await page.getByRole("button", { name: s.click }).first().click(); await page.waitForSelector(".tap-row-main"); }
  if (s.scroll) await page.locator(s.scroll).scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  const buf = await page.screenshot({ animations: "disabled" });
  await context.close();
  return buf;
}
const modes = (process.env.GVDG_SHOTS_MODES || "dark,light").split(",");
const only = process.env.GVDG_SHOTS_ONLY?.split(",");
for (const mode of modes) for (const name of Object.keys(SCREENS)) {
  if (only && !only.includes(name)) continue;
  const bufs = [await shot(name, "off", mode), await shot(name, "frosted", mode)];
  const page = await browser.newPage({ viewport: { width: 390 * 2 + 36, height: 880 } });
  const imgs = bufs.map((b, i) => `<figure><img src="data:image/png;base64,${b.toString("base64")}"><figcaption>${["Off", "Frosted"][i]}</figcaption></figure>`).join("");
  await page.setContent(`<body style="margin:0;background:#222;display:flex;gap:12px;padding:12px;font:600 14px sans-serif;color:#fff"><style>figure{margin:0}img{display:block;width:390px}figcaption{text-align:center;padding-top:6px}</style>${imgs}</body>`);
  const file = join(out, name + "-" + mode + ".png");
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  console.log(file);
}
await browser.close(); await site.close();
