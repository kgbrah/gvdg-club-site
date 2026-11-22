// End to end: a PDGA event run by the club, from the admin's event form to PDGA's results upload, with the REAL PDGA API
// (owner: "Can you run a full end to end test of creating a PDGA event using PDGA API?").
// PDGA's API only reads: an event gets its number when the TD sanctions it on pdga.com. So "creating a PDGA event"
// here is the club's side of it, every step through the built pages and the real Worker (auth-worker/src, in-process
// through Vite SSR, with a throwaway in-memory database: nothing on gvdgclub.com changes and no member is notified):
//   1. A real upcoming PDGA event is found through the API.
//   2. Admin › New event: tick "PDGA-sanctioned event", enter its number; PDGA's name and date fill in; save links it.
//   3. Registration settings (open, $50 entry, MPO and MA3), then the PDGA settings: cap 2, MA3 rated 899 or below,
//      a $10 non-member fee, Zelle, the TD's email.
//   4. The public event page: the PDGA badge and credit; a guest enters a real PDGA number, the app checks it with
//      PDGA, divisions and the fee follow PDGA's actual answer, they register and pay by Zelle.
//   5. Admin: Zelle received; the player is in the field, on the pre-registration list, and in Players for PDGA (the
//      rows to paste into Tournament Manager so they show on pdga.com).
//   6. A second real PDGA number (a lapsed membership): the non-member fee and PDGA's renewal.
//   7. After the round (Events › Past › the event, its Results screen): Results for PDGA builds the rows for PDGA
//      Tournament Manager with the real PDGA numbers.
// Needs PDGA_API_USERNAME / PDGA_API_PASSWORD (GitHub secrets; never printed). Without them, GVDG_PDGA_FAKE=1 runs the
// same steps against a small stand-in for PDGA, to check the script itself.
//   npm run build && npm ci --prefix auth-worker && GVDG_QA_NO_SANDBOX=1 node scripts/qa/pdga-event-e2e-qa.mjs
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(repoRoot);
const shots = process.env.GVDG_PDGA_E2E_SHOTS || path.join(tmpdir(), "gvdg-pdga-e2e-" + process.pid);
await mkdir(shots, { recursive: true });

const realPdga = Boolean(process.env.PDGA_API_USERNAME && process.env.PDGA_API_PASSWORD);
if (!realPdga && process.env.GVDG_PDGA_FAKE !== "1") {
  console.error("No PDGA API login (PDGA_API_USERNAME / PDGA_API_PASSWORD). Set GVDG_PDGA_FAKE=1 to check the script against a stand-in.");
  process.exit(1);
}
// Players to check with PDGA: a current member with a high rating, and a lapsed membership. Public PDGA numbers.
const PLAYER = process.env.GVDG_PDGA_E2E_PLAYER || "27523";
const LAPSED = process.env.GVDG_PDGA_E2E_LAPSED || "1";

// ---- A stand-in for PDGA (only with GVDG_PDGA_FAKE=1) ----
let fakePdgaBase = "";
if (!realPdga) {
  const soon = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const fake = createHttpServer((request, response) => {
    const url = new URL(request.url || "/", "http://fake");
    const send = (data) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
    if (url.pathname.endsWith("/user/login")) return send({ sessid: "s", session_name: "SESS", token: "t" });
    if (url.pathname.endsWith("/event")) {
      return send({ events: [{ tournament_id: "104547", tournament_name: "Greenville Fall Classic", tier: "C", status: "sanctioned", start_date: soon, end_date: soon, city: "Greenville", state_prov: "NC", tournament_director: "Pat TD" }] });
    }
    if (url.pathname.endsWith("/players")) {
      const all = {
        [PLAYER]: { first_name: "Paul", last_name: "McBeth", pdga_number: PLAYER, membership_status: "current", membership_expiration_date: "2027-12-31", rating: "1045", classification: "P", city: "Huntington Beach", state_prov: "CA", country: "US" },
        [LAPSED]: { first_name: "Steady Ed", last_name: "Headrick", pdga_number: LAPSED, membership_status: "expired", membership_expiration_date: "2002-12-31", classification: "A" },
      };
      return send({ players: (url.searchParams.get("pdga_number") || "").split(",").flatMap((n) => all[n] ? [all[n]] : []) });
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakePdgaBase = `http://127.0.0.1:${fake.address().port}`;
}

function memoryKv() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => rows.get(key) ?? null,
    put: async (key, value) => { rows.set(key, value); },
    delete: async (key) => { rows.delete(key); },
    list: async (opts) => ({ keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })), list_complete: true }),
  };
}
const sqlite = new DatabaseSync(":memory:");
for (const file of (await readdir("auth-worker/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
  sqlite.exec(await readFile(path.join("auth-worker/migrations", file), "utf8"));
}
const DB = {
  prepare(sql) {
    let bound = [];
    const stmt = {
      bind(...args) { bound = args; return stmt; },
      async all() { return { results: sqlite.prepare(sql).all(...bound), success: true }; },
      async first() { return sqlite.prepare(sql).get(...bound) ?? null; },
      async run() { const info = sqlite.prepare(sql).run(...bound); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return stmt;
  },
  async batch(list) { const out = []; for (const stmt of list) out.push(await stmt.run()); return out; },
};

// Outside calls: PDGA goes through (counted), mail is captured, everything else fails fast.
const pdgaCalls = [];
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.pdga.com/") || (fakePdgaBase && url.startsWith(fakePdgaBase))) {
    pdgaCalls.push(new URL(url).pathname);
    return realFetch(input, init);
  }
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body || "{}"));
    mail.push({ to: body.to?.[0], subject: body.subject });
    return new Response(JSON.stringify({ id: "m" + mail.length }), { status: 200 });
  }
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  return new Response("offline in QA", { status: 503 });
};

const vite = await createViteServer({
  configFile: false, appType: "custom", logLevel: "warn",
  cacheDir: await mkdtemp(path.join(tmpdir(), "gvdg-pdga-e2e-vite-")),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const worker = (await vite.ssrLoadModule("/auth-worker/src/index.ts")).default;
const { signSession } = await vite.ssrLoadModule("/auth-worker/src/jwt.ts");
const { putMember } = await vite.ssrLoadModule("/auth-worker/src/roster.ts");
const pdgaApi = await vite.ssrLoadModule("/auth-worker/src/pdga-api.ts");

const SECRET = "qa-secret-" + "s".repeat(40);
const env = {
  ROSTER: memoryKv(), RATELIMIT: memoryKv(), DB, JWT_SECRET: SECRET, PIN_PEPPER: "qa-pepper-" + "p".repeat(32),
  SESSION_TTL_SEC: "2592000", ALLOWED_ORIGINS: "", RESEND_API_KEY: "re_qa", RATELIMIT_BACKEND: "d1",
  PDGA_API_USERNAME: process.env.PDGA_API_USERNAME || "qa", PDGA_API_PASSWORD: process.env.PDGA_API_PASSWORD || "qa",
  ...(fakePdgaBase ? { PDGA_API_BASE: fakePdgaBase } : {}),
};
await putMember(env.ROSTER, { memberId: "m_td", name: "Taylor TD", pdgaNo: "9000001", isAdmin: true, pinHash: "x", mustChangePin: false, email: "td@gvdg.test" });
const adminToken = await signSession({ sub: "m_td", mustChangePin: false }, SECRET, 3600);

const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"], [".webmanifest", "application/manifest+json"], [".jpg", "image/jpeg"], [".webp", "image/webp"]]);
let origin = "";
const server = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      headers.set("Origin", origin);
      headers.set("CF-Connecting-IP", "198.51.100.7");
      const pending = [];
      const result = await worker.fetch(new Request("https://worker.qa" + url.pathname.slice(4) + url.search, {
        method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      }), env, { waitUntil: (promise) => pending.push(promise) });
      while (pending.length) await Promise.allSettled(pending.splice(0));
      const out = {};
      result.headers.forEach((value, key) => { out[key] = value; });
      response.writeHead(result.status, out);
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.join(repoRoot, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(repoRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    let body = await readFile(file);
    if (file.endsWith(".html")) {
      body = Buffer.from(String(body)
        .replace(/\sdata-(?:auth|api)-base="[^"]*"/g, "")
        .replace("<body", `<body data-auth-base="${origin}/api" data-api-base="${origin}/api"`));
    }
    response.writeHead(200, { "Content-Type": (mime.get(path.extname(file)) || "application/octet-stream") + "; charset=utf-8" });
    response.end(body);
  } catch { response.writeHead(404); response.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
env.ALLOWED_ORIGINS = origin;
env.EXPECTED_ORIGIN = origin;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});
async function open(pagePath, { admin = false, width = 390 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource|favicon|fonts\.g|ERR_/.test(message.text() + message.location().url)) page.errors.push("console: " + message.text().slice(0, 300));
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  if (admin) await page.addInitScript((token) => localStorage.setItem("gvdg_member_token", token), adminToken);
  await page.goto(origin + pagePath);
  return { page, context };
}
/** Admin › Registration, then pick the event from the screen's own event menu (as an admin does). */
async function registrationScreen(page, eventId) {
  const picker = page.locator("#rgEvent");
  await picker.locator(`option[value="${eventId}"]`).waitFor({ state: "attached", timeout: 30_000 });
  if ((await picker.inputValue()) !== String(eventId)) await picker.selectOption(String(eventId));
  const panel = page.locator('[data-admin-tournament="linked"]');
  await panel.waitFor({ timeout: 30_000 });
  return panel;
}
const shot = (page, name) => page.screenshot({ path: path.join(shots, name + ".png"), fullPage: true });
const step = (text) => console.log("✔ " + text);
const money = (cents) => "$" + (cents / 100).toFixed(2);
const today = new Date().toISOString().slice(0, 10);

try {
  console.log(realPdga ? "Using the real PDGA API" : "Using a stand-in for PDGA (GVDG_PDGA_FAKE=1)");

  // 1. A real upcoming PDGA event (North Carolina first, then anywhere in the US Southeast), through the API.
  const until = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  let found = await pdgaApi.searchPdgaEvents(env, { startDate: today, endDate: until, states: ["NC"] });
  if (!found.length) found = await pdgaApi.searchPdgaEvents(env, { startDate: today, endDate: until, states: ["SC", "VA", "GA"] });
  const pdgaEvent = found.find((event) => event.startDate > today) || found[0];
  assert.ok(pdgaEvent, "PDGA lists an upcoming event to link");
  step(`PDGA event #${pdgaEvent.id}: ${pdgaEvent.name} (${pdgaEvent.tier || "?"}-tier, ${pdgaEvent.startDate}, ${[pdgaEvent.city, pdgaEvent.state].filter(Boolean).join(", ")})`);
  const player = await pdgaApi.lookupPdgaPlayer(env, PLAYER);
  const lapsed = await pdgaApi.lookupPdgaPlayer(env, LAPSED);
  assert.ok(player && lapsed, "PDGA knows both players");
  step(`PDGA #${PLAYER}: ${player.name}, ${player.membershipStatus}${player.rating ? ", rated " + player.rating : ""}; PDGA #${LAPSED}: ${lapsed.name}, ${lapsed.membershipStatus}`);

  // 2. Admin › New event: the PDGA number fills in PDGA's name and date; saving links it.
  let eventId;
  {
    const { page, context } = await open("/admin.html#create", { admin: true, width: 1100 });
    await page.getByLabel(/PDGA-sanctioned event/).check();
    await page.getByLabel("PDGA event number").fill(String(pdgaEvent.id));
    await page.getByLabel("PDGA event number").blur();
    await page.getByRole("link", { name: pdgaEvent.name }).first().waitFor();
    assert.equal(await page.getByRole("link", { name: pdgaEvent.name }).first().getAttribute("href"), `https://www.pdga.com/tour/event/${pdgaEvent.id}`);
    assert.equal(await page.locator("#aeName").inputValue(), pdgaEvent.name, "PDGA's name filled in");
    assert.equal(await page.locator("#aeDate").inputValue(), pdgaEvent.startDate.slice(0, 10), "PDGA's start date filled in");
    assert.ok(await page.getByText("Player, event, and course data provided by").first().isVisible(), "PDGA's credit");
    await shot(page, "1-admin-event-form");
    await page.locator("#aeSubmitBtn").click();
    await page.waitForFunction(() => /#registration/.test(location.hash) || document.querySelector("[data-admin-tournament]"), null, { timeout: 30_000 });
    const row = sqlite.prepare("SELECT id FROM events WHERE name = ? ORDER BY id DESC").get(pdgaEvent.name);
    assert.ok(row, "the event was created");
    eventId = row.id;
    await page.waitForFunction(() => document.querySelector('[data-admin-tournament="linked"]'), null, { timeout: 30_000 });
    const link = sqlite.prepare("SELECT pdga_event_id, pdga_event FROM event_config WHERE event_id = ?").get(eventId);
    assert.equal(Number(link.pdga_event_id), pdgaEvent.id, "linked to the PDGA event");
    assert.equal(JSON.parse(link.pdga_event).name, pdgaEvent.name, "PDGA's details are stored with it");
    assert.deepEqual(page.errors, []);
    await context.close();
    step(`Admin created event ${eventId} from PDGA #${pdgaEvent.id}; the name and date came from PDGA, and it's linked`);
  }

  // 3. Registration settings, then the PDGA settings on the event's Registration screen.
  {
    const { page, context } = await open(`/admin.html#registration`, { admin: true, width: 1100 });
    const saved = await page.evaluate(async ({ base, token, eventId }) => {
      const response = await fetch(`${base}/admin/events/${eventId}/config`, { method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ registration_open: 1, entry_fee_cents: 5000, ctp_fee_cents: 0, ace_fee_cents: 0, divisions: ["MPO", "MA3"], teams: [], play_format: null }) });
      return response.status;
    }, { base: origin + "/api", token: adminToken, eventId });
    assert.equal(saved, 200, "registration settings saved");
    await page.reload();
    const panel = await registrationScreen(page, eventId);
    await panel.getByLabel("Player cap (blank = no cap)").fill("2");
    await panel.getByLabel(/Non-member fee/).fill("10");
    await panel.getByLabel("MA3").fill("899");
    await panel.getByLabel(/Zelle to/).fill("pay@gvdg.test");
    await panel.getByLabel("Zelle account name").fill("GVDG Club");
    await panel.getByLabel(/TD email/).fill("td@gvdg.test");
    await panel.getByRole("button", { name: "Save tournament settings" }).click();
    await panel.getByText("Saved.").waitFor();
    await shot(page, "2-admin-pdga-settings");
    assert.deepEqual(page.errors, []);
    await context.close();
    step("Registration open ($50, MPO and MA3); PDGA settings saved: cap 2, MA3 rated 899 or below, $10 non-member fee, Zelle");
  }

  // 4. The public event page: a guest registers with a real PDGA number and pays by Zelle.
  const playerFee = player.membershipStatus === "current" ? 0 : 1000;
  const ma3Closed = player.rating != null && player.rating > 899;
  {
    const { page, context } = await open(`/events.html#event/${eventId}`);
    const panel = page.locator("[data-tournament-registration]");
    await panel.waitFor({ timeout: 30_000 });
    assert.equal(await panel.getAttribute("data-tournament-registration"), "open");
    assert.ok(await page.locator("#detail .pdga-badge").first().isVisible(), "the PDGA badge on the event");
    assert.ok(await page.getByText("Player, event, and course data provided by").first().isVisible(), "PDGA's credit");
    // The PDGA event's page links to it on pdga.com and credits PDGA (their attribution rules).
    const pdgaFact = page.locator(".detail-facts").getByRole("link", { name: `Event #${pdgaEvent.id} on pdga.com` });
    assert.equal(await pdgaFact.getAttribute("href"), `https://www.pdga.com/tour/event/${pdgaEvent.id}`);
    assert.ok(await page.locator(".detail-facts .pdga-credit").isVisible(), "PDGA's credit on the event page");
    const facts = await page.locator(".detail-facts").innerText();
    assert.ok(/Entry\s+\$50(?:\.00)?\b/i.test(facts) && /Divisions\s+MPO · MA3/i.test(facts), "the event's facts show the real entry fee and divisions: " + facts.replace(/\s+/g, " "));
    const rules = await page.locator(".tournament-rules").innerText();
    for (const text of ["Entry $50.00", "$10.00 added for players who aren't current PDGA members", "MA3: rated 899 or below", "Field capped at 2 players"]) assert.ok(rules.includes(text), "rules show: " + text);
    await panel.getByLabel("PDGA number").fill(PLAYER);
    await panel.getByRole("button", { name: "Check" }).click();
    await page.getByRole("link", { name: `${player.name} #${PLAYER}` }).waitFor();
    const about = await page.locator(".tournament-player").innerText();
    assert.ok(about.includes(player.membershipStatus === "current" ? "current PDGA member" : "isn't a current PDGA member") || about.toLowerCase().includes(player.membershipStatus), "PDGA's membership answer: " + about);
    if (player.rating) assert.ok(about.includes("rated " + player.rating), "PDGA's rating: " + about);
    assert.equal(await panel.locator("option[value=MA3]").evaluate((option) => option.disabled), ma3Closed, "MA3 follows PDGA's rating");
    await panel.getByLabel("Division").selectOption("MPO");
    assert.equal(await panel.getByLabel("Name").inputValue(), player.name, "the name comes from PDGA");
    await panel.getByLabel(/Email/).fill("player@gvdg.test");
    await shot(page, "3-public-sign-up");
    await panel.getByRole("button", { name: "Register" }).click();
    await page.getByText("You're signed up. Pay your entry").waitFor();
    await panel.getByLabel("Zelle (no fee)").check();
    const total = 5000 + playerFee;
    await page.waitForFunction((t) => document.querySelector(".tournament-quote")?.textContent.includes(t), money(total));
    await panel.getByRole("button", { name: "Pay with Zelle" }).click();
    const zelle = await page.locator(".tournament-zelle").innerText();
    assert.ok(zelle.includes(`Send ${money(total)} by Zelle to pay@gvdg.test (GVDG Club), with this memo:`), zelle);
    await panel.getByRole("button", { name: "I've sent it" }).click();
    await page.getByText("Thanks, the TD will confirm it.").waitFor();
    await shot(page, "4-public-zelle");
    assert.deepEqual(page.errors, []);
    await context.close();
    step(`${player.name} (#${PLAYER}) registered as a guest in MPO${ma3Closed ? " (MA3 closed to a " + player.rating + ")" : ""}, paying ${money(total)} by Zelle`);
  }

  // 5. Admin: the Zelle payment arrives; the player is in the field and on the pre-registration list.
  {
    const { page, context } = await open(`/admin.html#registration`, { admin: true, width: 1100 });
    await registrationScreen(page, eventId);
    const row = page.locator("[data-tournament-row]").filter({ hasText: player.name }).first();
    await row.getByRole("button", { name: "Zelle received" }).click();
    await page.getByText("Registered and paid (1 of 2)").waitFor();
    const csv = decodeURIComponent((await page.getByRole("link", { name: "Download the list (CSV)" }).getAttribute("href")).split(",").slice(1).join(","));
    assert.ok(csv.includes(`Registered,1,${player.name},${PLAYER},MPO`), csv);
    // Players for PDGA: the list to paste into Tournament Manager so they show on pdga.com.
    await page.getByRole("button", { name: "Get players for PDGA" }).click();
    await page.locator("[data-admin-pdga-players=ready]").waitFor();
    const list = await page.getByLabel("Players for PDGA").inputValue();
    const playerRaw = JSON.parse(sqlite.prepare("SELECT data FROM pdga_api_players WHERE pdga_number = ?").get(PLAYER).data);
    assert.equal(list, `DivCode\tFirst Name\tLast Name\tPDGA\nMPO\t${playerRaw.first_name}\t${playerRaw.last_name}\t${PLAYER}\n`, "the paid player, with PDGA's own names: " + list);
    await shot(page, "5-admin-paid");
    assert.deepEqual(page.errors, []);
    await context.close();
    step("Admin confirmed the Zelle payment: in the field (1 of 2), on the pre-registration list, and in Players for PDGA");
  }

  // 6. A lapsed PDGA membership: the non-member fee and PDGA's renewal.
  {
    const { page, context } = await open(`/events.html#event/${eventId}`);
    const panel = page.locator("[data-tournament-registration]");
    await panel.waitFor({ timeout: 30_000 });
    await panel.getByLabel("PDGA number").fill(LAPSED);
    await panel.getByRole("button", { name: "Check" }).click();
    await page.getByRole("link", { name: `${lapsed.name} #${LAPSED}` }).waitFor();
    if (lapsed.membershipStatus !== "current") {
      await panel.locator("[data-pdga-renew]").waitFor();
      assert.equal(await panel.getByRole("link", { name: "Renew with PDGA" }).getAttribute("href"), "https://www.pdga.com/membership/renew");
    }
    await panel.getByLabel("Division").selectOption("MPO");
    await panel.getByLabel(/Email/).fill("lapsed@gvdg.test");
    await panel.getByRole("button", { name: "Register" }).click();
    await page.getByText("You're signed up. Pay your entry").waitFor();
    await panel.getByLabel("Zelle (no fee)").check();
    const total = 5000 + (lapsed.membershipStatus === "current" ? 0 : 1000);
    await page.waitForFunction((t) => document.querySelector(".tournament-quote")?.textContent.includes(t), money(total));
    await shot(page, "6-public-lapsed");
    assert.deepEqual(page.errors, []);
    await context.close();
    step(`${lapsed.name} (#${LAPSED}, ${lapsed.membershipStatus}): Renew with PDGA shown, entry ${money(total)} with the non-member fee`);
  }

  // 7. After the round: Results for PDGA, with the real PDGA numbers.
  {
    const regs = sqlite.prepare("SELECT member_id, name FROM registrations WHERE event_id = ? ORDER BY id").all(eventId);
    sqlite.prepare("INSERT INTO results (event_id, member_id, name, place, total) VALUES (?, ?, ?, 1, 54)").run(eventId, regs[0].member_id, regs[0].name);
    sqlite.prepare("INSERT INTO results (event_id, member_id, name, place, total) VALUES (?, ?, ?, 2, 61)").run(eventId, regs[1].member_id, regs[1].name);
    sqlite.prepare("UPDATE events SET status = 'final' WHERE id = ?").run(eventId);
    // After the round the TD opens the event from Events › Past, which goes to its Results screen; Results for PDGA
    // is there (owner: "add the results for pdga to the events results screen").
    // (This harness has no live-scoring room, a Durable Object, so the Worker logs the Results screen's live read
    // failing; the screen itself carries on.)
    const { page, context } = await open(`/admin.html#events`, { admin: true, width: 1100 });
    await page.getByRole("button", { name: "Past", exact: true }).or(page.getByRole("tab", { name: "Past", exact: true })).first().click();
    await page.locator("#adminEventsListReactApp .admin-event-card-main").filter({ hasText: pdgaEvent.name.slice(0, 40) }).first().click();
    const section = page.locator("[data-admin-results-pdga]");
    await section.waitFor({ timeout: 30_000 });
    await section.getByRole("button", { name: "Get results for PDGA" }).click();
    await page.locator("[data-admin-pdga-results=ready]").waitFor();
    const rows = await page.getByLabel("Results for PDGA").inputValue();
    const [first, ...rest] = player.name.split(/\s+/);
    assert.ok(rows.startsWith("DivCode\tT.O.\tPlace\tFirst Name\tLast Name\tPDGA\tRd1\n"), rows);
    assert.ok(rows.includes(`MPO\t\t1\t${first}\t${rest.join(" ")}\t${PLAYER}\t54`), rows);
    assert.ok(rows.includes(`\t${LAPSED}\t61`), rows);
    // PDGA's own first/last names (e.g. "Steady Ed" + "Headrick"), from the stored PDGA records.
    const lapsedRaw = JSON.parse(sqlite.prepare("SELECT data FROM pdga_api_players WHERE pdga_number = ?").get(LAPSED).data);
    assert.ok(rows.includes(`\t${lapsedRaw.first_name}\t${lapsedRaw.last_name}\t${LAPSED}\t61`), "PDGA's first and last name: " + rows);
    await shot(page, "7-admin-results-for-pdga");
    assert.deepEqual(page.errors, []);
    await context.close();
    step("Results for PDGA, on the event's Results screen: the rows for PDGA Tournament Manager, with the real PDGA numbers");
  }

  // 8. The finished event's public results page asks for $1, once per event (owner: "on the results page of every
  //    completed club event giving the user an easy way to donate $1 or dismiss").
  {
    const { page, context } = await open(`/events.html#event/${eventId}`);
    const prompt = page.locator(`[data-donate-prompt="event:${eventId}"]`);
    await prompt.waitFor({ timeout: 30_000 });
    assert.equal(await prompt.getByRole("link", { name: "Donate $1 with PayPal" }).getAttribute("href"), "https://paypal.me/greenvillediscgolf/1");
    await prompt.scrollIntoViewIfNeeded();
    await prompt.screenshot({ path: path.join(shots, "8-public-results-donate.png") });
    await prompt.getByRole("button", { name: "No thanks" }).click();
    await prompt.waitFor({ state: "detached" });
    await page.reload();
    await page.locator(".detail-card").first().waitFor();
    await page.waitForTimeout(800);
    assert.equal(await prompt.count(), 0, "No thanks is remembered for this event");
    assert.deepEqual(page.errors, []);
    await context.close();
    step("The finished event's results page offers $1 for the club; No thanks hides it for this event");
  }

  const calls = pdgaCalls.reduce((map, call) => map.set(call, (map.get(call) || 0) + 1), new Map());
  console.log(`PDGA API calls (${realPdga ? "real" : "stand-in"}): ` + [...calls].map(([call, count]) => `${call} ×${count}`).join(", "));
  console.log("PDGA event end-to-end QA passed; screenshots in " + shots);
} finally {
  await browser.close();
  await vite.close();
  server.close();
}
process.exit(0);
