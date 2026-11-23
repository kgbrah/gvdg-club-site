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
  if (path === "/me") return { ...member, isAdmin: query.admin };
  if (path === "/me/dashboard-theme") return { theme: query.mode === "blue" ? theme : null };
  if (path === "/me/practice") return { owner: member.sub, discs: [disc],
    throws: { items: [measured], next: null }, putting: { items: [putting], next: null },
    puttingTotals: { attempts: 25, makes: 18, sessions: 1 }, puttingTrends: [],
    throwGroups: [{ discId, shotType: "backhand", throws: 1, averageMeters: 65.532, farthestMeters: 65.532 }],
  };
  if (path === "/rounds/RIVER7/live/mine") return { status: "live", cardId: 1, cardmates: [{ name: "Morgan" }, { name: "Jordan" }] };
  if (path === "/my-live-rounds") return { rounds: [] };
  // PDGA's official API only: the official rating and its date.
  if (path === "/pdga-stats") return { name: title, official_rating: 913, rating_date: "2026-11-01", live_rating: 922, peak_rating: 941, previous_rating: null, events: [], play_rounds: [], source: "pdga-api" };
  if (path === "/pdga-registrations") return { mine: [], club: [] };
  if (path === "/shop/wallet") return { balance_cents: 3250,
    transactions: [{ id: 1, amount_cents: 3250, source: "event_payout", created_at: "2026-11-13T19:30:00Z" }] };
  if (path === "/bag-tags/challenges" && request.method === "POST" && tagState.lastBody?.leagueId) {
    tagState.leagueChallengeSent = true;
    return { challenge: { id: 31, leagueId: tagState.lastBody.leagueId } };
  }
  if (path === "/bag-tags/request" && request.method === "POST") { tagState.requested = true; return { ok: true }; }
  if (path === "/bag-tags/challenges" && request.method === "POST") { tagState.challengeSent = true; return { ok: true }; }
  if (/^\/bag-tags\/challenges\/21\/(confirm|decline)$/.test(path)) { tagState.leagueAnswered = true; return { ok: true }; }
  if (/^\/bag-tags\/challenges\/\d+\/(confirm|decline)$/.test(path)) { tagState.answered = true; return { ok: true }; }
  if (path === "/bag-tags/mine" && ["league", "expired", "leagueonly", "notag"].includes(query.tags)) {
    const series = query.tags === "notag" ? { id: 1, name: "Greenville 2026" } : { id: 1, name: "Greenville 2026" };
    if (query.tags === "notag") return { series, mine: null, holders: [], challenges: [], leagues: [] };
    const league = { id: 4, name: "Sunday Baggers" };
    const holders = [
      { tagNumber: 1, name: "Michael Fazzini", memberId: "m_mf", linked: true },
      { tagNumber: 2, name: "Pat Guest", linked: false },
      { tagNumber: 5, name: "Jordan Ellis", memberId: "m_je", linked: true },
      { tagNumber: 9, name: member.name, memberId: member.sub, linked: true },
      { tagNumber: 11, name: "Riley Park", memberId: "m_rp", linked: true },
    ];
    const incoming = query.tags === "league" && !tagState.leagueAnswered
      ? [{ id: 21, leagueId: 4, defenderId: member.sub, defenderName: member.name, challengerId: "m_rp", challengerName: "Riley Park",
        defenderTag: 9, challengerTag: 11, challengerScore: 51, defenderScore: 53, status: "pending" }] : [];
    const closed = query.tags === "expired"
      ? [{ id: 22, leagueId: 4, challengerId: member.sub, challengerName: member.name, defenderId: "m_je", defenderName: "Jordan Ellis",
        challengerTag: 9, defenderTag: 5, status: "expired", closedNote: "expired: ladder refreshed from UDisc" }] : [];
    const moves = [
      { id: 5, kind: "import", summary: "Ladder reset to UDisc's order (5 players)", appOnly: false },
      { id: 4, kind: "challenge", summary: "Challenge: Riley Park #8 \u2192 #7, Jordan Ellis #7 \u2192 #8", appOnly: true },
    ];
    const clubSeries = query.tags === "leagueonly" ? { series: null, mine: null }
      : { series, mine: { memberId: member.sub, tagNumber: 12, name: member.name },
        holders: [{ memberId: "tagmate", tagNumber: 7, name: "Jordan" }], challenges: [] };
    return { ...clubSeries, leagues: [{ league, holders, mine: { memberId: member.sub, name: member.name, tagNumber: 9 },
      challenges: incoming, closed, moves }] };
  }
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
          if (request.method === "POST") {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            try { tagState.lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { tagState.lastBody = {}; }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response(path, { mode, tags: ref?.searchParams.get("tags") || "", admin: ref?.searchParams.has("admin") === true }, tagState, request)));
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
    { width: 390, height: 844, mode: "blue", admin: true },
    { width: 320, height: 780, mode: "blue", large: true, admin: true },
    { width: 320, height: 780, mode: "light", large: true },
    { width: 320, height: 780, mode: "dark", large: true },
    { width: 390, height: 844, mode: "light" },
    { width: 390, height: 844, mode: "dark", admin: true },
    { width: 1280, height: 900, mode: "blue", admin: true },
    { width: 1280, height: 900, mode: "light" },
    { width: 1280, height: 900, mode: "dark" },
  ]) {
    const { width, height, mode, large, admin } = sample;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
    await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin + pageName + "?mode=" + mode + (large ? "&large" : "") + (admin ? "&admin" : "") + "#home", { waitUntil: "commit" });
      await page.getByRole("heading", { name: title }).waitFor();
      assert.equal(await page.getByRole("heading", { name: "Home", level: 1, exact: true }).count(), 1);
      assert.equal(await page.getByRole("navigation", { name: "Member app" }).getByRole("button", { name: "Home", exact: true }).getAttribute("aria-current"), "page");
      assert.equal(await page.getByRole("link", { name: "Admin portal", exact: true }).count(), 0);
      await page.getByRole("link", { name: /Continue round/ }).waitFor();
      await page.getByRole("link", { name: /Wallet.*\$32.50/ }).waitFor();
      await page.getByRole("button", { name: "Request a tag" }).waitFor();
      await page.getByText("2 of 3 complete").waitFor();
      if (mode === "blue") await page.locator("body.player-theme-active").waitFor();
      await page.evaluate(() => document.fonts.ready);
      const dimensions = await page.evaluate(() => ({
        profile: getComputedStyle(document.querySelector(".player-home-hero")).display,
        headerGap: document.querySelector(".player-home-hero").getBoundingClientRect().top - document.querySelector(".member-app-header").getBoundingClientRect().bottom,
        titleClipped: getComputedStyle(document.querySelector(".member-home-heading")).clipPath === "inset(50%)",
        content: document.querySelector("#members").scrollWidth <= document.querySelector("#members").clientWidth,
        header: document.querySelector(".member-app-header .logo").getBoundingClientRect().right <=
          document.querySelector(".member-header-controls").getBoundingClientRect().left,
        navigation: innerWidth < 900 || document.querySelector(".player-app-nav").getBoundingClientRect().right <
          document.querySelector(".player-home").getBoundingClientRect().left,
      }));
      const { headerGap, ...flags } = dimensions;
      assert.deepEqual(flags, { profile: "grid", titleClipped: true, content: true, header: true, navigation: true });
      assert.ok(headerGap >= 0 && headerGap <= 35, "profile starts close below the app header: " + headerGap);
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
      const account = page.locator("[data-react-member-account]");
      await account.getByRole("button", { name: "Edit profile", exact: true }).waitFor();
      const portal = page.getByRole("link", { name: "Admin portal", exact: true });
      if (admin) {
        await portal.waitFor();
        assert.equal(await portal.count(), 1);
        assert.equal(await portal.getAttribute("href"), "admin.html");
        assert.equal(await account.locator(":scope > :first-child").getAttribute("data-react-admin-portal"), "ready");
      } else {
        assert.equal(await portal.count(), 0);
      }
      const typography = await account.locator(".player-more-item, .member-link-copy strong, .player-logout-btn, .member-admin-copy strong").evaluateAll((rows) => rows.map((row) => {
        const style = getComputedStyle(row);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight];
      }));
      assert.ok(typography.length >= 7);
      assert.equal(new Set(typography.map((font) => font.join("|"))).size, 1, "Account controls share font, size, weight and line-height");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      if (mode === "blue") assert.ok(await page.evaluate(() => getComputedStyle(document.body).backgroundImage.includes("data:image/jpeg")));
      await page.screenshot({ path: join(images, name + (admin ? "-admin" : "-member") + "-account.png"), animations: "disabled" });
      assert.deepEqual(errors, []);
      console.log(name + " screenshot, Home spacing, and Account access and typography verified");
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

  const leagueShots = process.env.GVDG_LEAGUE_IMAGES || images;
  await mkdir(leagueShots, { recursive: true });
  for (const theme of ["light", "dark"]) {
    tagState.leagueAnswered = false;
    const bag = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    try {
      const bagErrors = [];
      bag.on("pageerror", (error) => bagErrors.push(error.message));
      // Home: club row, league row, and the incoming league challenge names the league.
      await bag.goto(origin + pageName + "?mode=" + theme + "&tags=league#home", { waitUntil: "commit" });
      await bag.getByRole("heading", { name: "Sunday Baggers" }).waitFor();
      const incoming = bag.locator(".tag-incoming");
      await incoming.getByText("Sunday Baggers: Riley Park called out your #9. They shot 51, you shot 53.").waitFor();
      await bag.screenshot({ path: join(leagueShots, "home-incoming-league-" + theme + ".png"), animations: "disabled" });
      if (theme === "dark") {
        await incoming.getByRole("button", { name: "Confirm", exact: true }).click();
        await bag.getByText("Tags updated.", { exact: true }).waitFor();
        assert.equal(tagState.leagueAnswered, true);
      }
      // Bag tags screen: the club series and the league ladder, each with its own flags and form.
      await bag.goto(origin + pageName + "?mode=" + theme + "&tags=league#tags", { waitUntil: "commit" });
      const league = bag.locator("[data-bag-tag-league='4']");
      await league.getByText("Imported from UDisc. The ladder resets to UDisc's order at each import (Sundays 3pm). Record challenge results in UDisc to keep them.").waitFor();
      assert.deepEqual(await league.locator(".tag-ladder-row").evaluateAll((rows) => rows.map((row) => row.textContent)), ["#1Michael FazziniCan challenge", "#2Pat Guest", "#5Jordan EllisCan challenge", "#9Taylor MorganYou", "#11Riley Park"]);
      assert.equal(await league.getByText("Pat Guest").locator("xpath=..").getByText("Can challenge").count(), 0);
      assert.equal(await bag.locator("[data-react-bag-tags='ready']").first().getByText("Bag tag #12").count(), 1);
      assert.equal(await bag.locator(".tag-challenge-form:visible").count(), 2);
      await league.getByText("App challenge (not in UDisc): Challenge: Riley Park #8").waitFor();
      await bag.screenshot({ path: join(leagueShots, "bag-tags-club-and-league-" + theme + ".png"), fullPage: true, animations: "disabled" });
      if (theme === "dark") {
        const form = league.locator(".tag-challenge-form");
        await form.getByRole("combobox", { name: "Challenge" }).selectOption("m_je");
        await form.getByLabel("Your score").fill("50");
        await form.getByLabel("Their score").fill("52");
        await form.scrollIntoViewIfNeeded();
        await bag.screenshot({ path: join(leagueShots, "league-challenge-form-" + theme + ".png"), animations: "disabled" });
        await form.getByRole("button", { name: "Send challenge" }).click();
        await league.getByText("Challenge sent. They confirm the scores.").waitFor();
        assert.equal(tagState.leagueChallengeSent, true);
        assert.equal(tagState.lastBody.leagueId, 4);
      }
      assert.deepEqual(bagErrors, []);
    } finally { await bag.close(); }
  }
  const expired = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await expired.goto(origin + pageName + "?mode=dark&tags=expired#tags", { waitUntil: "commit" });
  const expiredNote = expired.locator("p.tag-closed:visible", { hasText: "Your challenge to Jordan Ellis (#5) ended (expired: ladder refreshed from UDisc)." });
  await expiredNote.waitFor();
  await expired.screenshot({ path: join(leagueShots, "league-challenge-expired-dark.png"), fullPage: true, animations: "disabled" });
  await expired.goto(origin + pageName + "?mode=dark&tags=expired#home", { waitUntil: "commit" });
  await expired.locator("p.tag-closed:visible", { hasText: "Sunday Baggers: Your challenge to Jordan Ellis (#5) ended (expired: ladder refreshed from UDisc)." }).waitFor();
  await expired.close();
  const noTag = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await noTag.goto(origin + pageName + "?mode=dark&tags=notag#tags", { waitUntil: "commit" });
  await noTag.locator("[data-bag-tag-hint]:visible", { hasText: "Challenges unlock once you hold a tag. Request a club tag, or join a bag-tag league." }).waitFor();
  await noTag.screenshot({ path: join(leagueShots, "no-tag-hint-dark.png"), animations: "disabled" });
  await noTag.close();
  console.log("League bag tags verified: Home card, ladder, form, expired notice and no-tag hint");
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
      await rail.waitFor();
      assert.equal(await practice.getByRole("button", { name: "‹ Play", exact: true }).count(), 0);
      assert.equal(await practice.getByRole("navigation", { name: "Member app" })
        .getByRole("button", { name: "Play", exact: true }).getAttribute("aria-current"), "page");
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
