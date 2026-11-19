import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const apiBase = "http://127.0.0.1:8788";
const evidenceDir = path.join(repoRoot, ".omo/evidence/site-smoke-browser-qa");

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

const holes = Array.from({ length: 18 }, (_, index) => ({
  hole: index + 1,
  par: 3,
  distance_ft: 250 + index * 10,
}));

const courses = [
  { id: 1, name: "ECU North Rec Complex", location: "Greenville, NC", lat: 35.631, lng: -77.32 },
];

const layouts = [
  { id: 11, name: "Main Layout", total_par: 54, holes: JSON.stringify(holes) },
];

const events = [
  {
    id: 2,
    type: "tournament",
    name: "Release Smoke Open",
    status: "scheduled",
    format: "stroke",
    play_format: "singles",
    date: "2026-07-15",
    course_id: 1,
    layout_id: 11,
    players: [],
  },
  {
    id: 3,
    type: "league",
    name: "Release Smoke League",
    status: "scheduled",
    format: "stroke",
    play_format: "singles",
    date: "2026-08-01",
    course_id: 1,
    layout_id: 11,
    players: [],
  },
];

const league = {
  id: 4,
  name: "Ryder Cup",
  standings: [],
  teamStandings: [],
  roundWinners: [],
  events: [],
};

const pages = [
  {
    name: "home",
    path: "/index.html",
    text: ["Greenville Disc Golf Club", "Our Courses"],
  },
  {
    name: "events-status",
    path: "/events.html",
    text: ["Club events", "Leagues & Standings"],
  },
  {
    name: "events-detail",
    path: "/events.html#event/2",
    text: ["Release Smoke Open", "ECU North Rec Complex"],
  },
  {
    name: "events-league",
    path: "/events.html#league/4",
    text: ["Ryder Cup"],
  },
  {
    name: "members-auth",
    path: "/gvdg-members.html",
    text: ["Members Only", "PDGA #, UDisc username or email"],
  },
  {
    name: "admin-auth",
    path: "/admin.html",
    text: ["Admin", "Event management"],
  },
  {
    name: "blog",
    path: "/gvdg-blog.html",
    text: ["Club Blog", "Coming Soon"],
  },
  {
    name: "pro-shop",
    path: "/pro-shop.html",
    text: ["Pro Shop", "GVDG Disc"],
  },
  {
    name: "ryder-cup",
    path: "/ryder-cup.html",
    text: ["Ryder Cup"],
  },
  { name: "scoring-app", path: "/scoring-app.html", text: ["Your game.", "Wallpaper. Color. Glass.", "Watch live."] },
  { name: "archive-redirect", path: "/archive.html", text: ["Club events"], redirect: "/events.html#previousResultsSection" },
  { name: "design-chooser", path: "/design.html", text: ["Direction 01", "Direction 02"] },
  { name: "design-field", path: "/design-field.html", text: ["Where to play", "One card for the year."] },
  { name: "design-night", path: "/design-night.html", text: ["Where to play", "One card for the year."] },
  {
    name: "tee-sign-preview",
    path: "/tee-sign-preview.html",
    text: ["Tee-sign preview", "Battle Park"],
  },
];

const viewports = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
];

function json(body, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

function csv() {
  return [
    "Name,Date,Detail,URL",
    "Release Smoke,Jul 15 2026,QA row,https://gvdgclub.com",
  ].join("\n");
}

function apiResponse(url) {
  const pathName = url.pathname;
  if (pathName === "/me") return json({ error: "unauthorized" }, 401);
  if (pathName === "/courses") return json({ courses });
  if (pathName === "/courses/1/layouts") return json({ layouts });
  if (pathName === "/courses/1/tee-signs") return json({ teeSigns: [] });
  if (pathName === "/events") return json({ events });
  if (pathName === "/events/2") return json({ event: events[0] });
  if (pathName === "/events/2/ace-pot") return json({ ace_pot: null });
  if (pathName === "/events/2/ctps") return json({ ctps: [] });
  if (pathName === "/events/2/registration") return json({ registrations: [], players: [] });
  if (pathName === "/events/2/results") return json({ results: [] });
  if (pathName === "/club-feed") return json({ events: [], clubEvents: [] });
  if (pathName === "/fundraisers") return json({ fundraisers: [] });
  if (pathName === "/leagues") return json({ leagues: [league] });
  if (pathName === "/leagues/4") return json({ ...league, league });
  if (pathName === "/meetings") return json({ meetings: [] });
  if (pathName === "/payments/config") return json({ enabled: false });
  if (pathName === "/shop/products") {
    return json({
      products: [
        {
          id: 1,
          active: 1,
          brand: "GVDG",
          name: "GVDG Disc",
          price_cents: 1800,
          product_type: "disc",
          stock_qty: 4,
        },
      ],
    });
  }
  if (pathName === "/shop/wallet") return json({ balance_cents: 0, orders: [] });
  return json({});
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/version.json") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ commit: "site-smoke-fixture", branch: "fixture" }));
        return;
      }
      const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(repoRoot, normalized);
      if (!filePath.startsWith(repoRoot + path.sep)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { "Content-Type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(error && error.code === "ENOENT" ? 404 : 500);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function collectPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text() + " " + (message.location().url || ""));
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    errors.push(`Unexpected native dialog: ${dialog.type()} ${dialog.message()}`);
    return dialog.dismiss();
  });
  return errors;
}

async function installRoutes(context) {
  await context.route(`${apiBase}/**`, (route) => {
    route.fulfill(apiResponse(new URL(route.request().url())));
  });
  await context.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
  await context.route("https://docs.google.com/**", (route) => {
    route.fulfill({ status: 200, contentType: "text/csv; charset=utf-8", body: csv() });
  });
  await context.route("https://www.paypal.com/**", (route) => route.fulfill({ status: 204, body: "" }));
}

async function waitForText(page, expected, label) {
  await page.waitForFunction(
    ({ expected: values }) => values.every((value) => document.body.textContent.includes(value)),
    { expected },
    { timeout: 12_000 },
  ).catch(async () => {
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`${label} did not render expected text ${JSON.stringify(expected)}. Page text:\n${body}`);
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  if (overflow <= 1) return;
  throw new Error(`${label} has horizontal overflow of ${overflow}px`);
}

async function runPage(browser, server, item, viewport) {
  const context = await browser.newContext({ viewport });
  await installRoutes(context);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  try {
    await page.goto(`${server.origin}${item.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await waitForText(page, item.text, item.name);
    if (item.redirect) await page.waitForURL(`${server.origin}${item.redirect}`);
    await assertNoHorizontalOverflow(page, `${viewport.width} ${item.name}`);
    if (errors.length) throw new Error(errors.join("\n"));
    await page.screenshot({
      path: path.join(evidenceDir, `${viewport.width}-${item.name}.png`),
      fullPage: true,
    });
  } finally {
    await context.close();
  }
}

await mkdir(evidenceDir, { recursive: true });
const server = await startStaticServer();
const browser = await chromium.launch();
const failures = [];
try {
  for (const viewport of viewports) {
    for (const item of pages.filter(item => !process.env.GVDG_SMOKE_PAGES || process.env.GVDG_SMOKE_PAGES.split(",").includes(item.name))) {
      try {
        await runPage(browser, server, item, { width: viewport.width, height: viewport.height });
        console.log(`PASS ${viewport.label} ${item.name}`);
      } catch (error) {
        failures.push(`${viewport.label} ${item.name}: ${error.message}`);
        console.error(`FAIL ${viewport.label} ${item.name}: ${error.message}`);
      }
    }
  }
  // PayPal from inside Facebook: the dues link leaves the in-app browser (Android: an intent:// link for the PayPal app
  // or the real browser; iPhone: Safari). A normal browser is left alone.
  const FB_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]";
  const FB_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0;FBBV/1;FBDV/iPhone15,2]";
  // The installed club app on an iPhone: outside sign-up links open in Safari, where the person is signed in.
  const IPHONE_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  for (const [label, userAgent, expected, installed] of [
    ["facebook android", FB_ANDROID, /^intent:\/\/paypal\.me\/greenvillediscgolf\/15#Intent;scheme=https;/],
    ["facebook iphone", FB_IOS, /^x-safari-https:\/\/paypal\.me\/greenvillediscgolf\/15$/],
    ["installed app iphone", IPHONE_APP, /^x-safari-https:\/\/paypal\.me\/greenvillediscgolf\/15$/, true],
    ["normal browser", undefined, null],
  ]) {
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(userAgent ? { userAgent } : {}) });
      if (installed) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true }));
      await installRoutes(context);
      await context.route("https://paypal.me/**", (route) => route.fulfill({ status: 204, body: "" }));
      const page = await context.newPage();
      await page.goto(`${server.origin}/index.html`, { waitUntil: "domcontentloaded" });
      const dues = page.getByRole("link", { name: "Pay with PayPal" }).first();
      await dues.waitFor();
      await page.evaluate(() => { window.__left = []; window.addEventListener("beforeunload", () => window.__left.push(location.href)); });
      const popup = context.waitForEvent("page", { timeout: 1500 }).catch(() => null);
      await dues.click({ noWaitAfter: true });
      await page.waitForTimeout(300);
      const handoff = await page.evaluate(() => document.documentElement.dataset.outsideHandoff || "").catch(() => "");
      if (expected) {
        if (!expected.test(handoff)) throw new Error(label + ": expected a hand-off, got " + JSON.stringify(handoff));
      } else {
        if (handoff) throw new Error(label + ": a normal browser must keep the plain link, got " + handoff);
        if (!(await popup)) throw new Error(label + ": the plain link should open as usual");
      }
      await context.close();
      console.log(`PASS paypal ${label}`);
    } catch (error) {
      failures.push(`paypal ${label}: ${error.message}`);
      console.error(`FAIL paypal ${label}: ${error.message}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`site smoke browser QA failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`site smoke browser QA passed; screenshots: ${evidenceDir}`);
