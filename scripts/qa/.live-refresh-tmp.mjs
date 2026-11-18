import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const [oldSwPath, mbps, rttMs] = process.argv.slice(2);
const oldSw = await readFile(oldSwPath, "utf8");
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const log = [];
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
// 1. The phone is on the previous release: its service worker (v304) and its page.
await context.route(/gvdgclub\.com\/sw\.js(\?.*)?$/, (route) => route.fulfill({ contentType: "text/javascript", body: oldSw }));
const stampOld = async (route) => {
  if (route.request().method() !== "GET") return route.continue();
  const response = await route.fetch();
  const html = (await response.text()).replace(/name="gvdg-build" content="[0-9a-f]{40}"/, 'name="gvdg-build" content="b71570bab426cab29484cd93b0355c496397cc8d"');
  await route.fulfill({ response, body: html });
};
await context.route(/gvdgclub\.com\/gvdg-members(\.html)?(\?[^#]*)?$/, stampOld);
await page.goto("https://gvdgclub.com/gvdg-members", { waitUntil: "load" });
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 60000 });
log.push(at() + " old worker in control: " + await page.evaluate(async () => (await caches.keys()).join(",")));
// 2. The new release is published: sw.js is the live v305 again. Slow the network to a phone's.
await context.unroute(/gvdgclub\.com\/sw\.js(\?.*)?$/);
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: Number(rttMs), downloadThroughput: Number(mbps) * 125000, uploadThroughput: 750000 / 8 * 1000 / 1000 * 1000 });
page.on("console", (m) => { if (m.type() === "error") log.push(at() + " console.error: " + m.text().slice(0, 160)); });
await page.reload({ waitUntil: "load" });
const refresh = page.locator(".pwa-update-refresh");
await refresh.waitFor({ timeout: 60000 });
log.push(at() + " banner shown; workers: " + JSON.stringify(await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { installing: r?.installing?.state, waiting: r?.waiting?.state, active: r?.active?.state }; })));
await refresh.click();
log.push(at() + " tapped Refresh");
const watch = setInterval(async () => {
  const text = await page.locator(".pwa-update p").innerText().catch(() => "");
  if (text) log.push(at() + " card: " + text);
}, 2000);
await page.evaluate(() => { window.__sameDocument = true; });
const outcome = await Promise.race([
  page.waitForFunction(() => !window.__sameDocument, null, { timeout: 40000, polling: 200 }).then(() => "RELOADED (new document)"),
  page.getByText("Couldn’t refresh the app", { exact: false }).waitFor({ timeout: 40000 }).then(() => "ERROR: Couldn't refresh"),
]).catch(() => "neither in 40s");
clearInterval(watch);
log.push(at() + " outcome: " + outcome);
log.push(at() + " workers now: " + JSON.stringify(await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { installing: r?.installing?.state, waiting: r?.waiting?.state, active: r?.active?.state, controller: !!navigator.serviceWorker.controller }; }).catch(() => "n/a")));
console.log(log.join("\n"));
await browser.close();
