// Admin › Members › Google Sheets, end to end (the owner: "Do a full QA run through of the Google sheets
// imports. Need to make sure that goes very smoothly"). The BUILT admin app in a browser against the REAL Worker
// (auth-worker/src, in-process through Vite SSR, D1 on SQLite, KV in memory, peppered like production). Every import
// kind with the messy cells real club sheets have, checked in the app's data after each apply:
//   people  - first/last columns, "#80024", "@rileyc", case and spacing, tiers (never an admin's), a typo picked from
//             the suggestions, two people with one name (skipped), new people held, a blank row, re-checking = nothing
//   balances - read from a sheet link: "$12.50", "(5.00)", "20", "$1,234.56", a blank, "abc" (not sent), "$12,000"
//             (skipped with a note), a new person; applying twice changes nothing; a corrected sheet moves by the change
//   dues     - "2026", "Paid", "✓", "No", blank, "Paid 2025", "2031" (skipped with a note)
//   tags     - "#1", "Tag 2", "3", by PDGA # among two of a name, a new person; whoever isn't on the sheet lets go
//   links    - a sheet that isn't shared (Google's sign-in page) and a failed read both explain what to do
//   scale    - 300 people in one paste: checked, applied in batches, all there; KV writes and D1 queries per request
//   npm run build && npm ci --prefix auth-worker && GVDG_QA_NO_SANDBOX=1 node scripts/qa/sheet-import-e2e-qa.mjs
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";

import { appHref } from "../../src/shared/app-navigation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(repoRoot);
const shots = process.env.GVDG_SHEET_SHOTS || "";
if (shots) await mkdir(shots, { recursive: true });

// --- an in-process Worker, counting what each request costs -----------------------------------------------------
const cost = { kvWrites: 0, kvReads: 0, d1: 0 };
function memoryKv() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => { cost.kvReads += 1; return rows.get(key) ?? null; },
    put: async (key, value) => { cost.kvWrites += 1; rows.set(key, value); },
    delete: async (key) => { cost.kvWrites += 1; rows.delete(key); },
    list: async (opts) => ({ keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })), list_complete: true }),
  };
}
const sqlite = new DatabaseSync(":memory:");
for (const file of (await readdir("auth-worker/migrations")).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(await readFile(path.join("auth-worker/migrations", file), "utf8"));
function statement(sql) {
  let bound = [];
  const stmt = {
    sql, get bound() { return bound; },
    bind(...args) { bound = args; return stmt; },
    async all() { cost.d1 += 1; return { results: sqlite.prepare(sql).all(...bound), success: true }; },
    async first() { cost.d1 += 1; return sqlite.prepare(sql).get(...bound) ?? null; },
    async run() { cost.d1 += 1; const info = sqlite.prepare(sql).run(...bound); return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; },
  };
  return stmt;
}
const DB = {
  prepare: statement,
  async batch(list) {
    cost.d1 += list.length;
    sqlite.exec("BEGIN");
    try {
      const out = list.map((stmt) => { const info = sqlite.prepare(stmt.sql).run(...stmt.bound); return { success: true, meta: { changes: Number(info.changes) } }; });
      sqlite.exec("COMMIT");
      return out;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  return new Response("offline in QA", { status: 503 });
};

const vite = await createViteServer({
  configFile: false, appType: "custom", logLevel: "warn",
  cacheDir: await mkdtemp(path.join(tmpdir(), "gvdg-sheet-e2e-vite-")),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const worker = (await vite.ssrLoadModule("/auth-worker/src/index.ts")).default;
const { signSession } = await vite.ssrLoadModule("/auth-worker/src/jwt.ts");
const { putMember } = await vite.ssrLoadModule("/auth-worker/src/roster.ts");

const SECRET = "qa-secret-" + "s".repeat(40);
const roster = memoryKv();
const env = { ROSTER: roster, RATELIMIT: memoryKv(), DB, JWT_SECRET: SECRET, PIN_PEPPER: "p".repeat(40), SESSION_TTL_SEC: "2592000", ALLOWED_ORIGINS: "" };
const YEAR = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));
const person = (memberId, name, extra = {}) => putMember(roster, { memberId, name, pinHash: "h", mustChangePin: false, memberThroughYear: YEAR, ...extra });
await person("m_1", "Avery Admin", { pdgaNo: "1", isAdmin: true });
await person("m_80024", "Jordan Parker", { pdgaNo: "80024" });
await person("m_u_rileyc", "Riley Chen", { udisc: "rileyc", memberThroughYear: YEAR - 1 });
await person("m_555", "Taylor Morgan", { pdgaNo: "555", guest: true });
await person("m_70001", "Sam Lee", { pdgaNo: "70001" });
await person("m_70002", "Sam Lee", { pdgaNo: "70002" });
await person("m_4242", "Casey Jones", { pdgaNo: "4242", memberThroughYear: YEAR - 1 });
sqlite.prepare("INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, note, created_by) VALUES ('m_80024', 'Jordan Parker', 500, 'credit', 'admin', 'seed', 'm_1')").run();
const series = Number(sqlite.prepare("INSERT INTO bag_tag_series (name, season, active, created_by) VALUES ('Club tags 2026', '2026', 1, 'm_1')").run().lastInsertRowid);
sqlite.prepare("INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES (?, 1, 'm_80024', 'Jordan Parker'), (?, 2, 'm_555', 'Taylor Morgan')").run(series, series);

const record = (id) => JSON.parse(roster.rows.get("member:" + id) || "null");
const heldNamed = (name) => [...roster.rows.entries()].filter(([key]) => key.startsWith("member:")).map(([, value]) => JSON.parse(value)).filter((m) => m.held && m.name === name);
const balance = (id) => Number(sqlite.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM wallet_transactions WHERE member_id = ?").get(id).c);

// --- the site, with the API at /api ----------------------------------------------------------------------------
const perRequest = [];
const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"], [".webmanifest", "application/manifest+json"], [".avif", "image/avif"], [".webp", "image/webp"], [".jpg", "image/jpeg"]]);
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
      const before = { ...cost };
      const pending = [];
      const result = await worker.fetch(new Request("https://worker.qa" + url.pathname.slice(4) + url.search, {
        method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      }), env, { waitUntil: (promise) => pending.push(promise) });
      while (pending.length) await Promise.allSettled(pending.splice(0));
      if (url.pathname.startsWith("/api/admin/sheet-import/")) {
        perRequest.push({ path: url.pathname.slice(4), kvWrites: cost.kvWrites - before.kvWrites, kvReads: cost.kvReads - before.kvReads, d1: cost.d1 - before.d1 });
      }
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
    if (file.endsWith(".html")) body = Buffer.from(String(body).replace(/\sdata-(?:auth|api)-base="[^"]*"/g, "").replace("<body", `<body data-auth-base="${origin}/api" data-api-base="${origin}/api"`));
    response.writeHead(200, { "Content-Type": (mime.get(path.extname(file)) || "application/octet-stream") + "; charset=utf-8" });
    response.end(body);
  } catch { response.writeHead(404); response.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
env.ALLOWED_ORIGINS = origin;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});
const pageErrors = [];
const token = await signSession({ sub: "m_1", mustChangePin: false, pinVer: 0 }, SECRET, 3600);
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", isMobile: true, hasTouch: true });
await context.addInitScript((t) => localStorage.setItem("gvdg_member_token", t), token);
// Google Sheets, played by the test: a shared sheet's CSV, one that isn't shared (the sign-in page), and a failure.
const sheets = new Map();
await context.route(/^https:\/\/docs\.google\.com\//, (route) => {
  const url = route.request().url();
  const sheet = [...sheets.entries()].find(([id]) => url.includes("/d/" + id + "/"));
  if (!sheet) return route.abort("connectionfailed");
  const [, value] = sheet;
  if (value === "private") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!DOCTYPE html><title>Sign in - Google Accounts</title>" });
  return route.fulfill({ status: 200, contentType: "text/csv; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: value });
});
await context.route(/^https?:\/\/(?!127\.0\.0\.1|docs\.google\.com)/, (route) => route.abort());
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.goto(`${origin}/admin.html`);
await page.evaluate((hash) => { location.hash = hash; }, appHref("admin", "sheets"));
const panel = page.locator("[data-admin-sheet-import]");
await panel.waitFor();
const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + ".png"), fullPage: true }); };

async function chooseKind(label) {
  await panel.getByRole("radio", { name: label }).click();
}
const rowsOn = (text) => text.split("\n").length - 1;
const waitForSheet = (rows) => panel.locator("[data-sheet-columns] h3", { hasText: `Columns · ${rows} rows` }).waitFor();
async function paste(text) {
  await panel.locator("#sheetCells").fill(text);
  await panel.getByRole("button", { name: "Use these cells" }).click();
  await waitForSheet(rowsOn(text));
}
async function readLink(link, rows) {
  await panel.locator("#sheetLink").fill(link);
  await panel.getByRole("button", { name: "Read the sheet" }).click();
  await waitForSheet(rows);
}
async function check() {
  await panel.getByRole("button", { name: "Check against the app" }).click();
  await panel.locator("[data-sheet-plan]").waitFor();
  return (await panel.locator("[data-sheet-plan] .al-note").first().textContent()).trim();
}
const rowAction = (line) => panel.locator(`[data-sheet-row="${line}"]`).getAttribute("data-sheet-action");
const rowText = async (line) => (await panel.locator(`[data-sheet-row="${line}"]`).textContent()).replace(/\s+/g, " ");
async function apply(expected) {
  const button = panel.getByRole("button", { name: new RegExp(`^Apply ${expected} change`) });
  await button.click();
  await page.getByRole("dialog").getByRole("button", { name: "Apply", exact: true }).click();
  await panel.locator("[data-sheet-done]").waitFor();
  assert.match(await panel.locator("[data-sheet-done]").textContent(), new RegExp(`Done: ${expected} change`));
}
async function nothingToChange() {
  const counts = await check();
  const pending = await panel.locator('[data-sheet-row][data-sheet-action="update"], [data-sheet-row][data-sheet-action="new"]').allTextContents();
  assert.deepEqual(pending.map((text) => text.replace(/\s+/g, " ")), [], "re-checking the same sheet: " + counts);
  await panel.getByRole("button", { name: "Nothing to change" }).waitFor();
}
const mappingOf = (field) => panel.locator("#sheet-col-" + field).inputValue();

// --- people ------------------------------------------------------------------------------------------------------
await chooseKind("People and account tiers");
await paste([
  "First Name\tLast Name\tPDGA #\tUDisc\tStatus",
  "JORDAN\t parker\t#80024\t\tMember",
  "riley\tchen\t\t@rileyc\tGuest",
  "Taylor\tMorgan\t555\t\tMember",
  "Avery\tAdmin\t1\t\tGuest",
  "Jordon\tParkar\t\t\t",
  "Sam\tLee\t\t\t",
  "Morgan\tFreeman\t99887\tmfree\tGuest",
  "\t\t\t\t",
  "Pat\tSmith\t\t\t",
].join("\n"));
assert.deepEqual([await mappingOf("first"), await mappingOf("last"), await mappingOf("pdga"), await mappingOf("udisc"), await mappingOf("tier")], ["0", "1", "2", "3", "4"], "columns guessed from the headers");
let counts = await check();
assert.equal(counts, "2 to change · 3 new held accounts · 2 already match · 1 skipped");
assert.equal(await rowAction(3), "update"); // Riley: Member -> Guest
assert.equal(await rowAction(4), "update"); // Taylor: Guest -> Member
assert.match(await rowText(7), /2 people in the app are named Sam Lee/);
assert.equal(await rowAction(7), "skip");
assert.match(await rowText(8), /New guest account/);
// The typo: pick Jordan Parker from the suggestions instead of holding a new account.
await panel.locator("#sheet-pick-6").selectOption("m_80024");
await shot("people-review");
await apply(5);
assert.equal(record("m_u_rileyc").guest, true, "Riley is a guest");
assert.equal(record("m_555").guest, undefined, "Taylor is a member");
assert.equal(record("m_1").isAdmin, true, "an admin's tier is never changed by an import");
assert.deepEqual(heldNamed("Morgan Freeman").map((m) => [m.pdgaNo, m.udisc, m.guest]), [["99887", "mfree", true]]);
assert.equal(heldNamed("Pat Smith").length, 1);
assert.equal(heldNamed("Jordon Parkar").length, 0, "the typo went to Jordan Parker, not a new account");
await nothingToChange();
console.log("People: columns guessed, tiers set (never an admin's), a typo matched, two-of-a-name skipped, new people held; re-check: nothing");

// --- balances from a sheet link ----------------------------------------------------------------------------------
await chooseKind("Store credit balances");
sheets.set("CLUBBALANCES", [
  "Player,PDGA,Store Credit",
  "Jordan Parker,80024,$12.50",
  "Riley Chen,,(5.00)",
  "Taylor Morgan,555,20",
  "Morgan Freeman,99887,\"$1,234.56\"",
  "Pat Smith,,",
  "Brand New,,abc",
  "Big Spender,,\"$12,000.00\"",
  "Quinn Newcomer,,$7",
].join("\n"));
await readLink("https://docs.google.com/spreadsheets/d/CLUBBALANCES/edit#gid=123", rowsOn(sheets.get("CLUBBALANCES")));
assert.deepEqual([await mappingOf("name"), await mappingOf("pdga"), await mappingOf("balance")], ["0", "1", "2"]);
assert.match(await panel.locator("[data-sheet-columns] [role=alert]").first().textContent(), /row 7 "abc" isn't an amount/);
counts = await check();
assert.equal(counts, "4 to change · 1 new held account · 0 already match · 2 skipped");
assert.match(await rowText(2), /\$5\.00 → \$12\.50/);
assert.match(await rowText(8), /\$12,000\.00 is more than \$10,000/);
assert.equal(await rowAction(8), "skip");
await shot("balances-review");
await apply(5);
assert.deepEqual([balance("m_80024"), balance("m_u_rileyc"), balance("m_555"), balance(heldNamed("Morgan Freeman")[0].memberId), balance(heldNamed("Quinn Newcomer")[0].memberId)], [1250, -500, 2000, 123456, 700]);
await nothingToChange();
// A corrected sheet: Jordan now has $15.00. Only that changes, by the difference.
sheets.set("CLUBBALANCES", sheets.get("CLUBBALANCES").replace("Jordan Parker,80024,$12.50", "Jordan Parker,80024,$15.00"));
await readLink("https://docs.google.com/spreadsheets/d/CLUBBALANCES/edit#gid=123", rowsOn(sheets.get("CLUBBALANCES")));
// The same cells again: wait for the review of the corrected sheet, not the old one.
counts = await check();
assert.equal(counts, "1 to change · 0 new held accounts · 4 already match · 2 skipped");
await apply(1);
assert.equal(balance("m_80024"), 1500);
assert.equal(Number(sqlite.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE member_id = 'm_80024' AND source = 'sheet_import'").get().n), 2, "one entry per change");
console.log("Balances: read from a link, $/()/commas/blank handled, \"abc\" not sent, over $10,000 skipped with a note; twice = nothing; a correction moves by the difference");

// --- dues --------------------------------------------------------------------------------------------------------
await chooseKind("Membership dues");
await paste([
  "Name,Paid",
  `Jordan Parker,${YEAR}`,
  "Casey Jones,Paid",
  "Riley Chen,✓",
  "Taylor Morgan,No",
  "Pat Smith,",
  `Morgan Freeman,Paid ${YEAR - 1}`,
  `Future Person,${YEAR + 5}`,
].join("\n"));
assert.equal(await panel.locator("#sheetDuesYear").inputValue(), String(YEAR));
counts = await check();
assert.equal(counts, "3 to change · 0 new held accounts · 3 already match · 1 skipped");
assert.match(await rowText(8), new RegExp(`${YEAR + 5} isn't a dues year the app can use`));
await apply(3);
assert.deepEqual([record("m_4242").memberThroughYear, record("m_u_rileyc").memberThroughYear, heldNamed("Morgan Freeman")[0].memberThroughYear], [YEAR, YEAR, YEAR - 1]);
assert.equal(heldNamed("Future Person").length, 0, "a skipped row creates nobody");
await nothingToChange();
console.log("Dues: a year, Paid, ✓, No, blank and \"Paid <year>\" read right; a year too far ahead skipped with a note; re-check: nothing");

// --- bag tags ----------------------------------------------------------------------------------------------------
await chooseKind("Bag tag standings");
await panel.getByText("Sets the standings of Club tags 2026.").waitFor();
await paste(["Tag,Player,PDGA", "#1,Riley Chen,", "Tag 2,Jordan Parker,80024", "3,Quinn Newcomer,", "4,Sam Lee,70001"].join("\n"));
counts = await check();
assert.match(await panel.locator("[data-sheet-plan]").textContent(), /give up their tag: #2 Taylor Morgan/);
await apply(Number(counts.match(/^(\d+) to change/)[1]) + Number(counts.match(/(\d+) new held/)[1]));
const holders = sqlite.prepare("SELECT tag_number AS tag, member_id AS id FROM bag_tag_holders WHERE series_id = ? ORDER BY tag_number").all(series).map((row) => [row.tag, row.id]);
assert.deepEqual(holders, [[1, "m_u_rileyc"], [2, "m_80024"], [3, heldNamed("Quinn Newcomer")[0].memberId], [4, "m_70001"]]);
await nothingToChange();
console.log("Bag tags: #1 / Tag 2 / 3 read, Sam Lee found by PDGA #, Taylor (not on the sheet) let go; re-check: nothing");

// --- links that can't be read -------------------------------------------------------------------------------------
sheets.set("PRIVATESHEET", "private");
await panel.locator("#sheetLink").fill("https://docs.google.com/spreadsheets/d/PRIVATESHEET/edit");
await panel.getByRole("button", { name: "Read the sheet" }).click();
await panel.getByText(/Share it as "Anyone with the link can view"/).waitFor();
await panel.locator("#sheetLink").fill("https://docs.google.com/spreadsheets/d/GONESHEET/edit");
await panel.getByRole("button", { name: "Read the sheet" }).click();
await panel.getByText(/Share it as "Anyone with the link can view"/).waitFor();
await panel.locator("#sheetLink").fill("https://example.com/not-a-sheet");
await panel.getByRole("button", { name: "Read the sheet" }).click();
await panel.getByText("That isn't a Google Sheets link.").waitFor();
console.log("Links: not shared, unreachable and not-a-sheet each say what to do");

// --- scale -------------------------------------------------------------------------------------------------------
await chooseKind("People and account tiers");
perRequest.length = 0;
const big = ["Name\tPDGA"];
for (let i = 0; i < 300; i++) big.push(`Player ${String(i).padStart(3, "0")} Lastname${i % 17}\t${900000 + i}`);
await paste(big.join("\n"));
const started = Date.now();
counts = await check();
assert.equal(counts, "0 to change · 300 new held accounts · 0 already match");
await apply(300);
const seconds = (Date.now() - started) / 1000;
const created = [...roster.rows.keys()].filter((key) => key.startsWith("member:m_h_p900")).length;
assert.equal(created, 300);
const applies = perRequest.filter((row) => row.path.endsWith("/apply"));
assert.equal(applies.length, 12, "300 rows in batches of 25");
const worst = { kvWrites: Math.max(...applies.map((row) => row.kvWrites)), kvReads: Math.max(...applies.map((row) => row.kvReads)), d1: Math.max(...perRequest.map((row) => row.d1)) };
assert.ok(worst.d1 <= 50, "inside D1's 50 queries per request on the free plan: " + worst.d1);
assert.ok(worst.kvReads + worst.kvWrites <= 1000, "inside KV's 1000 operations per request");
console.log(`Scale: 300 new people checked and applied in ${seconds.toFixed(1)}s (12 batches); per request at most ${worst.kvWrites} KV writes, ${worst.kvReads} KV reads, ${worst.d1} D1 queries; KV writes for the whole import ${applies.reduce((sum, row) => sum + row.kvWrites, 0)}`);

await browser.close();
server.close();
await vite.close();
assert.deepEqual(pageErrors, [], "page errors: " + pageErrors.join(" | "));
console.log("PASS sheet-import-e2e-qa");
