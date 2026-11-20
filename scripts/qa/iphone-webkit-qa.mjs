// iPhone QA in WebKit (Safari's engine), as the installed home-screen app.
// Owner: "Need you to do an apple iPhone focused QA. Android is working well but an apple user had a blank white
// screen when opening the app after refusing the add email prompt."
//   - a new account's required email step: Sign out, then open the app again; or close the app on the email step and
//     open it again: never a blank screen
//   - an account from before the email step: straight to Home with the reminder; Cancel on the email screen
//   - Home and every tab, and the public pages (home, events, Lost & Found, pro shop, the app page, scoring)
//   - the start-up safety net: a page whose app never starts shows "GVDG didn't open properly" with Reload
// Each check fails on a blank screen (no visible text in the app) or a page error. Screenshots: GVDG_IPHONE_SHOTS.
//   npm run build && npx playwright install --with-deps webkit && node scripts/qa/iphone-webkit-qa.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiBase = "http://127.0.0.1:8788";
const shots = process.env.GVDG_IPHONE_SHOTS || path.join(os.tmpdir(), "gvdg-iphone-shots-" + process.pid);
await mkdir(shots, { recursive: true });
const iphone = devices["iPhone 15"] || devices["iPhone 13"];

const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".jpg", "image/jpeg"], [".svg", "image/svg+xml"], [".webp", "image/webp"], [".webmanifest", "application/manifest+json"], [".woff2", "font/woff2"]]);
let breakApp = false; // the safety-net check: the members bundle never arrives
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (breakApp && rel.startsWith("/members-app/")) { response.writeHead(404); response.end(); return; }
    const file = path.join(repoRoot, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(repoRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": (mime.get(path.extname(file)) || "application/octet-stream") + "; charset=utf-8" });
    response.end(body);
  } catch { response.writeHead(404); response.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// WebKit (Safari's engine) in CI; GVDG_QA_ENGINE=chromium checks the suite itself on machines without WebKit's libraries.
const engine = process.env.GVDG_QA_ENGINE === "chromium" ? chromium : webkit;
const browser = await engine.launch(engine === chromium && process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {});
const failures = [];
const json = (data, status = 200) => ({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(data) });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (iat, sub = "m_80024") => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, iat })}.sig`;
const nowSec = () => Math.floor(Date.now() / 1000);
const member = { name: "Jordan Parker", pdgaNo: "80024", udisc: null, photo: null, isAdmin: false, mustChangePin: false, welcome: false, membership: null };

/** The installed app on an iPhone: iPhone Safari's user agent and screen, and navigator.standalone. */
async function newPage({ token = "", dark = false } = {}) {
  const { defaultBrowserType, ...device } = iphone;
  const context = await browser.newContext({ ...device, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message + (process.env.GVDG_QA_STACKS ? "\n" + String(error.stack || "").split("\n").slice(0, 6).join("\n") : "")));
  page.on("console", (message) => {
    // WebKit logs Chrome's viewport "interactive-widget" key as an error (it ignores it): not a problem.
    if (message.type() === "error" && !/Failed to load resource|favicon|fonts\.g|access control|Origin .* is not allowed|due to access control|Viewport argument key "interactive-widget"/i.test(message.text())) page.errors.push("console: " + message.text().slice(0, 300));
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.addInitScript(({ token, dark }) => {
    Object.defineProperty(Navigator.prototype, "standalone", { configurable: true, get: () => true });
    const media = window.matchMedia.bind(window);
    window.matchMedia = (query) => (/display-mode:\s*standalone/.test(query) ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : media(query));
    localStorage.setItem("theme", dark ? "dark" : "light");
    if (token && !sessionStorage.getItem("qa-seeded")) {
      localStorage.setItem("gvdg_member_token", token);
      sessionStorage.setItem("qa-seeded", "1");
    }
  }, { token, dark });
  await installMemberDashboardApiRoutes(page, apiBase);
  return { page, context };
}

/** Override auth routes on top of the dashboard mocks (later routes win). */
async function authRoutes(page, handlers) {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const handler = handlers[`${request.method()} ${new URL(request.url()).pathname}`];
    if (!handler) return route.fallback();
    const [data, status] = await handler(request.postData() ? JSON.parse(request.postData()) : null);
    return route.fulfill(json(data, status));
  });
}

/** Not blank: visible text in the app (the sign-in gate or the dashboard), and no page errors so far. */
async function notBlank(page, label) {
  await page.waitForFunction(() => {
    // The members page: the app itself (its header is drawn separately). Other pages: anything on screen.
    const app = ["membersReactAuthGate", "membersReactDashboardApp"].map((id) => document.getElementById(id)).filter(Boolean);
    const text = (app.length ? app.map((el) => el.innerText) : [document.body.innerText]).join(" ").replace(/\s+/g, "");
    return text.length > 20;
  }, null, { timeout: 15_000 }).catch(() => { throw new Error(label + ": blank screen"); });
  await page.screenshot({ path: path.join(shots, label.replace(/[^a-z0-9-]+/gi, "-") + ".png") });
  if (page.errors.length) throw new Error(label + ": page errors: " + page.errors.join(" || "));
  assert.equal(await page.locator("#gvdgBootRescue").count(), 0, label + ": the start-up safety net showed");
}

async function check(label, fn) {
  try {
    await fn();
    console.log("PASS " + label);
  } catch (error) {
    failures.push(label + ": " + error.message.split("\n")[0]);
    console.error("FAIL " + label + ": " + (process.env.GVDG_QA_STACKS ? error.message : error.message.split("\n").slice(0, 3).join(" | ")));
  }
}

const shellIs = (page, view) => page.waitForFunction((v) => document.body.dataset.memberShell === v, view);
async function signIn(page) {
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator("#identifierInput").fill("80024");
  await page.locator("#pinInput").fill("4821");
  await page.locator('[data-react-auth-action="login"]').click();
}

console.log((engine === webkit ? "WebKit " : "Chromium ") + browser.version() + " as " + (iphone.userAgent.match(/iPhone OS [\d_]+/) || [""])[0]);

// 1. A new account refuses the email step with Sign out, then opens the app again.
await check("new account: email step, Sign out, open the app again", async () => {
  const { page, context } = await newPage();
  await authRoutes(page, {
    "POST /login": () => [{ token: jwt(nowSec()), ...member, email: null, needsEmail: true, emailRequired: true }],
    "GET /me": () => [{ sub: "m_80024", ...member, email: null, needsEmail: true, emailRequired: true }],
  });
  await signIn(page);
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await notBlank(page, "iphone-email-step");
  await page.locator('[data-react-auth-action="email-signout"]').click();
  await page.locator("#identifierInput").waitFor();
  await notBlank(page, "iphone-after-sign-out");
  await page.reload();
  await page.locator("#identifierInput").waitFor();
  await notBlank(page, "iphone-reopened-after-sign-out");
  await context.close();
});

// 2. A new account closes the app on the email step, then opens it again (still signed in).
await check("new account: close on the email step, open the app again", async () => {
  const { page, context } = await newPage({ token: jwt(nowSec()) });
  await authRoutes(page, { "GET /me": () => [{ sub: "m_80024", ...member, email: null, needsEmail: true, emailRequired: true }] });
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await notBlank(page, "iphone-email-step-reopened");
  await page.reload();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await notBlank(page, "iphone-email-step-reopened-twice");
  await context.close();
});

// 3. An account from before the email step: Home with the reminder; the email screen's Cancel; open again.
await check("existing account: Home with the email reminder, Cancel, open again", async () => {
  const { page, context } = await newPage();
  await authRoutes(page, {
    "POST /login": () => [{ token: jwt(nowSec()), ...member, email: null, needsEmail: true, emailRequired: false }],
    "GET /me": () => [{ sub: "m_80024", ...member, email: null, needsEmail: true, emailRequired: false }],
  });
  await signIn(page);
  await shellIs(page, "members");
  await page.locator("[data-react-email-reminder]").waitFor();
  await notBlank(page, "iphone-home-email-reminder");
  await page.locator("[data-react-email-reminder]").click();
  await page.locator('[data-react-auth-action="email-cancel"]').click();
  await shellIs(page, "members");
  await notBlank(page, "iphone-home-after-cancel");
  await page.reload();
  await shellIs(page, "members");
  await notBlank(page, "iphone-home-reopened");
  await context.close();
});

// 4. Home and each tab, light and dark.
for (const dark of [false, true]) {
  await check(`signed in: Home and every tab (${dark ? "dark" : "light"})`, async () => {
    const { page, context } = await newPage({ token: jwt(nowSec()), dark });
    await authRoutes(page, { "GET /me": () => [{ sub: "m_80024", ...member, email: "jordan@example.com", needsEmail: false, emailRequired: false }] });
    await page.goto(`${origin}/gvdg-members.html`);
    await shellIs(page, "members");
    await notBlank(page, `iphone-home-${dark ? "dark" : "light"}`);
    for (const hash of ["play", "events", "stats", "club-hub", "account"]) {
      await page.evaluate((h) => { window.location.hash = h; }, hash);
      await page.waitForTimeout(900);
      await notBlank(page, `iphone-${hash}-${dark ? "dark" : "light"}`);
    }
    await context.close();
  });
}

// 5. The public pages, signed out.
for (const pagePath of ["/index.html", "/events.html", "/lost-found.html", "/pro-shop.html", "/scoring-app.html", "/score.html", "/gvdg-members.html"]) {
  await check("public page " + pagePath, async () => {
    const { page, context } = await newPage();
    await page.goto(origin + pagePath);
    await page.waitForTimeout(1200);
    await notBlank(page, "iphone-page" + pagePath.replace(/\.html$/, ""));
    await context.close();
  });
}

// 6. The safety net: the app's code never arrives, so the page offers Reload instead of staying blank.
await check("start-up safety net when the app can't load", async () => {
  breakApp = true;
  const { page, context } = await newPage();
  page.errors = [];
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator("#gvdgBootRescue").waitFor({ timeout: 20_000 });
  assert.ok(await page.getByRole("button", { name: "Reload", exact: true }).isVisible());
  await page.screenshot({ path: path.join(shots, "iphone-boot-rescue.png") });
  breakApp = false;
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  try {
    await page.locator("#identifierInput").waitFor({ timeout: 25_000 });
  } catch (error) {
    await page.screenshot({ path: path.join(shots, "iphone-boot-rescue-after-reload.png") }).catch(() => {});
    const state = await page.evaluate(() => ({ rescue: Boolean(document.getElementById("gvdgBootRescue")), text: document.body.innerText.slice(0, 300) })).catch((e) => String(e));
    throw new Error("Reload didn't bring the app back: " + JSON.stringify(state));
  }
  assert.equal(await page.locator("#gvdgBootRescue").count(), 0, "gone once the app starts");
  await context.close();
});

await browser.close();
server.close();
if (failures.length) {
  console.error("\niPhone WebKit QA failed:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("iPhone WebKit QA passed; screenshots in " + shots);
