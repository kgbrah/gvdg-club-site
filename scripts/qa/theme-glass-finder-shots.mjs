// "Find a tool" strips (member Club page): Off | Frosted at 390 over a photo wallpaper, dark and light, plus a warm custom theme.
// Needs the member glass fixture running: GVDG_GLASS_SERVE=1 GVDG_GLASS_PORT=5421 node scripts/qa/theme-glass-qa.mjs
// Run: CHROMIUM_PATH=/usr/bin/chromium GVDG_SHOTS_OUT=<dir> node scripts/qa/theme-glass-finder-shots.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const base = "http://127.0.0.1:" + (process.env.GVDG_GLASS_PORT || 5421) + "/member-glass.html";
const out = process.env.GVDG_SHOTS_OUT || "/tmp/gvdg-finder-shots";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
async function shot(glass, mode, pal = "") {
  const context = await browser.newContext({ viewport: { width: 390, height: 520 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.route(/^https?:/, (r) => /127\.0\.0\.1/.test(new URL(r.request().url()).host) ? r.continue() : r.abort());
  const page = await context.newPage();
  await page.goto(base + "?glass=" + glass + "&mode=" + mode + "&wp=slide5" + (pal ? "&pal=" + pal : "") + "#more", { waitUntil: "commit" });
  await page.locator(".app-tool-finder input").waitFor();
  await page.waitForTimeout(800);
  const input = page.locator(".app-tool-finder input");
  const height = (await input.boundingBox()).height;
  if (height < 43.5 || height > 56) throw new Error("Find a tool input height " + height);
  await page.getByRole("searchbox", { name: "Find a tool" }).fill("bag");
  await page.waitForTimeout(300);
  const buf = await page.screenshot({ animations: "disabled" });
  await context.close();
  return buf;
}
for (const [mode, pal] of [["dark", ""], ["light", ""], ["dark", "warm"]]) {
  const bufs = [await shot("off", mode, pal), await shot("frosted", mode, pal)];
  const page = await browser.newPage({ viewport: { width: 816, height: 560 } });
  await page.setContent(`<body style="margin:0;background:#222;display:flex;gap:12px;padding:12px;font:600 14px sans-serif;color:#fff"><style>figure{margin:0}img{display:block;width:390px}figcaption{text-align:center;padding-top:6px}</style>${bufs.map((b, i) => `<figure><img src="data:image/png;base64,${b.toString("base64")}"><figcaption>${["Off", "Frosted"][i]}</figcaption></figure>`).join("")}</body>`);
  const file = join(out, "club-find-a-tool-" + mode + (pal ? "-" + pal : "") + ".png");
  await page.screenshot({ path: file });
  console.log(file);
  await page.close();
}
await browser.close();
