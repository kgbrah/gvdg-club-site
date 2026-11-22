// Browser QA for club-run PDGA event registration: the public event page panel (rules, PDGA number check, sign-up,
// payment quote with PayPal's fee, the gift instead of Disc Golf Scene's fee, Zelle) and the admin tournament panel
// (settings, PDGA event lookup, Zelle received, offer a spot, the pre-registration CSV), against a stateful fake API.
// Run: node scripts/qa/tournament-registration-browser-qa.mjs   (GVDG_TOURNAMENT_SHOTS=<dir> keeps screenshots)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const shots = process.env.GVDG_TOURNAMENT_SHOTS || await mkdtemp(join(tmpdir(), "gvdg-tournament-shots-"));
await mkdir(shots, { recursive: true });

const players = {
  "80024": { pdgaNumber: "80024", name: "Ada Lovelace", membershipStatus: "current", membershipExpires: "2027-12-31", rating: 905, ratingDate: "2026-11-11", url: "https://www.pdga.com/player/80024" },
  "70007": { pdgaNumber: "70007", name: "Cy Young", membershipStatus: "expired", membershipExpires: "2025-12-31", rating: null, url: "https://www.pdga.com/player/70007" },
};
let state;
function reset() {
  state = { regs: [], nextId: 1, settings: { pdgaEventId: 104547, pdgaEvent: { id: 104547, name: "Greenville Fall Classic", tier: "C", startDate: "2026-12-12" },
    rules: { membersOnly: false, nonMemberFeeCents: 1000, divisionLimits: { MA3: 899 } }, playerCap: 72, paypalFeePassthrough: true,
    zelleTo: "pay@gvdgclub.test", zelleName: "GVDG Club", tdEmail: "td@gvdgclub.test", divisions: ["MPO", "MA3"] }, saved: [] };
}
reset();
const config = { event_id: 7, registration_open: 1, entry_fee_cents: 5000, divisions: '["MPO","MA3"]', ctp_fee_cents: 500 };
const coverFee = (base) => { let t = Math.ceil((base + 49) * 10000 / 9651); while (t - 1 - Math.round((t - 1) * 349 / 10000) - 49 >= base) t--; return t - base; };
const dgs = (cents) => 184 + Math.ceil(cents * 349 / 10000);
function owed(reg) { return 5000 + (reg.addons?.ctp ? 500 : 0) + (reg.pdga_status === "current" ? 0 : 1000); }
function quote(reg, method, donate) {
  const o = owed(reg);
  const saved = Math.max(0, dgs(o) - (method === "paypal" ? coverFee(o) : 0));
  const gift = donate ? saved : 0;
  const fee = method === "paypal" ? coverFee(o + gift) : 0;
  return { method, owedCents: o, feeCents: fee, donationCents: gift, totalCents: o + gift + fee, savedVsDgsCents: saved };
}
function view() {
  const paid = state.regs.filter((r) => r.paid_entry === 1);
  const wait = state.regs.filter((r) => r.waitlisted === 1);
  return { pdgaEventId: 104547, pdgaEventUrl: "https://www.pdga.com/tour/event/104547", pdgaEvent: { name: "Greenville Fall Classic", tier: "C" },
    rules: state.settings.rules, cap: 72, spotsLeft: 72 - paid.length, field: paid.map((r) => ({ name: r.name, division: r.division })),
    waitlist: wait.map((r, i) => ({ position: i + 1, name: r.name, division: r.division })),
    payments: { paypalFeeCovered: true, zelle: { to: "pay@gvdgclub.test", name: "GVDG Club" } }, tdEmail: "td@gvdgclub.test",
    attribution: "Player, event, and course data provided by PDGA" };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

// The real page's styles (its <style> blocks and stylesheet links) and body classes, so screenshots look as they will.
async function pageLook(file) {
  const html = await readFile(file, "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const styles = [...head.matchAll(/<style[\s\S]*?<\/style>|<link[^>]+rel="stylesheet"[^>]*>/g)].map((match) => match[0]).join("\n");
  const bodyClass = (html.match(/<body[^>]*class="([^"]*)"/) || [])[1] || "";
  return { styles, bodyClass };
}
const looks = { public: await pageLook("events.html"), admin: await pageLook("admin.html") };
looks.form = looks.admin;
const harness = (component) => `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${looks[component].styles}<title>QA</title></head><body class="${looks[component].bodyClass}" data-api-base="/fixture" data-auth-base="/fixture"><main style="padding:16px">
<div id="root"></div></main><script type="module">
import React from "react"; import { createRoot } from "react-dom/client";
${component === "public"
    ? `import { TournamentRegistration } from "/src/public-app/tournament-registration.js";
import { installOutsideLinkHandoff } from "/src/shared/outside-link.js";
installOutsideLinkHandoff(); // as public-app/main.js does
createRoot(document.getElementById("root")).render(React.createElement(TournamentRegistration, { event: { id: 7, name: "Greenville Fall Classic", pdga_event_id: 104547 } }));`
    : component === "form" ? `import { AdminEventForm } from "/src/admin-app/event-form.js";
localStorage.setItem("gvdg_member_token", "admin-token");
createRoot(document.getElementById("root")).render(React.createElement(AdminEventForm));`
    : `import { AdminTournamentPanel } from "/src/admin-app/tournament-panel.js";
localStorage.setItem("gvdg_member_token", "admin-token");
createRoot(document.getElementById("root")).render(React.createElement(AdminTournamentPanel, { eventId: 7 }));`}
</script></body></html>`;

const vite = await createServer({
  configFile: false,
  cacheDir: await mkdtemp(join(tmpdir(), "gvdg-tournament-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_TOURNAMENT_PORT || 5231), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{ name: "tournament-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (["/public.html", "/admin.html", "/form.html"].includes(url.pathname) && !url.search.includes("html-proxy")) {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await server.transformIndexHtml(url.pathname, harness(url.pathname.slice(1, -5))));
        return;
      }
      if (!url.pathname.startsWith("/fixture/")) return next();
      const key = url.pathname.slice("/fixture".length);
      const reply = (data, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
      const gt = url.searchParams.get("gt");
      const mine = (token) => state.regs.find((r) => r.guestToken === token) || null;
      if (key === "/payments/config") return reply({ enabled: false });
      if (key === "/pdga/player") return reply({ player: players[url.searchParams.get("number")] || null });
      if (key === "/events/7/registration") return reply({ config, registration: mine(gt), tournament: view() });
      if (key === "/events/7/register" && request.method === "POST") {
        const b = await body(request);
        const p = b.pdgaNumber ? players[b.pdgaNumber] : null;
        if (b.pdgaNumber && !p) return reply({ error: "pdga_not_found" }, 400);
        if (b.division === "MA3" && p && p.rating > 899) return reply({ error: "division_rating_limit", limit: 899, rating: p.rating }, 403);
        const reg = { id: state.nextId++, guestToken: "tok" + state.nextId, name: b.name || p?.name, division: b.division, addons: b.addons,
          pdga_number: b.pdgaNumber || null, pdga_status: p?.membershipStatus || null, paid_entry: 0, waitlisted: 0 };
        state.regs.push(reg);
        return reply({ registration: reg, guestToken: reg.guestToken }, 201);
      }
      if (key === "/events/7/register" && request.method === "DELETE") { state.regs = state.regs.filter((r) => r.guestToken !== gt); return reply({ ok: true }); }
      if (key === "/events/7/pay/quote") {
        return reply({ quote: quote(mine(gt), url.searchParams.get("method"), url.searchParams.get("donate") === "1") });
      }
      if (key === "/events/7/pay/zelle") {
        const b = await body(request);
        const reg = mine(b.guestToken);
        const q = quote(reg, "zelle", b.donate);
        Object.assign(reg, { payment_method: "zelle", zelle_code: "GV7-1ABC", donation_cents: q.donationCents });
        return reply({ registration: reg, quote: q, zelle: { to: "pay@gvdgclub.test", name: "GVDG Club", amountCents: q.totalCents, memo: "GV7-1ABC" } });
      }
      if (key === "/events/7/pay/zelle/sent") { const reg = mine((await body(request)).guestToken); reg.zelle_sent_at = new Date().toISOString(); return reply({ registration: reg }); }
      // Admin
      if (key === "/admin/events/7/tournament" && request.method === "GET") return reply({ settings: state.settings });
      if (key === "/admin/events/7/tournament" && request.method === "PUT") {
        const b = await body(request);
        state.saved.push(b);
        state.settings = { ...state.settings, ...b, rules: b.rules };
        return reply({ settings: state.settings });
      }
      if (key === "/admin/pdga-events/104547") return reply({ event: state.settings.pdgaEvent });
      if (key === "/admin/events/7/pdga-players") {
        const header = ["DivCode", "First Name", "Last Name", "PDGA", "Start"];
        const rows = [["MPO", "Ada", "Lovelace", "80024", ""], ["MA3", "Cy", "Young", "70007", "Waitlist #1"]];
        return reply({ pdgaEventId: 104547, header, rows, text: [header, ...rows].map((row) => row.join("\t")).join("\n") + "\n", registered: 1, waitlisted: 1, unpaid: 1, noDivision: 0, noPdga: 0 });
      }
      if (key === "/admin/events/7/pdga-results") {
        const header = ["DivCode", "T.O.", "Place", "First Name", "Last Name", "PDGA", "Rd1", "Rd2"];
        const rows = [["MA3", "", "1", "Ada", "Lovelace", "80024", "54", "52"], ["MPO", "", "", "Cy", "Young", "70007", "50", ""]];
        return reply({ pdgaEventId: 104547, rounds: [{ eventId: 7, name: "Greenville Fall Classic", date: "2026-12-12" }, { eventId: 8, name: "Greenville Fall Classic R2", date: "2026-12-13" }],
          header, rows, text: [header, ...rows].map((row) => row.join("\t")).join("\n") + "\n", players: 2, missingScores: 1, noDivision: 0, noPdga: 0, extraRounds: 0 });
      }
      if (key === "/admin/events/7/registrations") return reply({ registrations: state.regs.map((r) => ({ ...r, amount_paid_cents: r.paid_entry ? 5000 : 0 })) });
      const act = key.match(/^\/admin\/events\/7\/registrations\/(\d+)\/(zelle-received|offer)$/);
      if (act) {
        const reg = state.regs.find((r) => r.id === Number(act[1]));
        if (act[2] === "offer") Object.assign(reg, { waitlisted: 0, offered_at: new Date().toISOString() });
        else Object.assign(reg, { paid_entry: 1, paid_at: (await body(request)).receivedAt || new Date().toISOString(), payment_method: "zelle" });
        return reply({ registration: reg });
      }
      return reply({ error: "unexpected " + key }, 404);
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function open(path, width = 390, { userAgent, installed = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, serviceWorkers: "block", ...(userAgent ? { userAgent } : {}) });
  // The club app opened from the home screen (iPhone reports navigator.standalone).
  if (installed) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true }));
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push("console: " + message.text().slice(0, 300)); });
  await page.goto(origin + path);
  return { page, context, errors };
}
async function noOverflow(page, label) {
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
    .map((el) => el.tagName + "." + el.className + " " + (el.textContent || "").trim().slice(0, 30)));
  assert.deepEqual(wide, [], label + " has content past the screen edge");
}

try {
  // Public: sign up with a PDGA number, see the quote, pay by Zelle with the gift.
  {
    const { page, context, errors } = await open("/public.html");
    const panel = page.locator("[data-tournament-registration]");
    await panel.waitFor();
    assert.equal(await panel.getAttribute("data-tournament-registration"), "open");
    assert.equal(await page.getByRole("link", { name: "Greenville Fall Classic" }).getAttribute("href"), "https://www.pdga.com/tour/event/104547");
    const rules = await page.locator(".tournament-rules").innerText();
    for (const text of ["Entry $50.00", "$10.00 added for players who aren't current PDGA members", "MA3: rated 899 or below", "Field capped at 72 players (72 left)", "entry fee is received"]) {
      assert.ok(rules.includes(text), "rules show: " + text);
    }
    assert.ok(await page.getByText("Player, event, and course data provided by").isVisible());
    // An expired PDGA member is pointed to PDGA's renewal (the club code is for signed-in members only).
    await page.getByLabel("PDGA number").fill("70007");
    await page.getByRole("button", { name: "Check" }).click();
    await page.locator("[data-pdga-renew]").waitFor();
    assert.equal(await page.getByRole("link", { name: "Renew with PDGA" }).getAttribute("href"), "https://www.pdga.com/membership/renew");
    assert.ok((await page.locator("[data-pdga-renew]").innerText()).includes("sign in to see it"));
    await page.getByLabel("PDGA number").fill("80024");
    await page.getByRole("button", { name: "Check" }).click();
    await page.getByRole("link", { name: "Ada Lovelace #80024" }).waitFor();
    assert.ok((await page.locator(".tournament-player").innerText()).includes("current PDGA member through 2027-12-31 · rated 905"));
    assert.equal(await page.locator("option[value=MA3]").evaluate((option) => option.disabled), true, "MA3 is closed to a 905");
    assert.equal(await page.getByLabel("Name").inputValue(), "Ada Lovelace");
    await page.screenshot({ path: join(shots, "public-signup-390.png"), fullPage: true });
    await noOverflow(page, "public sign-up");
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByText("You're signed up. Pay your entry").waitFor();
    await page.locator(".tournament-quote").waitFor();
    assert.ok((await page.locator(".tournament-quote").innerText()).replace(/\s+/g, " ").includes("Entry $50.00 PayPal's fee $2.32 Total $52.32"));
    await page.getByText("Online payment isn't available right now.").waitFor(); // PayPal off in this fixture
    await page.getByLabel("Zelle (no fee)").check();
    await page.getByLabel(/Give the club the \$3\.59 you're saving vs Disc Golf Scene/).check();
    await page.waitForFunction(() => document.querySelector(".tournament-quote")?.textContent.includes("$53.59"));
    await page.getByRole("button", { name: "Pay with Zelle" }).click();
    const zelle = await page.locator(".tournament-zelle").innerText();
    assert.ok(zelle.includes("Send $53.59 by Zelle to pay@gvdgclub.test (GVDG Club), with this memo: GV7-1ABC"), zelle);
    await page.screenshot({ path: join(shots, "public-zelle-390.png"), fullPage: true });
    await noOverflow(page, "public Zelle");
    await page.getByRole("button", { name: "I've sent it" }).click();
    await page.getByText("Thanks, the TD will confirm it.").waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Admin: settings, the field, Zelle received, the CSV.
  {
    const { page, context, errors } = await open("/admin.html", 1100);
    await page.locator("[data-admin-tournament=linked]").waitFor();
    assert.equal(await page.getByRole("link", { name: "Greenville Fall Classic" }).getAttribute("href"), "https://www.pdga.com/tour/event/104547");
    assert.ok(await page.getByText("/events#event/7").isVisible());
    const row = page.locator("[data-tournament-row]").first();
    assert.ok((await row.innerText()).includes("Zelle GV7-1ABC"));
    await row.getByRole("button", { name: "Zelle received" }).click();
    await page.getByText("Registered and paid (1 of 72)").waitFor();
    const csv = decodeURIComponent((await page.getByRole("link", { name: "Download the list (CSV)" }).getAttribute("href")).split(",").slice(1).join(","));
    assert.match(csv, /^List,Order,Name,PDGA #,Division,Paid at,Method\nRegistered,1,Ada Lovelace,80024,MPO,[^,]+,zelle\n$/);
    await page.getByLabel("MA3").fill("850");
    await page.getByRole("button", { name: "Save tournament settings" }).click();
    await page.getByText("Saved.").waitFor();
    assert.deepEqual(state.saved.at(-1).rules.divisionLimits, { MA3: "850" });
    assert.ok(await page.getByText("Player, event, and course data provided by").isVisible());
    // Results for PDGA Tournament Manager: the rows to paste, what to fix there, and a copy button.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    // Players for PDGA: the list to paste so players registered here show on pdga.com (owner: "Yes please").
    await page.getByRole("button", { name: "Get players for PDGA" }).click();
    const players = page.locator("[data-admin-pdga-players=ready]");
    await players.waitFor();
    assert.match(await page.getByLabel("Players for PDGA").inputValue(), /^DivCode\tFirst Name\tLast Name\tPDGA\tStart\nMPO\tAda\tLovelace\t80024\t\nMA3\tCy\tYoung\t70007\tWaitlist #1\n$/);
    assert.ok((await players.innerText()).includes("1 registered player · 1 on the waitlist · 1 signed up, not paid (not listed)"));
    await page.getByRole("button", { name: "Copy players for PDGA" }).click();
    await players.getByRole("button", { name: "Copied" }).waitFor();
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith("DivCode\tFirst Name\tLast Name\tPDGA"));
    await players.screenshot({ path: join(shots, "admin-pdga-players-1100.png") });
    await page.getByRole("button", { name: "Get results for PDGA" }).click();
    const results = page.locator("[data-admin-pdga-results=ready]");
    await results.waitFor();
    assert.match(await page.getByLabel("Results for PDGA").inputValue(), /^DivCode\tT\.O\.\tPlace\tFirst Name\tLast Name\tPDGA\tRd1\tRd2\nMA3\t\t1\tAda\tLovelace\t80024\t54\t52\n/);
    assert.ok((await results.innerText()).includes("2 players · Rd1: Greenville Fall Classic (2026-12-12) · Rd2: Greenville Fall Classic R2 (2026-12-13)"));
    assert.ok((await results.innerText()).includes("1 player is missing a round score"));
    await page.getByRole("button", { name: "Copy for PDGA" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith("DivCode\tT.O.\tPlace"));
    await results.screenshot({ path: join(shots, "admin-pdga-results-1100.png") });
    await page.screenshot({ path: join(shots, "admin-tournament-1100.png"), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Admin event form: mark the event a PDGA event; the PDGA lookup shows which event it is.
  {
    const { page, context, errors } = await open("/form.html", 1100);
    await page.getByLabel(/PDGA-sanctioned event/).check();
    await page.getByLabel("PDGA event number").fill("104547");
    await page.getByLabel("PDGA event number").blur();
    await page.getByRole("link", { name: "Greenville Fall Classic" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Greenville Fall Classic" }).getAttribute("href"), "https://www.pdga.com/tour/event/104547");
    assert.ok(await page.getByText("Player, event, and course data provided by").isVisible());
    // The PDGA number comes first and fills the name and date from PDGA; "Use PDGA's name and date" puts them back.
    assert.ok((await page.locator("[data-admin-event-pdga]").boundingBox()).y < (await page.locator("#aeName").boundingBox()).y, "the PDGA section sits above Name");
    assert.equal(await page.locator("#aeName").inputValue(), "Greenville Fall Classic");
    assert.equal(await page.locator("#aeDate").inputValue(), "2026-12-12");
    await page.locator("#aeName").fill("Fall Classic (club name)");
    await page.getByRole("button", { name: "Use PDGA's name and date" }).click();
    assert.equal(await page.locator("#aeName").inputValue(), "Greenville Fall Classic");
    assert.equal(await page.getByRole("button", { name: "Use PDGA's name and date" }).count(), 0, "nothing to use once they match");
    await page.locator("[data-admin-event-pdga=on]").screenshot({ path: join(shots, "admin-event-form-pdga-1100.png") });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // From the installed app on an iPhone, "Renew with PDGA" opens in Safari (where the player is signed in to pdga.com);
  // in a normal browser tab it's left as a new-tab link.
  for (const [label, installed, expected] of [["installed iphone", true, "x-safari-https://www.pdga.com/membership/renew"], ["iphone safari tab", false, ""]]) {
    const { page, context } = await open("/public.html", 390, { installed, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" });
    await page.locator("[data-tournament-registration]").waitFor();
    await page.getByLabel("PDGA number").fill("70007");
    await page.getByRole("button", { name: "Check" }).click();
    const renew = page.getByRole("link", { name: "Renew with PDGA" });
    await renew.waitFor();
    assert.equal(await renew.getAttribute("data-signup-link"), "true");
    const popup = context.waitForEvent("page", { timeout: 1500 }).catch(() => null);
    await renew.click({ noWaitAfter: true });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.outsideHandoff || "").catch(() => ""), expected, label);
    if (!expected) assert.ok(await popup, label + ": a normal tab opens PDGA in a new tab as before");
    await context.close();
  }
  console.log("tournament registration browser QA passed; screenshots in " + shots);
} finally {
  await browser.close();
  await vite.close();
}
