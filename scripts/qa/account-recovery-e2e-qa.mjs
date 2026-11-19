// End to end: the BUILT members app in a browser against the REAL Worker (auth-worker/src, loaded through Vite SSR,
// in-process, set up like production: peppered PINs, 30-day sessions, mail captured). Nothing about sign-in, the email
// step, the PIN check or Forgot PIN is mocked, so the app and the Worker must agree end to end.
//   - an admin signed in before the release (a 12-hour session, no email): the session is upgraded, Home shows
//     "Add your email", and adding it needs no PIN
//   - changing it later asks for the PIN: the wrong PIN is refused (still signed in), the right one sends the code
//   - a member with no email signs in with a PIN and must add one before Home
//   - Forgot PIN: the code from the email, a new PIN, signed in; the new PIN signs in and the old one doesn't
//   npm run build && npm ci --prefix auth-worker && GVDG_QA_NO_SANDBOX=1 node scripts/qa/account-recovery-e2e-qa.mjs
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(repoRoot);

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

async function memoryD1() {
  const db = new DatabaseSync(":memory:");
  const dir = "auth-worker/migrations";
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(path.join(dir, file), "utf8"));
  return {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...bound), success: true }; },
        async first() { return db.prepare(sql).get(...bound) ?? null; },
        async run() { const info = db.prepare(sql).run(...bound); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      };
      return stmt;
    },
    async batch(list) { return Promise.all(list.map((stmt) => stmt.run())); },
  };
}

// Mail (Resend) is captured; every other outside call fails fast.
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body || "{}"));
    mail.push({ to: body.to?.[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "m" + mail.length }), { status: 200 });
  }
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  return new Response("offline in QA", { status: 503 });
};
const codeFor = (to) => {
  const message = [...mail].reverse().find((row) => row.to === to);
  assert.ok(message, "an email to " + to);
  return /\b(\d{6})\b/.exec(message.text)[1];
};

const vite = await createViteServer({
  configFile: false, appType: "custom", logLevel: "warn",
  cacheDir: await mkdtemp(path.join(tmpdir(), "gvdg-recovery-e2e-vite-")),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const worker = (await vite.ssrLoadModule("/auth-worker/src/index.ts")).default;
const { hashPin } = await vite.ssrLoadModule("/auth-worker/src/crypto.ts");
const { signSession } = await vite.ssrLoadModule("/auth-worker/src/jwt.ts");
const { putMember } = await vite.ssrLoadModule("/auth-worker/src/roster.ts");

const PEPPER = "qa-pepper-" + "p".repeat(32);
const SECRET = "qa-secret-" + "s".repeat(40);
const roster = memoryKv();
const env = {
  ROSTER: roster, RATELIMIT: memoryKv(), DB: await memoryD1(), JWT_SECRET: SECRET, PIN_PEPPER: PEPPER, SESSION_TTL_SEC: "2592000",
  ALLOWED_ORIGINS: "", RESEND_API_KEY: "re_qa", RP_ID: "127.0.0.1", EXPECTED_ORIGIN: "",
};
// Like the owner: an admin with a PIN changed a couple of times, no email on file.
await putMember(roster, { memberId: "m_7001", name: "Avery Admin", pdgaNo: "7001", isAdmin: true, pinHash: await hashPin("4821", PEPPER), mustChangePin: false, pinVer: 2 });
// A member who has never given an email.
await putMember(roster, { memberId: "m_7002", name: "Jordan Parker", pdgaNo: "7002", pinHash: await hashPin("1357", PEPPER), mustChangePin: false, pinVer: 1 });

const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"], [".webmanifest", "application/manifest+json"], [".avif", "image/avif"], [".webp", "image/webp"], [".jpg", "image/jpeg"]]);
const server = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      headers.set("Origin", origin);
      headers.set("CF-Connecting-IP", "198.51.100." + (1 + (mail.length % 200)));
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
const origin = `http://127.0.0.1:${server.address().port}`;
env.ALLOWED_ORIGINS = origin;
env.EXPECTED_ORIGIN = origin;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});
const pageErrors = [];

async function open({ token = "" } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", isMobile: true, hasTouch: true });
  await context.addInitScript((token) => {
    if (token && !sessionStorage.getItem("qa-seeded")) {
      localStorage.setItem("gvdg_member_token", token);
      sessionStorage.setItem("qa-seeded", "1");
    }
  }, token);
  await context.route(/^https?:/, (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { context, page };
}
const shellIs = (page, view) => page.waitForFunction((v) => document.body.dataset.memberShell === v, view);
const storedToken = (page) => page.evaluate(() => localStorage.getItem("gvdg_member_token"));
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

// 1. The admin, signed in this morning before the release (a 12-hour session).
{
  const morning = Math.floor(Date.now() / 1000) - 3 * 3600;
  const legacy = await signSession({ sub: "m_7001", mustChangePin: false, pinVer: 2, at: morning }, SECRET, 43200);
  const { page, context } = await open({ token: legacy });
  await page.goto(`${origin}/gvdg-members.html`);
  await shellIs(page, "members");
  await page.waitForFunction((old) => localStorage.getItem("gvdg_member_token") !== old, legacy);
  const renewed = claimsOf(await storedToken(page));
  assert.ok(renewed.exp - renewed.iat >= 29 * 86400, "the 12-hour session is upgraded to 30 days");
  assert.equal(renewed.at, morning, "the upgrade keeps the real sign-in time");

  // Adding the first email: no PIN.
  await page.locator("[data-react-email-reminder]").click();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await page.locator("#memberEmailInput").fill("Avery@Example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('#emailForm[data-email-step="code"]').waitFor();
  assert.equal(await page.locator("#memberEmailPinInput").count(), 0);
  await page.locator("#memberEmailCodeInput").fill(codeFor("avery@example.com"));
  await page.locator('[data-react-auth-action="email-verify"]').click();
  await shellIs(page, "members");
  assert.equal(JSON.parse(roster.rows.get("member:m_7001")).email, "avery@example.com");
  await page.reload();
  await shellIs(page, "members");
  assert.equal(await page.locator("[data-react-email-reminder]").count(), 0, "no reminder once it's saved");

  // Changing it (signed in hours ago): the PIN. Wrong first, then right.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:member-email-change-requested")));
  await page.locator("#memberEmailInput").fill("avery.new@example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator("#memberEmailPinInput").waitFor();
  await page.locator("#memberEmailPinInput").fill("0000");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('[data-react-auth-error="email"]').filter({ hasText: "didn't match" }).waitFor();
  assert.ok(await storedToken(page), "a wrong PIN keeps them signed in");
  await page.locator("#memberEmailPinInput").fill("4821");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('#emailForm[data-email-step="code"]').waitFor();
  await page.locator("#memberEmailCodeInput").fill(codeFor("avery.new@example.com"));
  await page.locator('[data-react-auth-action="email-verify"]').click();
  await shellIs(page, "members");
  assert.equal(JSON.parse(roster.rows.get("member:m_7001")).email, "avery.new@example.com");
  assert.ok(mail.some((row) => row.to === "avery@example.com" && /changed/.test(row.subject)), "the old address is told");
  await context.close();
  console.log("Admin: session upgraded, first email with no PIN, change with the PIN (wrong refused, right accepted)");
}

// 2. A member with no email signs in with a PIN and adds one before Home.
{
  const { page, context } = await open();
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator("#identifierInput").fill("7002");
  await page.locator("#pinInput").fill("1357");
  await page.locator('[data-react-auth-action="login"]').click();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await page.locator("#memberEmailInput").fill("jordan@example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('#emailForm[data-email-step="code"]').waitFor();
  await page.locator("#memberEmailCodeInput").fill(codeFor("jordan@example.com"));
  await page.locator('[data-react-auth-action="email-verify"]').click();
  await shellIs(page, "members");
  await context.close();
  console.log("Member: PIN sign-in, the email step, then Home");
}

// 3. Forgot PIN, then the new PIN signs in and the old one doesn't.
{
  const { page, context } = await open();
  await page.goto(`${origin}/gvdg-members.html#forgot-pin`);
  await page.locator('[data-react-auth-gate="reset"]').waitFor();
  await page.locator("#resetIdentifierInput").fill("7002");
  await page.locator('[data-react-auth-action="reset-start"]').click();
  await page.locator('#resetPinForm[data-reset-step="code"]').waitFor();
  await page.locator("#resetCodeInput").fill(codeFor("jordan@example.com"));
  await page.locator("#resetNewPinInput").fill("2468");
  await page.locator("#resetConfirmPinInput").fill("2468");
  await page.locator('[data-react-auth-action="reset-verify"]').click();
  await shellIs(page, "members");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:member-logout-requested")));
  await page.locator("#identifierInput").fill("jordan@example.com");
  await page.locator("#pinInput").fill("1357");
  await page.locator('[data-react-auth-action="login"]').click();
  await page.locator('[data-react-auth-error="login"][data-react-auth-error-state="shown"]').waitFor();
  await page.locator("#pinInput").fill("2468");
  await page.locator('[data-react-auth-action="login"]').click();
  await shellIs(page, "members");
  await context.close();
  console.log("Forgot PIN: emailed code, new PIN signs in (by email), old PIN refused");
}

await browser.close();
server.close();
await vite.close();
assert.deepEqual(pageErrors, [], "page errors: " + pageErrors.join(" | "));
console.log("PASS account-recovery-e2e-qa");
