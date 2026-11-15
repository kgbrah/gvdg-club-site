import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };
const course = { id: 7, name: "River Course", location: "Greenville" };
const alternateCourse = { id: 8, name: "Forest Course", location: "Greenville" };
const event = { id: 42, name: "River Open", status: "live", type: "tournament", course_id: 7, date: "2026-11-14" };
const otherEvent = { id: 41, name: "Forest Open", status: "scheduled", type: "tournament", course_id: 8, date: "2026-12-01" };
const eventHoles = [{ hole: 1, par: 3 }];
const events = [event, otherEvent];
const requested = [];
const pageErrors = [];
const bootstrapErrors = [];
const serveOnly = Boolean(process.env.GVDG_NAV_QA_SERVE);

const pages = {
  "/member-navigation.html": ["gvdg-members.html", "data-auth-base", "/src/members-app/main.js"],
  "/admin-navigation.html": ["admin.html", "data-auth-base", "/src/admin-app/main.js"],
};

function apiResponse(path, query, authorization) {
  if (path === "/me") return { sub: "qa-user", name: "QA Member", pdgaNo: "123", isAdmin: authorization === "Bearer qa-admin" };
  if (path === "/my-live-rounds") return { rounds: [{ ...event, course_name: course.name, layout_name: "Main" }] };
  if (path === "/registration/open" || path === "/events") return { events };
  if (path === "/courses") return { courses: [course, alternateCourse] };
  if (path === "/courses/7/layouts") return { layouts: [{ id: 9, name: "Main layout", holes: eventHoles }] };
  if (/\/courses\/\d+\/positions$/.test(path)) return { positions: [] };
  if (path === "/events/42/live") return { status: "live", holes: eventHoles, players: [], standings: [], conflicts: [], missing: [] };
  if (path === "/admin/orders") return { unfulfilled: 2, orders: [
    { id: 6, status: "submitted", delivery_method: "pickup", customer_name: "Submitted order", total_cents: 0 },
    { id: 7, status: "processing", delivery_method: "pickup", customer_name: "Processing order", total_cents: 0 },
    { id: 8, status: "completed", delivery_method: "pickup", customer_name: "Completed order", total_cents: 0 },
  ].filter((row) => !query.get("status") || row.status === query.get("status")) };
  if (path === "/admin/members/applications") return { applications: [{ id: 10, name: "New Applicant", status: "pending" }] };
  if (path === "/admin/members") return { members: [{ id: "m_1", name: "QA Member", pdgaNo: "123" }] };
  if (path === "/shop/wallet") return { balance_cents: 500, transactions: [] };
  return {};
}

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const vite = await createServer({
  configFile: false,
  cacheDir: process.env.GVDG_NAV_QA_CACHE || await mkdtemp(join(tmpdir(), "gvdg-nav-browser-qa-")),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{
    name: "gvdg-navigation-test",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        const page = pages[url.pathname];
        if (page) {
          const [file, attribute, entry] = page;
          const html = (await readFile(file, "utf8"))
            .replace(/<link[^>]+https:[^>]+>/g, "")
            .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
            .replace(attribute + '=""', attribute + '="/navigation-api"')
            .replace(/src="(?:members|admin)-app\/[^"]+"/, 'src="' + entry + '"');
          const fixture = serveOnly
            ? html.replace("<head>", '<head><script>localStorage.setItem("gvdg_member_token", "' + (file === "admin.html" ? "qa-admin" : "qa-member") + '")</script>')
            : html;
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, fixture));
        } else if (url.pathname.startsWith("/navigation-api/")) {
          const path = url.pathname.slice("/navigation-api".length);
          requested.push(path + url.search);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(apiResponse(path, url.searchParams, req.headers.authorization)));
        } else next();
      });
    },
  }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
if (serveOnly) {
  console.log("Member fixture " + origin + "/member-navigation.html#home");
  console.log("Admin fixture " + origin + "/admin-navigation.html#today");
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  await vite.close();
  process.exit(0);
}
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});

async function newPage(viewport, token) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(origin)) bootstrapErrors.push(request.url() + " " + request.failure()?.errorText);
  });
  await page.addInitScript((value) => localStorage.setItem("gvdg_member_token", value), token);
  return { context, page };
}

async function verifyMembers(viewport) {
  const { page, context } = await newPage(viewport, "qa-member");
  try {
    await page.goto(origin + "/member-navigation.html#overview", { waitUntil: "commit", timeout: 30000 });
    const nav = page.getByRole("navigation", { name: "Member app" });
    await nav.getByRole("button", { name: "Home", exact: true }).waitFor({ timeout: 90000 }).catch(async (error) => {
      throw new Error(error.message + "\nPage errors: " + JSON.stringify(pageErrors) +
        "\nLoad errors: " + JSON.stringify(bootstrapErrors.slice(-12)) + "\nVisible page: " + await page.locator("body").innerText());
    });
    for (const name of ["Home", "Play", "Events", "Stats", "Club"]) await nav.getByRole("button", { name, exact: true }).waitFor();
    await page.getByRole("link", { name: /Continue round/ }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Admin portal", exact: false }).count(), 0);
    await page.getByText("Getting started", { exact: true }).click();
    await page.getByRole("button", { name: "Dismiss getting started" }).click();
    await nav.getByRole("button", { name: "Stats" }).click();
    await page.getByRole("heading", { name: "Stats", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Import UDisc history" }).click();
    await page.getByRole("heading", { name: "Imported history", level: 1 }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "Stats", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("button", { name: "Wallet", exact: true }).click();
    await page.getByText("$5", { exact: true }).filter({ visible: true }).waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("heading", { name: "Appearance", level: 1 }).waitFor();
    await nav.getByRole("button", { name: "Club" }).click();
    await page.getByRole("button", { name: "Club directory" }).click();
    await page.getByRole("heading", { name: "Club directory", level: 1 }).waitFor();
    await page.goto(origin + "/member-navigation.html?course=7#tee", { waitUntil: "commit", timeout: 30000 });
    await page.getByRole("heading", { name: "Tee signs", level: 1 }).waitFor();
    await page.locator("#membersReactTeeSignsPanel select").first().waitFor();
    assert.equal(await page.locator("#membersReactTeeSignsPanel select").first().inputValue(), "7");
    await page.goto(origin + "/member-navigation.html#events?event=42", { waitUntil: "commit", timeout: 30000 });
    await page.locator("[data-member-event-id='42']").waitFor();
    assert.equal(await page.getByRole("heading", { name: "Events", level: 1 }).isVisible(), true);
  } finally { await context.close(); }
}

async function verifyAdmin(viewport) {
  const { page, context } = await newPage(viewport, "qa-admin");
  try {
    await page.goto(origin + "/admin-navigation.html?tab=orders", { waitUntil: "commit", timeout: 30000 });
    await page.getByRole("heading", { name: "Orders", level: 1 }).waitFor();
    await page.locator("#ordStatusFilter").waitFor();
    await page.waitForFunction(() => document.querySelector("#ordStatusFilter")?.value === "unfulfilled");
    const nav = page.getByRole("navigation", { name: "Admin navigation" }).filter({ visible: true });
    for (const name of ["Today", "Events", "Members", "Money", "Tools"]) await nav.getByRole("button", { name, exact: true }).waitFor();
    await nav.getByRole("button", { name: "Today", exact: true }).click();
    await page.locator("#apane-today").getByRole("button", { name: "Live scoring" }).click();
    await page.getByRole("navigation", { name: "Event workspace" }).waitFor();
    assert.match(new URL(page.url()).hash, /#scoring\?event=42/);
    await page.getByRole("navigation", { name: "Event workspace" }).getByRole("button", { name: "Check-in" }).click();
    assert.match(new URL(page.url()).hash, /#check-in\?event=42/);
    await page.goBack();
    await page.getByRole("heading", { name: "Live scoring", level: 1 }).waitFor();
    assert.match(new URL(page.url()).hash, /event=42/);
    await page.getByRole("navigation", { name: "Event workspace" }).getByRole("button", { name: "Registration" }).click();
    await page.getByRole("button", { name: "Event payments and wallets" }).click();
    await page.getByRole("button", { name: "Back to event registration and payouts" }).click();
    assert.match(new URL(page.url()).hash, /#registration\?event=42/);
    const find = page.getByRole("searchbox", { name: "Find a tool" });
    await find.fill("approve application");
    await find.press("Enter");
    await page.getByRole("heading", { name: "Member applications", level: 1 }).waitFor();
    await nav.getByRole("button", { name: "Tools", exact: true }).click();
    await page.locator("#apane-more").getByRole("button", { name: "Courses", exact: true }).click();
    await page.getByRole("region", { name: "Selected course" }).getByRole("combobox").selectOption("7");
    await page.getByRole("navigation", { name: "Course workspace" }).getByRole("button", { name: "Layouts" }).click();
    await page.waitForFunction(() => document.querySelector("#alCourse")?.value === "7");
    assert.match(new URL(page.url()).hash, /#layouts\?course=7/);
    await page.getByRole("navigation", { name: "Course workspace" }).getByRole("button", { name: "Tee signs" }).click();
    assert.match(new URL(page.url()).hash, /#tee-signs\?course=7/);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector("#alCourse")?.value === "7");
    assert.ok(requested.includes("/courses/7/layouts"));
    assert.ok(requested.some((request) => request.startsWith("/admin/tee-signs?status=candidate")));
  } finally { await context.close(); }
}

try {
  for (const viewport of [desktop, phone]) {
    await verifyMembers(viewport);
    await verifyAdmin(viewport);
  }
  const { page, context } = await newPage(phone, "qa-member");
  await page.goto(origin + "/admin-navigation.html?tab=orders", { waitUntil: "commit", timeout: 30000 });
  await page.getByText("You don't have admin access.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("searchbox", { name: "Find a tool" }).count(), 0);
  await context.close();
  assert.deepEqual(pageErrors, [], "Navigation must not produce runtime errors");
  console.log("Navigation passed on desktop and phone, including legacy links, search, permissions and Back.");
} finally {
  await browser.close();
  await vite.close();
}
