// A members-app screen whose code fails to load (the app was updated while the page was open, or the network blinked
// mid-deploy - the owner hit "This screen didn't load" on Account right after a deploy):
//   - online: the app reloads once by itself and the screen opens (same screen: the route is in the URL)
//   - still failing: one reload only, then the message; "Try again" reloads
// Serves the built site and mocks the Worker.
//   npm run build && GVDG_QA_NO_SANDBOX=1 node scripts/qa/screen-load-recovery-browser-qa.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"], [".webmanifest", "application/manifest+json"]]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.join(repoRoot, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(repoRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": (mime.get(path.extname(file)) || "application/octet-stream") + "; charset=utf-8" });
    response.end(body);
  } catch { response.writeHead(404); response.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});
const errors = [];
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const token = `${b64({ alg: "HS256" })}.${b64({ sub: "member-1", iat: now, exp: now + 2592000 })}.sig`;

async function scenario(failures) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await installMemberDashboardApiRoutes(page, "http://127.0.0.1:8788");
  await page.addInitScript((t) => localStorage.setItem("gvdg_member_token", t), token);
  // The Account screen's code fails the first `failures` times it's asked for.
  let asked = 0;
  await page.route(/\/members-app\/chunks\/more-page-[^/]+\.js/, (route) => (asked++ < failures ? route.abort("connectionreset") : route.continue()));
  let loads = 0;
  page.on("load", () => { loads += 1; });
  await page.goto(`${origin}/gvdg-members.html`);
  await page.waitForFunction(() => document.body.dataset.memberShell === "members");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab: "account" } })));
  return { context, page, asked: () => asked, loads: () => loads };
}

// A blip: one failure, one automatic reload, and the Account screen opens.
{
  const { context, page, asked, loads } = await scenario(1);
  await page.getByRole("heading", { name: "Account", level: 1 }).waitFor();
  await page.locator("[data-react-account-page], .member-account-page, [data-member-account]").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".member-panel-load-error") && !document.querySelector("[data-member-panel-loading]"));
  assert.equal(await page.locator(".member-panel-load-error").count(), 0, "the screen opened after the reload");
  assert.ok(loads() >= 2, "the app reloaded itself");
  assert.ok(asked() >= 2, "the code was asked for again");
  assert.match(page.url(), /account/i, "the reload came back to Account");
  await context.close();
  console.log("Blip: reloaded once by itself, Account opened");
}

// Still failing: one automatic reload only, then the message; Try again reloads.
{
  const { context, page, loads } = await scenario(1000);
  await page.locator(".member-panel-load-error").waitFor();
  await page.waitForTimeout(1500);
  assert.equal(loads(), 2, "exactly one automatic reload, no loop");
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction((n) => performance.getEntriesByType("navigation").length > 0 && document.readyState === "complete", null);
  await page.waitForTimeout(1500);
  assert.equal(loads(), 3, "Try again reloads");
  await context.close();
  console.log("Outage: one automatic reload, then the message; Try again reloads");
}

await browser.close();
server.close();
assert.deepEqual(errors, [], "page errors: " + errors.join(" | "));
console.log("PASS screen-load-recovery-browser-qa");
