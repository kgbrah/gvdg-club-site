import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

import { buildTheme } from "../../src/shared/dashboard-theme-model.js";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";

const member = { sub: "m_visual_fixture", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: false };
const recent = [{ code: "RIVER7", label: "Rocky Ford · Long tees", updatedAt: Date.now() }];
const recentResults = { results: [], casual: [{ round_code: "FORD19", course_name: "Rocky Ford",
  layout_name: "Short tees", finalized_at: "2026-11-13T19:30:00Z", total: 57, to_par: 3, place: 1 }] };
const activeEvent = { id: 51, name: "Sunday Bag Tag Round", status: "scheduled", type: "league_round",
  date: "2026-11-22", course_name: "West Meadowbrook Park", layout_name: "Main" };
const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide4.jpg")).toString("base64");
const theme = buildTheme({
  mode: "dark", wallpaper, sourcePalette: [
    "#112a57", "#b5e64e", "#88c9a3", "#e7cc9b", "#507be1", "#b190d6", "#a7caf4", "#e3eefc",
    "#415876", "#d1f29c", "#c2efcf", "#f5e0b6", "#8cb2ff", "#dbbbef", "#c3e3fe", "#f4f8ff",
  ],
});
const discId = "c52dd50d-aedc-47e6-9a44-53e63ab928f8";
const disc = { id: discId, kind: "disc", revision: 1, record: { brand: "Axiom", model: "Envy",
  plastic: "Neutron", weightGrams: 173, notes: "", inBag: true, archived: false } };
const putting = { id: "3732689e-4de0-4132-8c38-63f0583e7ba9", kind: "putting", revision: 1,
  record: { date: "2026-11-13", stations: [{ distance: 18, unit: "ft", meters: 5.486, attempts: 25, makes: 18 }] } };
const measured = { id: "713630eb-ecc1-4284-8c81-ddc29305b510", kind: "throw", revision: 1,
  record: { date: "2026-11-13", discId, shotType: "backhand", distance: 215, unit: "ft", meters: 65.532 } };
const pageName = "/member-visual.html";
const apiRoot = "/member-visual-api";
const fontPath = process.env.GVDG_VISUAL_FONT_PATH;
const localFont = fontPath ? await readFile(fontPath) : null;
const fontAsset = "/member-visual-archivo.woff2";
const images = process.env.GVDG_VISUAL_IMAGES || join(tmpdir(), "gvdg-member-visual-qa");
const title = member.name;

function seed(mode) {
  const themeMode = mode === "light" ? "light" : "dark";
  return '<script>localStorage.setItem("gvdg_member_token","fixture-member");' +
    'localStorage.setItem("theme",' + JSON.stringify(themeMode) + ');' +
    'localStorage.setItem("gvdg_recent_rounds",' + JSON.stringify(JSON.stringify(recent)) + ');</script>';
}

function response(path, query, tagState, request) {
  if (path === "/me") return member;
  if (path === "/me/dashboard-theme") return { theme: query.mode === "blue" ? theme : null };
  if (path === "/me/practice") return { owner: member.sub, discs: [disc],
    throws: { items: [measured], next: null }, putting: { items: [putting], next: null },
    puttingTotals: { attempts: 25, makes: 18, sessions: 1 }, puttingTrends: [],
    throwGroups: [{ discId, shotType: "backhand", throws: 1, averageMeters: 65.532, farthestMeters: 65.532 }],
  };
  if (path === "/rounds/RIVER7/live/mine") return { status: "live", cardId: 1, cardmates: [{ name: "Morgan" }, { name: "Jordan" }] };
  if (path === "/my-live-rounds") return { rounds: [] };
  if (path === "/pdga-stats") return { name: title, official_rating: 913, live_rating: 918, previous_rating: 910,
    events: [{ tournament: "Greenville Open", date: "Oct 21, 2026", division: "MA2", rounds: [{ rating: 919, score: 55 }] }] };
  if (path === "/shop/wallet") return { balance_cents: 3250,
    transactions: [{ id: 1, amount_cents: 3250, source: "event_payout", created_at: "2026-11-13T19:30:00Z" }] };
  if (path === "/bag-tags/request" && request.method === "POST") { tagState.requested = true; return { ok: true }; }
  if (path === "/bag-tags/challenges" && request.method === "POST") { tagState.challengeSent = true; return { ok: true }; }
  if (/^\/bag-tags\/challenges\/\d+\/(confirm|decline)$/.test(path)) { tagState.answered = true; return { ok: true }; }
  if (path === "/bag-tags/mine") {
    const series = { id: 1, name: "Greenville 2026" };
    if (query.mode === "holder") {
      const mine = { memberId: member.sub, tagNumber: 12 };
      const holders = [{ memberId: "tagmate", tagNumber: 7, name: "Jordan" }];
      const challenges = tagState.answered ? [] : [{ id: 9, defenderId: member.sub, challengerName: "Sam",
        defenderTag: 12, challengerScore: 52, defenderScore: 54 }];
      return { series, mine, holders, challenges };
    }
    return { series, mine: null, request: tagState.requested ? { createdAt: "2026-11-15" } : null };
  }
  if (path === "/club/my-registrations") return { registrations: [] };
  if (path === "/events" || path === "/registration/open") return { events: [activeEvent] };
  if (path === "/course-conditions") return { reports: [] };
  if (path === "/my-results") return recentResults;
  if (path === "/my-ratings") return { competitive: { rounds: [] }, casual: { rounds: [] } };
  return {};
}

const tagState = {};
const vite = await createServer({
  configFile: false, cacheDir: await mkdtemp(join(tmpdir(), "gvdg-member-visual-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_VISUAL_PORT || 5188), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{
    name: "member-visual-qa",
    configureServer(server) {
      server.middlewares.use(async (request, res, next) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === pageName) {
          const mode = url.searchParams.get("mode") || "blue";
          const font = localFont ? '<style>@font-face{font-family:Archivo;src:url(' + fontAsset + ');font-weight:400 900;font-display:swap}</style>' : "";
          const html = (await readFile("gvdg-members.html", "utf8"))
            .replace(/<link[^>]+https:[^>]+>/g, "")
            .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
            .replace('data-auth-base=""', 'data-auth-base="' + apiRoot + '"')
            .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"')
            .replace("<head>", "<head>" + seed(mode) + font + (url.searchParams.has("large") ? "<style>html { font-size: 20px; }</style>" : ""));
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(await server.transformIndexHtml(pageName, html));
        } else if (url.pathname === fontAsset && localFont) {
          res.writeHead(200, { "Content-Type": "font/woff2" });
          res.end(localFont);
        } else if (url.pathname.startsWith(apiRoot + "/")) {
          const path = url.pathname.slice(apiRoot.length);
          const ref = request.headers.referer ? new URL(request.headers.referer) : null;
          const mode = ref?.searchParams.get("mode") || "blue";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response(path, { mode }, tagState, request)));
        } else next();
      });
    },
  }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
if (process.env.GVDG_VISUAL_SERVE) {
  console.log(origin + pageName + "?mode=blue#home");
  console.log(origin + pageName + "?mode=blue&large#home");
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  await vite.close();
  process.exit(0);
}

await mkdir(images, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const sample of [
    { width: 390, height: 844, mode: "blue" },
    { width: 320, height: 780, mode: "blue", large: true },
    { width: 390, height: 844, mode: "light" },
    { width: 390, height: 844, mode: "dark" },
    { width: 1280, height: 900, mode: "blue" },
    { width: 1280, height: 900, mode: "light" },
    { width: 1280, height: 900, mode: "dark" },
  ]) {
    const { width, height, mode, large } = sample;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin + pageName + "?mode=" + mode + (large ? "&large" : "") + "#home", { waitUntil: "commit" });
      await page.getByRole("heading", { name: title }).waitFor();
      await page.getByRole("link", { name: /Continue round/ }).waitFor();
      await page.getByRole("link", { name: /Wallet.*\$32.50/ }).waitFor();
      await page.getByRole("button", { name: "Request a tag" }).waitFor();
      await page.getByText("2 of 3 complete").waitFor();
      if (mode === "blue") await page.locator("body.player-theme-active").waitFor();
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({
        profile: getComputedStyle(document.querySelector(".player-home-hero")).display,
        content: document.querySelector("#members").scrollWidth <= document.querySelector("#members").clientWidth,
        header: document.querySelector(".member-app-header .logo").getBoundingClientRect().right <=
          document.querySelector(".member-header-controls").getBoundingClientRect().left,
        navigation: innerWidth < 900 || document.querySelector(".player-app-nav").getBoundingClientRect().right <
          document.querySelector(".player-home").getBoundingClientRect().left,
      }));
      assert.deepEqual(dimensions, { profile: "grid", content: true, header: true, navigation: true });
      const name = mode + "-" + width + (large ? "-large" : "");
      await page.screenshot({ path: join(images, name + ".png"), animations: "disabled" });
      await page.getByText("Getting started", { exact: true }).click();
      await page.getByRole("button", { name: "Dismiss getting started" }).waitFor();
      await page.getByText("Profile set up", { exact: true }).waitFor();
      await page.getByText("First round started", { exact: true }).waitFor();
      await page.screenshot({ path: join(images, name + "-onboarding.png"), animations: "disabled" });
      await page.getByRole("button", { name: "Dismiss getting started" }).click();
      assert.equal(await page.getByText("Getting started", { exact: true }).count(), 0);
      await page.getByRole("link", { name: /Wallet.*\$32.50/ }).click();
      await page.getByRole("heading", { name: "Wallet", level: 1 }).waitFor();
      await page.goBack();
      await page.getByRole("button", { name: /Membership and profile/ }).click();
      await page.getByRole("heading", { name: "Account", level: 1 }).waitFor();
      assert.deepEqual(errors, []);
      console.log(name + " screenshot and Home actions verified");
    } finally { await context.close(); }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await page.goto(origin + pageName + "?mode=blue#home");
  await page.getByRole("button", { name: "Request a tag" }).click();
  await page.getByText("Request sent", { exact: true }).waitFor();
  await page.goto(origin + pageName + "?mode=holder#home");
  await page.getByRole("heading", { name: "Bag tag #12" }).waitFor();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Tags updated.", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Challenge" }).selectOption("tagmate");
  await page.getByLabel("Your score").fill("54");
  await page.getByLabel("Their score").fill("55");
  await page.getByRole("button", { name: "Send challenge" }).click();
  await page.getByText("Challenge sent. They confirm the scores.").waitFor();
  assert.equal(tagState.challengeSent, true);
  console.log("Request, answer and create bag tag challenge verified");
  const navigation = page.getByRole("navigation", { name: "Member app" });
  for (const label of ["Play", "Events", "Stats", "Club", "Home"]) {
    const button = navigation.getByRole("button", { name: label, exact: true });
    await button.click();
    await page.getByRole("heading", { name: label, level: 1, exact: true }).waitFor();
    assert.equal(await button.getAttribute("aria-current"), "page");
  }
  await page.close();

  for (const width of [320, 390, 1280]) {
    const practice = await browser.newPage({ viewport: { width, height: 844 }, serviceWorkers: "block" });
    try {
      await practice.goto(origin + pageName + "?mode=blue" + (width === 320 ? "&large" : "") + "#practice", { waitUntil: "commit" });
      const rail = practice.getByRole("group", { name: "Practice type" });
      const bounds = await Promise.all(["Putting", "Fieldwork", "My bag"].map(async (label) => {
        const button = rail.getByRole("button", { name: label, exact: true });
        await button.waitFor();
        return button.boundingBox();
      }));
      assert.equal(new Set(bounds.map((box) => box.y)).size, 1);
      assert.ok(bounds.every((box) => box.height >= 44));
      assert.ok(Math.max(...bounds.map((box) => box.width)) - Math.min(...bounds.map((box) => box.width)) < 1);
      const deleteButton = practice.getByRole("button", { name: "Delete putting session from 2026-11-13" });
      await deleteButton.waitFor();
      assert.ok((await deleteButton.boundingBox()).width < 100);
      await practice.screenshot({ path: join(images, "practice-" + width + ".png"), animations: "disabled" });
      await deleteButton.click();
      await practice.getByRole("dialog", { name: "Delete this putting session?" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await deleteButton.waitFor();
      await rail.getByRole("button", { name: "Fieldwork" }).click();
      await practice.getByText("Axiom Envy · 215 ft", { exact: true }).waitFor();
      await practice.getByRole("button", { name: "Log a measured throw" }).click();
      await practice.screenshot({ path: join(images, "fieldwork-form-" + width + ".png"), animations: "disabled" });
      await rail.getByRole("button", { name: "My bag" }).click();
      await practice.getByRole("heading", { name: "Axiom Envy" }).waitFor();
      await practice.screenshot({ path: join(images, "bag-" + width + ".png"), animations: "disabled" });
      console.log("Practice and bag at " + width + "px verified");
    } finally { await practice.close(); }
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log("Screenshots " + images);
