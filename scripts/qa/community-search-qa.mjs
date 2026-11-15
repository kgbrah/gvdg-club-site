import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const imageDir = process.env.GVDG_COMMUNITY_SEARCH_SHOTS;
if (imageDir) await mkdir(imageDir, { recursive: true });
const progress = { totals: { club: 2, casual: 1 }, streak: 2, streakCapped: false, achieved: [1], next: 5,
  weekly: [{ startsOn: "2026-11-02", rounds: 2 }, { startsOn: "2026-11-09", rounds: 1 }] };
const profile = { key: null, audience: "club", displayName: "QA Member", bio: "", shareProgress: false, revision: 1 };
const members = [
  { key: "11111111-1111-4111-8111-111111111111", displayName: "Jarret Cole" },
  { key: "22222222-2222-4222-8222-222222222222", displayName: "Jarrod Stone" },
  { key: "33333333-3333-4333-8333-333333333333", displayName: "Morgan Lee" },
];
let directoryCalls = [];
let delayMs = 0;

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const vite = await createServer({
  configFile: false, cacheDir: "/tmp/gvdg-community-search-qa", server: { host: "127.0.0.1", hmr: false, port: Number(process.env.GVDG_QA_PORT) || undefined },
  optimizeDeps: { entries: ["src/members-app/main.js"] },
  plugins: [{ name: "community-search-fixture", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/gvdg-members.html") {
        const html = (await readFile("gvdg-members.html", "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
          .replace('data-auth-base=""', 'data-auth-base="/search-fixture"')
          .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"');
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url, html));
        return;
      }
      if (!url.pathname.startsWith("/search-fixture/")) { next(); return; }
      const path = url.pathname.slice("/search-fixture".length);
      const respond = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      if (path === "/me") { respond({ sub: "qa-member", pdgaNo: "123", name: "QA Member", isAdmin: false }); return; }
      if (path === "/me/community") { respond({ profile, progress, contacts: [], blocked: [] }); return; }
      if (path === "/community/directory") {
        const q = (url.searchParams.get("q") || "").toLowerCase();
        directoryCalls.push(q);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        respond({ profiles: q ? members.filter((m) => m.displayName.toLowerCase().includes(q)) : [], more: false }); return;
      }
      respond({});
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function run(mode, width, large) {
  directoryCalls = [];
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(([m, big]) => {
    localStorage.setItem("gvdg_member_token", "qa-member"); localStorage.setItem("theme", m);
    if (big) addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "22px"; });
  }, [mode, large]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(25000);
  const tag = mode + "-" + width + (large ? "-large" : "");
  const shot = async (name) => { if (imageDir) await page.screenshot({ path: join(imageDir, name + "-" + tag + ".png") }); };
  try {
    await page.goto(origin + "/gvdg-members.html#community", { waitUntil: "commit" });
    const input = page.getByLabel("Find a member");
    await input.waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.body.textContent.includes("Searching the directory"));
    // Empty state before any search: a hint, never "No matching profiles."
    const card = page.locator(".member-community-directory");
    assert.match(await card.innerText(), /Type at least 2 letters/);
    assert.doesNotMatch(await card.innerText(), /No matching profiles/);
    assert.equal(await input.getAttribute("type"), "search");
    assert.equal(await input.getAttribute("enterkeyhint"), "search");
    // Layout fits without horizontal overflow, input and button visible.
    await input.scrollIntoViewIfNeeded();
    const button = page.getByRole("button", { name: "Search members" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
    for (const box of [await input.boundingBox(), await button.boundingBox()]) assert.ok(box.x >= 0 && box.x + box.width <= width, "controls inside viewport");
    // Focus, then simulate the keyboard by shrinking the visible viewport.
    await input.tap();
    await page.setViewportSize({ width, height: 420 });
    await page.waitForFunction(() => {
      const el = document.querySelector('input[name="memberSearch"]'); const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    }, null, { timeout: 5000 });
    await input.pressSequentially("Jarr", { delay: 40 });
    await page.getByRole("link", { name: "Jarret Cole" }).waitFor();
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      const dock = document.querySelector(".player-app-nav");
      const dockVisible = dock && getComputedStyle(dock).display !== "none";
      return { input: rect(document.querySelector('input[name="memberSearch"]')),
        first: rect(document.querySelector(".member-community-directory .community-list li a")),
        dockTop: dockVisible ? dock.getBoundingClientRect().top : null, height: innerHeight, dockExists: Boolean(dock) };
    });
    const limit = state.dockTop ?? state.height;
    assert.ok(state.input.top >= 0 && state.input.bottom <= limit, "input visible above dock/keyboard " + JSON.stringify(state));
    assert.ok(state.first.top >= 0 && state.first.bottom <= limit, "first result visible " + JSON.stringify(state));
    assert.ok(state.input.bottom <= state.first.top, "results render below the input");
    assert.equal(state.dockTop, null, "dock hidden while typing");
    assert.deepEqual(directoryCalls.filter(Boolean).every((q) => q.length >= 2), true, "no query under 2 letters");
    assert.ok(directoryCalls.includes("jarr"), "searched without clicking the button");
    await shot("keyboard-results");
    // Nonsense query: a real empty result says so; 1 char returns to the hint.
    await input.fill("zzq");
    await page.getByText("No matching profiles.").waitFor();
    await input.fill("z");
    await page.getByText("Type at least 2 letters to search.").waitFor();
    assert.equal(await page.getByText("No matching profiles.").count(), 0);
    // Slow response shows Searching... and Enter submits immediately.
    delayMs = 600;
    await input.fill("Morgan");
    await input.press("Enter");
    await page.getByText("Searching the directory…").waitFor();
    await page.getByRole("link", { name: "Morgan Lee" }).waitFor();
    delayMs = 0;
    // Button still works.
    await input.fill("Jarrod");
    await button.evaluate((el) => el.click());
    await page.getByRole("link", { name: "Jarrod Stone" }).waitFor();
    // Blur restores the dock.
    await input.blur();
    await page.waitForFunction(() => !document.documentElement.classList.contains("member-keyboard-open"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

try {
  for (const mode of ["light", "dark"]) await run(mode, 390, false);
  await run("dark", 320, true);
  await run("light", 390, true);
  console.log("community-search-qa passed");
} finally { await browser.close(); await vite.close(); }
