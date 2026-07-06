import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const apiBase = "http://127.0.0.1:8788";
const evidenceDir = path.join(repoRoot, ".omo/evidence/members-dashboard-react");

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

const stats = {
  pdga: "90000001",
  name: "GVDG QA Dashboard",
  official_rating: 935,
  rating_date: "2026-07-01",
  live_rating: 941,
  peak_rating: 958,
  events_count: 2,
  events: [
    {
      tournament: "GVDG QA Summer Check",
      date: "Jul 4 2026",
      epoch: 1783123200,
      division: "MA2",
      rounds: [
        { rating: 943, score: 54, round: "1" },
        { rating: 951, score: 52, round: "2" },
      ],
    },
  ],
};

function json(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
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

async function installApiRoutes(page) {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathName = url.pathname;
    const method = request.method();

    if (pathName === "/me") return route.fulfill(json({ sub: "member-1", isAdmin: true, name: "QA Admin", pdgaNo: "90000001" }));
    if (pathName === "/pdga-stats") return route.fulfill(json(stats));
    if (pathName.startsWith("/my-ratings")) {
      return route.fulfill(json({ competitive: { rounds: [] }, casual: { rounds: [] } }));
    }
    if (pathName === "/shop/wallet") return route.fulfill(json({ balance_cents: 0, transactions: [] }));
    if (pathName === "/my-live-rounds") return route.fulfill(json({ rounds: [] }));
    if (pathName === "/payments/config") return route.fulfill(json({ enabled: false }));
    if (pathName === "/registration/open") return route.fulfill(json({ events: [] }));
    if (pathName === "/my-registrations") return route.fulfill(json({ registrations: [] }));
    if (pathName === "/casual-rounds" && method === "GET") return route.fulfill(json({ requests: [] }));
    if (pathName === "/courses") return route.fulfill(json({ courses: [{ id: 1, name: "ECU North Rec Complex" }] }));
    if (pathName === "/courses/1/layouts") return route.fulfill(json({ layouts: [{ id: 11, name: "Pee Dee's Treasure Map" }] }));
    if (pathName === "/meetings") return route.fulfill(json({ meetings: [] }));
    if (pathName === "/board") return route.fulfill(json({ posts: [], authors: {} }));
    if (pathName === "/leagues/active") return route.fulfill(json({ leagues: [], events: [] }));
    if (pathName === "/my-tee-signs") return route.fulfill(json({ teeSigns: [] }));
    if (pathName.startsWith("/shop/")) return route.fulfill(json({ ok: true }));
    return route.fulfill(json({ ok: true }));
  });
}

function collectPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function waitForText(page, selector, expected, label) {
  try {
    await page.waitForFunction(
      ({ selector: query, expected: text }) => document.querySelector(query)?.textContent?.includes(text),
      { selector, expected },
      { timeout: 10_000 },
    );
  } catch {
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`Timed out waiting for ${label} to include ${expected}. Page text:\n${body}`);
  }
}

async function expectReactTab(page, name) {
  const selected = await page.getByRole("tab", { name }).getAttribute("aria-selected");
  if (selected !== "true") throw new Error(`Expected React tab ${name} to be selected, got ${selected}`);
}

async function captureState(browser, origin, viewport, slug) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await installApiRoutes(page);
  await page.addInitScript(() => sessionStorage.setItem("gvdg_member_token", "qa-token"));

  await page.goto(`${origin}/gvdg-members.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#members.members-react-shell-ready", { timeout: 10_000 });
  await expectReactTab(page, "Overview");
  await page.waitForSelector('[data-react-pdga-dashboard="ready"]', { timeout: 10_000 });
  await waitForText(page, "#membersReactRatingPanel", "941", "React live rating");
  const legacyHidden = await page.locator("#legacyPdgaDashboard").evaluate((node) => getComputedStyle(node).display === "none");
  if (!legacyHidden) throw new Error("Legacy PDGA dashboard remained visible after React rating panel mounted.");
  await page.screenshot({ path: path.join(evidenceDir, `${slug}-overview.png`), fullPage: true });

  await page.getByRole("tab", { name: "Events" }).click();
  await waitForText(page, "#membersReactDashboardShell", "Event Registration", "events title");
  await expectReactTab(page, "Events");
  await page.screenshot({ path: path.join(evidenceDir, `${slug}-events.png`), fullPage: true });

  await page.getByRole("tab", { name: "Club" }).click();
  await waitForText(page, "#membersReactDashboardShell", "GVDG Member Directory", "club title");
  await expectReactTab(page, "Club");
  await page.screenshot({ path: path.join(evidenceDir, `${slug}-club.png`), fullPage: true });

  const overflow = await page.evaluate(() => {
    const y = window.scrollY;
    window.scrollTo(9999, y);
    const x = window.scrollX;
    window.scrollTo(0, y);
    return x;
  });
  if (overflow > 1) {
    const offenders = await page.evaluate(() => {
      return [...document.querySelectorAll("body *")].map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          id: node.id || "",
          className: String(node.className || ""),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      }).filter((row) => row.right > window.innerWidth + 1 || row.left < -1).slice(0, 8);
    });
    throw new Error(`${slug} has horizontal overflow of ${overflow}px: ${JSON.stringify(offenders)}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  await context.close();
}

const staticServer = await startStaticServer();
const browser = await chromium.launch({ headless: true });

try {
  await mkdir(evidenceDir, { recursive: true });
  await captureState(browser, staticServer.origin, { width: 390, height: 844 }, "mobile");
  await captureState(browser, staticServer.origin, { width: 768, height: 1024 }, "tablet");
  await captureState(browser, staticServer.origin, { width: 1280, height: 900 }, "desktop");
} finally {
  await browser.close();
  await staticServer.close();
}

console.log("members dashboard browser QA passed");
