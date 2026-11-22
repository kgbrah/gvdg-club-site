// Browser QA for the used-disc marketplace in the Pro Shop.
//
// The marketplace API here is the REAL Worker (auth-worker/src/index.ts, loaded through Vite SSR) running
// in-process over an in-memory SQLite database with every migration applied, in-memory KV and R2, and a
// captured Resend (the guest's 6-digit code is read from the captured email). Everything else the pages
// call (/shop/products, /events, admin lists) is a small fixture.
//
// Flows (390 light): a guest browses, verifies by email code and buys; a member adds the required buyer-alert
// email inline and lists a disc with a photo,
// sees the pending buyer, marks it sold and both sides leave feedback; a trade offer is accepted; a guest's
// WANTED post gets an "I have one" reply relayed by email; a report appears in the admin Marketplace queue;
// pay links are exact; a withdrawn listing is relisted within its 24-hour window and a later one is made
// final by the cron sweep (photos deleted); "Sell this" from My Bag lists a disc, the bag and an accessory with their bag
// photos, and browse filters by what's for sale. Then every key screen is checked at 390 light / 390 dark / 320 large-text dark /
// 1280 light for horizontal overflow and clipped action labels, and screenshotted.
//
// Usage: CHROMIUM_PATH=/usr/bin/chromium GVDG_QA_NO_SANDBOX=1 node scripts/qa/marketplace-browser-qa.mjs
// Env: GVDG_MARKET_SHOTS=<dir> (default: a temp dir), GVDG_MARKET_PORT, GVDG_MARKET_SKIP_SCREENS=1 (flows + glass only).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GLASS_PRESETS, buildTheme } from "../../src/shared/dashboard-theme-model.js";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const shotsDir = process.env.GVDG_MARKET_SHOTS || await mkdtemp(join(tmpdir(), "gvdg-market-shots-"));
await mkdir(shotsDir, { recursive: true });

// ---------------------------------------------------------------------------------------------------
// In-process Worker environment
// ---------------------------------------------------------------------------------------------------

function memoryKv(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key) => rows.get(key) ?? null,
    put: async (key, value) => { rows.set(key, value); },
    delete: async (key) => { rows.delete(key); },
    list: async (opts) => ({ keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })), list_complete: true }),
  };
}

function memoryR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts) { objects.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType }); },
    async get(key) {
      const hit = objects.get(key);
      return hit ? { body: new Blob([hit.bytes]).stream(), arrayBuffer: async () => hit.bytes.buffer, httpMetadata: { contentType: hit.type } } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

async function memoryD1() {
  const db = new DatabaseSync(":memory:");
  const dir = "auth-worker/migrations";
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(join(dir, file), "utf8"));
  return {
    raw: db,
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...bound), success: true }; },
        async first() { return db.prepare(sql).get(...bound) ?? null; },
        async run() {
          if (/\bRETURNING\b/i.test(sql) || /^\s*(?:SELECT|WITH)\b/i.test(sql)) {
            const rows = db.prepare(sql).all(...bound);
            return { results: rows, success: true, meta: { changes: rows.length } };
          }
          const info = db.prepare(sql).run(...bound);
          return { results: [], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return stmt;
    },
    async batch(list) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const people = {
  seller: { memberId: "m_qa_seller", name: "Taylor Morgan" },
  buyer: { memberId: "m_qa_buyer", name: "Jordan Parker" },
  admin: { memberId: "m_qa_admin", name: "Avery Brooks", isAdmin: true },
  fresh: { memberId: "m_qa_fresh", name: "Riley Chen" },
};
const roster = Object.fromEntries(Object.values(people).map((person) => ["member:" + person.memberId,
  JSON.stringify({ ...person, isAdmin: person.isAdmin === true, pinHash: "qa", mustChangePin: false })]));
const secret = "qa-" + "s".repeat(40);
const db = await memoryD1();
const photos = memoryR2();
const mail = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body || "{}"));
    mail.push({ to: body.to?.[0], subject: body.subject, text: body.text });
    return new Response("{}", { status: 200 });
  }
  if (/^https:\/\/[^/]*push|fcm\.googleapis|updates\.push/.test(url)) return new Response("", { status: 201 });
  return realFetch(input, init);
};

// ---------------------------------------------------------------------------------------------------
// Vite server: pages + fixture API (real Worker for marketplace + messages summary)
// ---------------------------------------------------------------------------------------------------

const products = [
  { id: 1, active: 1, brand: "Innova", name: "Star Mako3", color: "Blue", weight_g: 175, price_cents: 1800, product_type: "disc", stock_qty: 4 },
  { id: 3, active: 1, brand: "GVDG", name: "Club mini", color: "Green", price_cents: 800, product_type: "accessory", stock_qty: 5 },
];
const entries = { "/pro-shop.html": "/src/public-app/main.js", "/admin.html": "/src/admin-app/main.js" };
let worker = null;
let jwt = null;
let env = null;
let origin = "";

function fixture(path, method, authorization) {
  if (path === "/me") {
    const sub = authorization ? tokenOwners.get(authorization.slice(7)) : null;
    const person = Object.values(people).find((row) => row.memberId === sub);
    return person ? [200, { sub: person.memberId, name: person.name, isAdmin: person.isAdmin === true, mustChangePin: false }] : [401, { error: "unauthorized" }];
  }
  if (path === "/me/dashboard-theme") return [200, { theme: glassTheme }];
  if (path === "/shop/products") return [200, { products }];
  if (path === "/shop/wallet") return [200, { balance_cents: 2600, orders: [] }];
  if (path === "/payments/config") return [200, { enabled: false }];
  if (path === "/events" || path === "/registration/open") return [200, { events: [] }];
  if (path === "/courses") return [200, { courses: [] }];
  if (path === "/admin/members") return [200, { members: Object.values(people) }];
  if (path === "/admin/members/applications") return [200, { applications: [] }];
  if (path === "/admin/orders") return [200, { unfulfilled: 0, orders: [] }];
  if (path === "/admin/tee-signs") return [200, { teeSigns: [] }];
  if (path === "/admin/bag-tags") return [200, { leagues: [], requests: [], challenges: [], holders: [] }];
  if (path === "/admin/community/reviews") return [200, { queue: [], more: false }];
  return [200, { ok: true }];
}

const tokenOwners = new Map();
let glassTheme = null;
async function memberToken(person) {
  const token = await jwt.signSession({ sub: person.memberId, mustChangePin: false }, secret, 43200);
  tokenOwners.set(token, person.memberId);
  return token;
}

const vite = await createServer({
  configFile: false,
  cacheDir: await mkdtemp(join(tmpdir(), "gvdg-market-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_MARKET_PORT || 0), strictPort: Boolean(process.env.GVDG_MARKET_PORT), hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  logLevel: "warn",
  plugins: [{ name: "marketplace-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/pro-shop-built.html") {
        // The shipped page as is: the BUILT public-app.js, which lazy-loads public-app/chunks/market-app-*.js.
        const html = (await readFile("pro-shop.html", "utf8"))
          .replace(/<link[^>]+https:[^>]+>/g, "")
          .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
          .replace(/\sdata-(?:auth|api)-base=""/g, "")
          .replace("<body", '<body data-auth-base="/api" data-api-base="/api"');
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
        return;
      }
      if (url.pathname.startsWith("/public-app/") && url.pathname.endsWith(".js")) {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(await readFile(url.pathname.slice(1)));
        return;
      }
      const entry = entries[url.pathname];
      if (entry) {
        const html = (await readFile(url.pathname.slice(1), "utf8"))
          .replace(/<link[^>]+https:[^>]+>/g, "")
          .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
          .replace(/src="(?:public-app|admin-app)\/[^"]+"/, 'src="' + entry + '"')
          .replace(/\sdata-(?:auth|api)-base=""/g, "")
          .replace("<body", '<body data-auth-base="/api" data-api-base="/api"');
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await server.transformIndexHtml(url.pathname, html));
        return;
      }
      if (!url.pathname.startsWith("/api/")) return next();
      const path = url.pathname.slice("/api".length);
      if (path.startsWith("/market/") || path.startsWith("/admin/market/") || path.startsWith("/me/messages") || path.startsWith("/me/notices")
        || path === "/me/bag" || path.startsWith("/me/bag/")) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
        headers.set("Origin", origin);
        headers.set("CF-Connecting-IP", "198.51.100.7");
        const pending = [];
        const result = await worker.fetch(new Request("https://worker.qa" + path + url.search, {
          method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
        }), env, { waitUntil: (promise) => pending.push(promise) });
        const body = Buffer.from(await result.arrayBuffer());
        await Promise.allSettled(pending);
        const out = {};
        result.headers.forEach((value, key) => { out[key] = value; });
        response.writeHead(result.status, out);
        response.end(body);
        return;
      }
      const [status, data] = fixture(path, request.method, request.headers.authorization);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    });
  } }],
});
await vite.listen();
origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
worker = (await vite.ssrLoadModule("/auth-worker/src/index.ts")).default;
jwt = await vite.ssrLoadModule("/auth-worker/src/jwt.ts");
env = {
  ROSTER: memoryKv(roster), RATELIMIT: memoryKv(), DB: db, PHOTOS: photos, JWT_SECRET: secret, SESSION_TTL_SEC: "43200",
  ALLOWED_ORIGINS: origin, RESEND_API_KEY: "re_qa", EXPECTED_ORIGIN: "https://gvdgclub.com",
};
const tokens = { seller: await memberToken(people.seller), buyer: await memberToken(people.buyer), admin: await memberToken(people.admin),
  fresh: await memberToken(people.fresh) };
const sweep = await vite.ssrLoadModule("/auth-worker/src/market-sweep.ts");

/** Call the in-process Worker directly (seeding / assertions), as the browser would. */
async function api(path, { method = "GET", token, body } = {}) {
  const headers = { Origin: origin, "CF-Connecting-IP": "198.51.100.8" };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const pending = [];
  const result = await worker.fetch(new Request("https://worker.qa" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.allSettled(pending);
  const data = await result.json().catch(() => null);
  if (!result.ok) throw new Error(`${method} ${path} -> ${result.status} ${JSON.stringify(data)}`);
  return data;
}

// ---------------------------------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------------------------------

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});

const profiles = {
  light390: { name: "390-light", width: 390, height: 844, mode: "light" },
  dark390: { name: "390-dark", width: 390, height: 844, mode: "dark" },
  dark320: { name: "320-large-dark", width: 320, height: 760, mode: "dark", large: true },
  light1280: { name: "1280-light", width: 1280, height: 900, mode: "light" },
};

const pageErrors = [];

async function open(profile, { member, guest, theme } = {}) {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height }, colorScheme: profile.mode, reducedMotion: "reduce",
    serviceWorkers: "block", isMobile: profile.width < 500, hasTouch: profile.width < 500,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript(({ mode, large, member, guest, theme }) => {
    localStorage.setItem("theme", mode);
    if (theme) for (const id of ["m_qa_seller", "me"]) localStorage.setItem("gvdg_dashboard_theme:" + id, JSON.stringify(theme));
    if (member) localStorage.setItem("gvdg_member_token", member);
    if (guest) localStorage.setItem("gvdg_market_guest", JSON.stringify(guest));
    if (large) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "20px"; }, { once: true });
  }, { mode: profile.mode, large: Boolean(profile.large), member: member || "", guest: guest || null, theme: theme || null });
  await context.route(/^https?:/, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "paypal.me" || url.hostname === "cash.app") return route.fulfill({ contentType: "text/html", body: "<p>Mock payment handoff</p>" });
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(profile.name + ": " + error.message));
  return { context, page };
}

async function assertFits(page, label) {
  await page.evaluate(() => document.fonts.ready);
  // Same clipped-label rule as member-subpages / public-polish: a visible button, link or summary whose text
  // overflows without a real ellipsis is clipped (flex/grid buttons never render one).
  const clipped = await page.evaluate(() => [...document.querySelectorAll("button, a, [role=button], summary")].filter((node) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2 || node.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" || node.scrollWidth <= node.clientWidth + 1) return false;
    return !(style.textOverflow === "ellipsis" && !/flex|grid/.test(style.display));
  }).map((node) => (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) + " (" + node.scrollWidth + ">" + node.clientWidth + ")"));
  assert.deepEqual(clipped, [], label + " has clipped labels");
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
  if (overflow > 1) {
    const offenders = await page.evaluate(() => [...document.body.querySelectorAll("*")]
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8).map((node) => node.outerHTML.slice(0, 160)));
    throw new Error(label + " overflows the viewport by " + overflow + "px: " + offenders.join(" | "));
  }
}

async function shot(page, name, { fullPage = true } = {}) {
  // Walk the page so lazy images start loading, then give each one a bounded wait.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(200, innerHeight / 2)) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await Promise.all([...document.images].filter((image) => !image.complete).map((image) => Promise.race([
      new Promise((resolve) => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])));
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.screenshot({ path: join(shotsDir, name + ".png"), fullPage, animations: "disabled" });
}

async function go(page, hash, ready) {
  const target = origin + "/pro-shop.html" + (hash ? "#" + hash : "");
  // Same URL means a same-document no-op in the browser; reload so the view fetches fresh data.
  if (page.url() === target) await page.reload({ waitUntil: "domcontentloaded" });
  else await page.goto(target, { waitUntil: "domcontentloaded" });
  if (ready) await page.locator(ready).first().waitFor();
}

const photoFile = "img/slide4.jpg";
const photoDataUrl = "data:image/jpeg;base64," + (await readFile(photoFile)).toString("base64");
const state = {};

function listingBody(overrides = {}) {
  return { brand: "Innova", mold: "Destroyer", plastic: "Star", discType: "driver", weightG: 175, color: "Orange", condition: 8,
    priceCents: 1800, openToTrade: false, quantity: 1, location: "Greenville", photos: [photoDataUrl], ...overrides };
}

async function guestCode(email) {
  const message = [...mail].reverse().find((row) => row.to === email && /marketplace code/.test(row.subject));
  assert(message, "a code email was sent to " + email);
  return /code is (\d{6})/.exec(message.text)[1];
}

async function runFlows() {
  const P = profiles.light390;

  // 1. A member sets payment handles and lists a disc with a photo.
  const seller = await open(P, { member: tokens.seller });
  await go(seller.page, "my-market", "[data-market-view=mine][data-market-state=ready]");
  const settings = seller.page.locator("[data-market-section=settings]");
  await settings.getByLabel("PayPal.me username").fill("TaylorDiscs");
  await settings.getByLabel("Cash App $cashtag").fill("$TaylorDiscs");
  await settings.getByLabel("Zelle email or phone").fill("252-555-0134");
  await settings.getByRole("button", { name: "Save payment settings" }).click();
  await settings.getByText("Payment settings saved.").waitFor();

  await go(seller.page, "market/sell", "form[aria-label='Sell a disc']");
  const form = seller.page.locator("form[aria-label='Sell a disc']");
  // No buyer-alert email yet: the form asks for it right here (required to sell).
  const emailBox = form.locator("[data-market-seller-email=required]");
  await emailBox.waitFor();
  await emailBox.getByLabel("Email for buyer alerts (required to sell)").fill("taylor@example.test");
  await form.getByLabel("Brand", { exact: true }).selectOption("Innova");
  await form.getByLabel("Mold", { exact: true }).fill("Destroyer");
  await form.getByLabel("Plastic", { exact: true }).selectOption("Star");
  await form.getByLabel("Disc type", { exact: true }).selectOption("driver");
  await form.getByLabel("Speed", { exact: true }).fill("12");
  await form.getByLabel("Glide", { exact: true }).fill("5");
  await form.getByLabel("Turn", { exact: true }).fill("-1");
  await form.getByLabel("Fade", { exact: true }).fill("3");
  await form.getByLabel("Weight (g)", { exact: true }).selectOption("175");
  await form.getByLabel("Color", { exact: true }).selectOption("Orange");
  await form.getByLabel("Condition", { exact: true }).selectOption("8");
  await form.getByLabel("Condition notes", { exact: true }).fill("Light ink on the flight plate, no rim dents");
  await form.getByLabel("Price (USD)", { exact: true }).fill("18");
  await form.getByLabel("Location or pickup notes", { exact: true }).fill("At Sunday Baggers");
  await form.getByLabel("Choose disc photos").setInputFiles(photoFile);
  await form.locator(".market-photo-thumb").first().waitFor();
  await shot(seller.page, "flow-sell-form-filled-390-light");
  await assertFits(seller.page, "sell form filled");
  await form.getByRole("button", { name: "Post listing" }).click();
  await seller.page.waitForURL(/#market\/listing\/\d+$/);
  state.listingId = Number(/listing\/(\d+)$/.exec(seller.page.url())[1]);
  await seller.page.locator("[data-market-view=listing][data-market-state=ready]").waitFor();
  await seller.page.locator("[data-market-seller-tools]").waitFor();
  assert.equal(photos.objects.size, 1, "the photo reached R2 through the Worker");
  const [stored] = [...photos.objects.values()];
  assert.equal(Buffer.from(stored.bytes).includes(Buffer.from("Exif")), false, "stored photo has no EXIF");
  const confirm = mail.find((row) => row.to === "taylor@example.test");
  assert(confirm && confirm.text.includes("You're set up to sell on the GVDG marketplace — buyer alerts will come here."), "seller email confirmed");
  assert.equal((await api("/market/settings", { token: tokens.seller })).settings.paypalMe, "TaylorDiscs", "saving the email kept the handles");
  console.log("member added a buyer-alert email inline and listed a disc with a photo");

  // 2. A guest browses, verifies by email code and buys.
  const guest = await open(P);
  await go(guest.page, "market", "[data-market-view=browse][data-market-state=ready]");
  const card = guest.page.locator(`article.market-card[data-market-listing="${state.listingId}"]`);
  await card.waitFor();
  assert.match(await card.innerText(), /\$18/);
  await card.locator(".market-card-title").click();
  await guest.page.locator("[data-market-view=listing][data-market-state=ready]").waitFor();
  await guest.page.getByText("Sign in or verify your email to see payment options.").waitFor();
  assert.equal(await guest.page.locator("[data-market-pay]").count(), 0, "public viewers see no payment handles");
  await guest.page.locator("[data-market-safety]").getByText(
    "Payments go directly to the seller. Meet at club events when you can. Use PayPal Goods & Services for shipped discs.").waitFor();
  await guest.page.getByRole("button", { name: "Buy for $18" }).click();
  const gate = guest.page.locator("[data-market-guest-gate=start]");
  await gate.waitFor();
  await shot(guest.page, "flow-guest-gate-390-light");
  await assertFits(guest.page, "guest gate");
  await gate.getByLabel("Display name").fill("Gail Guest");
  await gate.getByLabel("Email (never shown)").fill("gail@example.test");
  await gate.getByRole("button", { name: "Email me a code" }).click();
  const codeGate = guest.page.locator("[data-market-guest-gate=code]");
  await codeGate.waitFor();
  await codeGate.getByLabel("6-digit code").fill(await guestCode("gail@example.test"));
  await codeGate.getByRole("button", { name: "Verify code" }).click();
  const buyerDeal = guest.page.locator("[data-market-deal][data-deal-role=buyer]");
  await buyerDeal.waitFor();
  await buyerDeal.getByText("You're buying this").waitFor();
  state.guest = await guest.page.evaluate(() => JSON.parse(localStorage.getItem("gvdg_market_guest")));
  assert(state.guest?.token && state.guest.name === "Gail Guest", "guest token stored");
  assert.equal(JSON.stringify(state.guest).includes("gail@example.test"), false, "the guest's email is not kept client-side");

  // Pay links are exact and go through the safe-URL checks.
  const pay = buyerDeal.locator("[data-market-pay]");
  assert.equal(await pay.getByRole("link", { name: "Pay $18 with PayPal" }).getAttribute("href"), "https://paypal.me/TaylorDiscs/18.00");
  assert.equal(await pay.getByRole("link", { name: "Pay $18 with Cash App" }).getAttribute("href"), "https://cash.app/$TaylorDiscs/18.00");
  await pay.locator("li[data-pay-method=zelle]").getByText("Send $18.00 via Zelle to (252) 555-0134").waitFor();
  await pay.getByRole("button", { name: "Copy Zelle handle" }).click();
  assert.equal(await guest.page.evaluate(() => navigator.clipboard.readText()), "(252) 555-0134");
  await shot(guest.page, "flow-guest-bought-390-light");
  await assertFits(guest.page, "guest bought");
  console.log("guest verified by email code and bought; pay links exact");

  // 3. Another member sees the pending state; the seller sees the guest buyer and marks it sold.
  const other = await open(P, { member: tokens.buyer });
  await go(other.page, "market/listing/" + state.listingId, "[data-market-view=listing][data-market-state=ready]");
  assert.equal((await other.page.locator("p.market-pending").innerText()).trim(), "Pending — another buyer is finishing this");
  assert.equal(await other.page.getByRole("button", { name: /^Buy for/ }).count(), 0);
  await go(seller.page, "my-market", "[data-market-view=mine][data-market-state=ready]");
  const selling = seller.page.locator("[data-market-section=selling]");
  await selling.getByText("Gail Guest").first().waitFor();
  await selling.locator(".market-guest-badge").first().waitFor();
  await go(seller.page, "market/listing/" + state.listingId, "[data-deal-role=seller]");
  await seller.page.getByRole("button", { name: "Mark sold" }).click();
  await seller.page.locator("[data-market-view=listing]").getByText(/sold/i).first().waitFor();
  console.log("seller saw the pending guest buyer and marked it sold");

  // 4. Both sides leave feedback.
  async function leaveFeedback(page, comment) {
    await go(page, "my-market", "[data-market-view=mine][data-market-state=ready]");
    const box = page.locator("[data-market-section=feedback-to-leave]");
    await box.getByLabel("Positive").first().check();
    await box.getByLabel("Comment").first().fill(comment);
    await box.getByRole("button", { name: "Leave feedback" }).first().click();
    await page.locator("[data-market-section=feedback-to-leave]").waitFor({ state: "detached" }).catch(() => {});
  }
  await leaveFeedback(seller.page, "Paid right away, easy pickup.");
  await leaveFeedback(guest.page, "Disc exactly as described.");
  const feedbackRows = db.raw.prepare("SELECT rating, subject_role FROM market_feedback ORDER BY id").all();
  assert.deepEqual(feedbackRows.map((row) => row.subject_role).sort(), ["buyer", "seller"]);
  state.sellerKey = (await api("/market/listings/" + state.listingId)).listing.seller.key;
  await go(guest.page, "market/trader/" + state.sellerKey, "[data-market-view=trader][data-market-state=ready]");
  assert.equal((await guest.page.locator("[data-market-score]").first().innerText()).trim(), "100% positive (1)");
  console.log("both parties left feedback; profile shows 100% positive (1)");

  // 5. A trade offer is accepted.
  const tradeListing = (await api("/market/listings", { method: "POST", token: tokens.seller,
    body: listingBody({ brand: "Discraft", mold: "Buzzz", plastic: "ESP", discType: "midrange", weightG: 177, condition: 9, priceCents: 1500, openToTrade: true, tradeFor: "A stable putter" }) })).listing;
  await api("/market/settings", { method: "PUT", token: tokens.buyer, body: { notifyEmail: "jordan@example.test" } });
  const ownDisc = (await api("/market/listings", { method: "POST", token: tokens.buyer,
    body: listingBody({ brand: "Axiom", mold: "Envy", plastic: "Neutron", discType: "putter", weightG: 174, condition: 7, priceCents: 1400 }) })).listing;
  await go(other.page, "market/listing/" + tradeListing.id, "[data-market-view=listing][data-market-state=ready]");
  await other.page.getByRole("button", { name: "Propose a trade" }).click();
  const trade = other.page.locator("form[aria-label='Propose a trade']");
  await trade.getByLabel("Axiom Neutron Envy").check();
  await trade.getByLabel("What you'd offer").fill("Straight swap, can meet Sunday");
  await trade.getByRole("button", { name: "Send trade offer" }).click();
  await other.page.getByRole("button", { name: "Withdraw offer" }).waitFor();
  await go(seller.page, "market/listing/" + tradeListing.id, "[data-market-seller-tools]");
  const offer = seller.page.locator("li[data-market-offer][data-offer-status=open]");
  await offer.getByText("Axiom Neutron Envy").waitFor();
  await offer.getByRole("button", { name: "Accept trade" }).click();
  await seller.page.locator("[data-deal-role=seller]").getByText(/Trade with/).waitFor();
  await seller.page.getByRole("button", { name: "Mark traded" }).click();
  await seller.page.waitForFunction(async (id) => {
    const response = await fetch("/api/market/listings/" + id);
    return (await response.json()).listing?.status === "traded";
  }, tradeListing.id);
  assert.equal(db.raw.prepare("SELECT kind, status, outcome FROM market_deals WHERE listing_id = ?").get(tradeListing.id).outcome, "traded");
  console.log("trade offer proposed, accepted and marked traded");

  // 6. A guest's WANTED post gets an "I have one" reply (relayed by email; the guest's address stays hidden).
  const firebird = (await api("/market/listings", { method: "POST", token: tokens.seller,
    body: listingBody({ mold: "Firebird", plastic: "Champion", discType: "fairway", weightG: 172, condition: 9, priceCents: 1600 }) })).listing;
  await go(guest.page, "wanted/new", "form");
  const wantedForm = guest.page.locator("[data-market-view=wanted-new] form");
  await wantedForm.getByLabel("Brand", { exact: true }).selectOption("Innova");
  await wantedForm.getByLabel("Mold", { exact: true }).fill("Firebird");
  await wantedForm.getByLabel("Min weight (g)").selectOption("170");
  await wantedForm.getByLabel("Max weight (g)").selectOption("175");
  await wantedForm.getByLabel("Condition at least").selectOption("7");
  await wantedForm.getByLabel("Max price (USD)").fill("16");
  await wantedForm.getByLabel("Notes").fill("Champion plastic preferred");
  await wantedForm.getByRole("button", { name: "Post WANTED" }).click();
  await guest.page.waitForURL(/#wanted\/\d+$/);
  state.wantedId = Number(/wanted\/(\d+)$/.exec(guest.page.url())[1]);
  await go(seller.page, "wanted/" + state.wantedId, "[data-market-view=wanted-detail][data-market-state=ready]");
  await seller.page.getByRole("button", { name: "I have one" }).click();
  await seller.page.getByLabel("Link one of your listings (optional)").selectOption(String(firebird.id));
  await seller.page.getByLabel("Message").fill("I have a 172g Champion Firebird, 9/10.");
  await seller.page.getByRole("button", { name: "Send reply" }).click();
  await seller.page.getByText("Sent. The poster will get your message.").waitFor();
  const relay = mail.find((row) => row.to === "gail@example.test" && /I have one/.test(row.subject));
  assert(relay && relay.text.includes("172g Champion Firebird"), "WANTED reply relayed to the guest by email");
  await go(guest.page, "wanted/" + state.wantedId, "[data-market-view=wanted-detail][data-market-state=ready]");
  await guest.page.locator("li[data-market-reply]").getByText("172g Champion Firebird", { exact: false }).waitFor();
  console.log("WANTED post got an 'I have one' reply");

  // 7. A report lands in the admin Marketplace queue.
  await go(other.page, "market/listing/" + firebird.id, "[data-market-view=listing][data-market-state=ready]");
  await other.page.getByRole("button", { name: "Report this listing" }).click();
  await other.page.getByLabel("Why are you reporting this?").selectOption("wrong_info");
  await other.page.getByLabel("Anything else (optional)").fill("Photo shows a Star Firebird, not Champion.");
  await other.page.getByRole("button", { name: "Send report" }).click();
  await other.page.getByText("Thanks. A club admin will take a look.").waitFor();
  const admin = await open(P, { member: tokens.admin });
  await admin.page.goto(origin + "/admin.html#marketplace", { waitUntil: "domcontentloaded" });
  const report = admin.page.locator("li[data-admin-market-report]").first();
  await report.getByText("Innova Champion Firebird").waitFor();
  console.log("report appears in the admin Marketplace queue");

  // Leave a pending guest deal for the screenshots: listing detail with pay options + My marketplace pending.
  state.pending = (await api("/market/listings", { method: "POST", token: tokens.seller,
    body: listingBody({ brand: "MVP", mold: "Volt", plastic: "Neutron", discType: "fairway", weightG: 170, condition: 10, priceCents: 1850, location: "Will ship +$5" }) })).listing;
  await api(`/market/listings/${state.pending.id}/buy`, { method: "POST", token: state.guest.token });
  await api("/market/wanted", { method: "POST", token: tokens.buyer, body: { brand: "Discraft", mold: "Zone", plastic: "ESP", discType: "putter", conditionMin: 6, maxPriceCents: 1200, notes: "Any color" } });
  // 8. Withdraw is not final: the seller can relist for 24 hours; then the cron sweep makes it final.
  const wizard = (await api("/market/listings", { method: "POST", token: tokens.seller,
    body: listingBody({ brand: "Gateway", mold: "Wizard", plastic: "Super Stupid Soft", discType: "putter", weightG: 174, condition: 7, priceCents: 1200 }) })).listing;
  const photosBefore = photos.objects.size;
  await go(seller.page, "market/listing/" + wizard.id, "[data-market-seller-tools]");
  await seller.page.getByRole("button", { name: "Withdraw listing" }).click();
  await seller.page.getByRole("button", { name: "Yes, withdraw" }).click();
  await seller.page.locator("[data-market-relist]").getByText(/^Withdrawn — relist within 2[34] h$/).waitFor();
  assert.equal(photos.objects.size, photosBefore, "photos are kept during the relist window");
  assert.equal((await api("/market/listings")).listings.some((row) => row.id === wizard.id), false, "withdrawn listings stay out of browse");
  await go(seller.page, "my-market", "[data-market-view=mine][data-market-state=ready]");
  const row = seller.page.locator(`[data-market-my-listing="${wizard.id}"]`);
  await row.getByText(/^Withdrawn — relist within 2[34] h$/).waitFor();
  await shot(seller.page, "flow-my-marketplace-withdrawn-390-light");
  await assertFits(seller.page, "my marketplace withdrawn");
  await row.getByRole("button", { name: "Relist" }).click();
  await seller.page.waitForFunction(async (id) => (await (await fetch("/api/market/listings/" + id)).json()).listing?.status === "active", wizard.id);
  const relisted = (await api("/market/listings/" + wizard.id)).listing;
  assert.deepEqual(relisted.photos, wizard.photos, "relist keeps the same photos");
  assert.equal(relisted.priceCents, 1200);
  // After 24 hours the sweep makes it final and deletes the photos; relist is no longer offered.
  await api(`/market/listings/${wizard.id}/withdraw`, { method: "POST", token: tokens.seller });
  db.raw.prepare("UPDATE market_listings SET withdrawn_at = datetime('now', '-25 hours') WHERE id = ?").run(wizard.id);
  const swept = await sweep.finalizeWithdrawals(env);
  assert.equal(swept.finalized, 1);
  assert.equal(photos.objects.size, photosBefore - 1, "the final withdrawal deleted the photo from R2");
  await go(seller.page, "my-market", "[data-market-view=mine][data-market-state=ready]");
  await row.getByText("Withdrawn", { exact: true }).waitFor();
  assert.equal(await row.getByRole("button", { name: "Relist" }).count(), 0);
  // Leave one listing inside its relist window for the screenshots and the admin view.
  state.withdrawn = (await api("/market/listings", { method: "POST", token: tokens.seller,
    body: listingBody({ brand: "Prodigy", mold: "PA-3", plastic: "300", discType: "putter", weightG: 173, condition: 8, priceCents: 1300 }) })).listing;
  await api(`/market/listings/${state.withdrawn.id}/withdraw`, { method: "POST", token: tokens.seller });
  db.raw.prepare("UPDATE market_listings SET withdrawn_at = datetime('now', '-1 hour') WHERE id = ?").run(state.withdrawn.id);
  console.log("withdraw kept the listing 24 h; relist restored it; the sweep made a later withdrawal final");

  // 9. A member without a buyer-alert email can't list until they add one (the API says so too).
  const refused = await worker.fetch(new Request("https://worker.qa/market/listings", { method: "POST",
    headers: { Origin: origin, Authorization: "Bearer " + tokens.fresh, "Content-Type": "application/json" }, body: JSON.stringify(listingBody()) }), env);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "seller_email_required");

  // 10. The built bundle (as deployed) lazy-loads the marketplace chunk; the club shop alone does not.
  const built = await open(P);
  const scripts = [];
  built.page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await built.page.goto(origin + "/pro-shop-built.html", { waitUntil: "domcontentloaded" });
  await built.page.locator("[data-react-pro-shop=ready]").waitFor();
  assert.equal(scripts.some((path) => path.includes("/chunks/market-app-")), false, "the club shop does not load the marketplace chunk");
  await built.page.locator("nav[aria-label='Pro shop sections']").getByRole("link", { name: "Marketplace", exact: true }).click();
  await built.page.locator("[data-market-view=browse][data-market-state=ready] article.market-card").first().waitFor();
  assert.equal(scripts.some((path) => /^\/public-app\/chunks\/market-app-[\w-]+\.js$/.test(path)), true, "the marketplace chunk loads on demand");
  await built.context.close();
  console.log("built bundle lazy-loads the marketplace chunk");

  for (const view of [seller, guest, other, admin]) await view.context.close();
}


// Glass theme: the marketplace's cards and panels must visibly turn to glass (blurred, translucent) when a
// member's theme has glass on, and stay solid with it off. Off/on pairs are screenshotted for review.
async function runGlass() {
  const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide5.jpg")).toString("base64");
  for (const mode of ["dark", "light"]) {
    for (const glass of ["off", "frosted"]) {
      const theme = buildTheme({ mode, preset: "Frost", wallpaper, glass: GLASS_PRESETS[glass] });
      glassTheme = theme;
      const profile = { ...profiles[mode === "dark" ? "dark390" : "light390"], name: "390-" + mode + "-glass-" + glass };
      for (const [name, hash, ready] of [
        ["market-grid", "market", "article.market-card"],
        ["listing-detail", "market/listing/" + state.pending.id, "[data-market-view=listing][data-market-state=ready]"],
      ]) {
        const view = await open(profile, { member: tokens.seller, theme });
        await go(view.page, hash, ready);
        await view.page.waitForFunction(() => document.body.classList.contains("player-theme-active"));
        const look = await view.page.evaluate(() => {
          const card = document.querySelector(".market-panel, article.market-card");
          const style = getComputedStyle(card);
          // Computed colours come back as rgb(r g b / a), rgba(r, g, b, a) or color(srgb r g b / a) (color-mix).
          const bg = style.backgroundColor;
          const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(bg)?.[1];
          const comma = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(bg)?.[1];
          const raw = slash ?? comma;
          const alpha = raw == null ? 1 : raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
          return { glassClass: document.body.classList.contains("player-theme-glass"), blur: style.backdropFilter || style.webkitBackdropFilter || "", alpha, bg };
        });
        if (glass === "frosted") {
          assert.equal(look.glassClass, true, profile.name + " body has the glass class");
          assert.match(look.blur, /blur\((?!0px)/, profile.name + " " + name + " cards blur the wallpaper");
          assert(look.alpha < 0.8, profile.name + " " + name + " cards are see-through (" + look.bg + ")");
        } else {
          assert.equal(look.glassClass, false, profile.name + " no glass when off");
        }
        await assertFits(view.page, profile.name + " " + name);
        await shot(view.page, name + "-" + profile.name, { fullPage: false });
        await view.context.close();
      }
    }
  }
  glassTheme = null;
  console.log("glass theme: marketplace cards turn to glass when on and stay solid when off");
}

const screens = [
  ["market-grid", () => ({}), "market", "[data-market-view=browse][data-market-state=ready]"],
  ["listing-pay-options", () => ({ guest: state.guest }), () => "market/listing/" + state.pending.id, "[data-deal-role=buyer] [data-market-pay]"],
  ["sell-form", () => ({ member: tokens.seller }), "market/sell", "form[aria-label='Sell a disc']"],
  ["sell-form-email-prompt", () => ({ member: tokens.fresh }), "market/sell", "[data-market-seller-email=required]"],
  ["wanted", () => ({}), "wanted", "[data-market-view=wanted][data-market-state=ready]"],
  ["my-marketplace-pending", () => ({ member: tokens.seller }), "my-market", "[data-market-section=selling] [data-market-deal]"],
  ["my-marketplace-withdrawn", () => ({ member: tokens.seller }), "my-market", "[data-market-relist] button", "[data-market-section=listings]"],
  ["feedback-profile", () => ({}), () => "market/trader/" + state.sellerKey, "[data-market-view=trader][data-market-state=ready]"],
  ["admin-reports", () => ({ member: tokens.admin }), null, "li[data-admin-market-report]"],
];

async function runScreens() {
  for (const profile of [profiles.light390, profiles.dark390, profiles.dark320, profiles.light1280]) {
    for (const [name, who, hash, ready, clip] of screens) {
      const view = await open(profile, who());
      if (name === "admin-reports") {
        await view.page.goto(origin + "/admin.html#marketplace", { waitUntil: "domcontentloaded" });
        await view.page.locator(ready).first().waitFor();
      } else {
        await go(view.page, typeof hash === "function" ? hash() : hash, ready);
      }
      await view.page.waitForLoadState("networkidle").catch(() => {});
      await assertFits(view.page, profile.name + " " + name);
      if (clip) {
        await view.page.locator(clip).scrollIntoViewIfNeeded();
        await view.page.locator(clip).screenshot({ path: join(shotsDir, name + "-" + profile.name + ".png"), animations: "disabled" });
      } else {
        await shot(view.page, name + "-" + profile.name);
      }
      await view.context.close();
    }
    console.log(profile.name + ": " + screens.length + " marketplace screens fit");
  }
}

/** "Sell this" from My Bag: the sell form fills in from the bag hand-off, the bag photos go on the listing (copied by
 *  the Worker; the bag keeps its originals), bags and accessories list without disc details, and browse filters by kind. */
async function runBagSell() {
  const discId = crypto.randomUUID();
  db.raw.prepare(`INSERT INTO member_practice_records (owner, id, kind, revision, occurred_on, payload, last_op, updated_at)
    VALUES (?, ?, 'disc', 1, '2026-11-01', ?, 'op-' || ?, ?)`).run(people.seller.memberId, discId, JSON.stringify({
    brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange", weightGrams: 175, notes: "", inBag: true, archived: false, ink: "TM 252-555-0134",
  }), discId, Date.now());
  const bagPhoto = async (target) => (await api("/me/bag/photos", { method: "POST", token: tokens.seller, body: { ...target, image: photoDataUrl } })).photo.id;
  const discPhotos = [await bagPhoto({ discId }), await bagPhoto({ discId })];
  const wholePhoto = await bagPhoto({ bag: true });
  const cart = (await api("/me/bag/accessories", { method: "POST", token: tokens.seller, body: { kind: "cart", name: "Zuca all-terrain cart" } })).accessory;
  const cartPhoto = await bagPhoto({ accessoryId: cart.id });
  const bagKeys = () => db.raw.prepare("SELECT photo_key FROM bag_photos").all().map((row) => row.photo_key);
  const handoff = async (profile, item) => {
    const view = await open(profile, { member: tokens.seller });
    await view.context.addInitScript((value) => {
      if (!sessionStorage.getItem("gvdg_market_bag_handoff") && !sessionStorage.getItem("qa-posted")) sessionStorage.setItem("gvdg_market_bag_handoff", value);
    }, JSON.stringify(item));
    return view;
  };
  const post = async (view, form) => {
    await form.getByRole("button", { name: "Post listing" }).click();
    await view.page.waitForURL(/#market\/listing\/\d+$/);
    await view.page.evaluate(() => sessionStorage.setItem("qa-posted", "1"));
    await view.page.locator("[data-market-view=listing][data-market-state=ready]").waitFor();
    assert.equal(await view.page.evaluate(() => sessionStorage.getItem("gvdg_market_bag_handoff")), null, "the hand-off is cleared once posted");
    return Number(/listing\/(\d+)$/.exec(view.page.url())[1]);
  };

  // 1. A bag disc: filled in, both bag photos on (fetched privately), one taken off, then posted.
  const disc = await handoff(profiles.light390, { ref: "disc:" + discId, brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", weightG: "175", photos: discPhotos });
  await go(disc.page, "market/sell?from=bag", "form[aria-label='Sell a disc']");
  const discForm = disc.page.locator("form[aria-label='Sell a disc']");
  await discForm.getByText("Filled in from your bag. Check the details, set the condition and a price, and post.").waitFor();
  assert.equal(await discForm.getByRole("radio", { name: "Disc" }).isChecked(), true);
  assert.deepEqual(await Promise.all(["Brand", "Mold", "Plastic", "Color", "Weight (g)"].map((label) => discForm.getByLabel(label, { exact: true }).inputValue())),
    ["Innova", "Destroyer", "Star", "Orange", "175"]);
  const bagThumbs = discForm.locator("[data-market-bag-photos='2'] img");
  await bagThumbs.nth(1).waitFor();
  assert.match(await bagThumbs.first().getAttribute("src"), /^blob:/, "bag photos are fetched with the member's sign-in");
  await discForm.getByText("Your bag photos are on the listing.", { exact: false }).waitFor();
  await assertFits(disc.page, "sell a bag disc");
  await shot(disc.page, "flow-sell-from-bag-390-light");
  await discForm.getByRole("button", { name: "Remove photo 2" }).click();
  await discForm.locator("[data-market-bag-photos='1']").waitFor();
  await discForm.getByLabel("Disc type", { exact: true }).selectOption("driver");
  await discForm.getByLabel("Condition", { exact: true }).selectOption("8");
  await discForm.getByLabel("Price (USD)", { exact: true }).fill("20");
  const discListing = await post(disc, discForm);
  assert.deepEqual({ ...db.raw.prepare("SELECT item_kind, bag_ref, mold, weight_g FROM market_listings WHERE id = ?").get(discListing) },
    { item_kind: "disc", bag_ref: "disc:" + discId, mold: "Destroyer", weight_g: 175 });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM market_listing_photos WHERE listing_id = ?").get(discListing).n, 1);
  for (const key of bagKeys()) assert(photos.objects.has(key), "the bag keeps its private photos");
  await disc.context.close();

  // 2. The bag: no disc details, worded for a bag; 320 large text fits.
  const bag = await handoff(profiles.dark320, { ref: "bag", photos: [wholePhoto] });
  await go(bag.page, "market/sell?from=bag", "form[aria-label='Sell a bag']");
  const bagForm = bag.page.locator("form[aria-label='Sell a bag']");
  assert.equal(await bagForm.getByRole("radio", { name: "Bag" }).isChecked(), true);
  for (const label of ["Disc type", "Plastic", "Weight (g)", "Speed"]) assert.equal(await bagForm.getByLabel(label, { exact: true }).count(), 0, label + " is for discs");
  await bagForm.locator("[data-market-bag-photos='1'] img").first().waitFor();
  await bagForm.getByLabel("Brand (optional)").fill("Grip");
  await bagForm.getByLabel("Model", { exact: true }).fill("AX5");
  assert.match(await bagForm.getByLabel("Condition", { exact: true }).innerText(), /10 · New, never used/);
  await bagForm.getByLabel("Condition", { exact: true }).selectOption("9");
  await bagForm.getByLabel("Price (USD)", { exact: true }).fill("90");
  await assertFits(bag.page, "sell the bag, 320 large text");
  await shot(bag.page, "flow-sell-bag-320-large-dark");
  const bagListing = await post(bag, bagForm);
  await bag.page.locator("[data-market-view=listing]").getByText("New, never used", { exact: false }).count();
  assert.deepEqual({ ...db.raw.prepare("SELECT item_kind, disc_type, brand, mold, bag_ref FROM market_listings WHERE id = ?").get(bagListing) },
    { item_kind: "bag", disc_type: null, brand: "Grip", mold: "AX5", bag_ref: "bag" });
  await bag.context.close();

  // 3. An accessory: what it is comes from the bag.
  const acc = await handoff(profiles.light390, { ref: "accessory:" + cart.id, gearType: "cart", mold: cart.name, photos: [cartPhoto] });
  await go(acc.page, "market/sell?from=bag", "form[aria-label='Sell an accessory']");
  const accForm = acc.page.locator("form[aria-label='Sell an accessory']");
  assert.equal(await accForm.getByLabel("What is it?").inputValue(), "cart");
  assert.equal(await accForm.getByLabel("Name or model").inputValue(), "Zuca all-terrain cart");
  await accForm.getByLabel("Condition", { exact: true }).selectOption("7");
  await accForm.getByLabel("Price (USD)", { exact: true }).fill("45");
  const accListing = await post(acc, accForm);
  await acc.page.locator("[data-market-view=listing]").getByText("Cart", { exact: true }).first().waitFor();
  assert.deepEqual({ ...db.raw.prepare("SELECT item_kind, gear_type, bag_ref FROM market_listings WHERE id = ?").get(accListing) },
    { item_kind: "accessory", gear_type: "cart", bag_ref: "accessory:" + cart.id });
  await acc.context.close();
  assert.deepEqual((await api("/me/bag", { token: tokens.seller })).listings.map((row) => row.ref).sort(),
    ["accessory:" + cart.id, "bag", "disc:" + discId].sort(), "My Bag shows each item for sale");

  // 4. Choosing what to sell on a fresh form, and browsing by kind.
  const fresh = await open(profiles.light390, { member: tokens.seller });
  await go(fresh.page, "market/sell", "form[aria-label='Sell a disc']");
  await fresh.page.getByRole("radio", { name: "Accessory" }).check();
  const gearForm = fresh.page.locator("form[aria-label='Sell an accessory']");
  await gearForm.getByLabel("What is it?").waitFor();
  assert.equal(await gearForm.getByLabel("Disc type", { exact: true }).count(), 0);
  await fresh.page.getByRole("radio", { name: "Disc" }).check();
  await fresh.page.locator("form[aria-label='Sell a disc']").getByLabel("Disc type", { exact: true }).waitFor();
  await go(fresh.page, "market", "[data-market-view=browse][data-market-state=ready]");
  await fresh.page.locator("summary", { hasText: "More filters" }).click();
  await fresh.page.getByLabel("What", { exact: true }).selectOption("bag");
  await fresh.page.locator(`article.market-card[data-market-listing="${bagListing}"]`).waitFor();
  await fresh.page.waitForFunction((id) => [...document.querySelectorAll("article.market-card")].every((card) => card.getAttribute("data-market-listing") === String(id)), bagListing);
  assert.equal(await fresh.page.getByLabel("Disc type", { exact: true }).count(), 0, "disc-only filters hide for bags");
  await fresh.context.close();
  console.log("Sell this from My Bag: a disc, the bag and an accessory were listed with their bag photos (copied, the bag kept its own); browse filters by kind");
}

/** Giving part of a sale to the club: pledged on the sell form, shown on the card, sent from My marketplace with the
 *  club's PayPal link, confirmed by an admin, and only then +10 karma a whole dollar. */
async function runDonations() {
  const P = profiles.light390;
  const seller = await open(P, { member: tokens.seller });
  await go(seller.page, "market/sell", "form[aria-label='Sell a disc']");
  const form = seller.page.locator("form[aria-label='Sell a disc']");
  await form.getByLabel("Brand", { exact: true }).selectOption("Discraft");
  await form.getByLabel("Mold", { exact: true }).fill("Buzzz");
  await form.getByLabel("Disc type", { exact: true }).selectOption("midrange");
  await form.getByLabel("Condition", { exact: true }).selectOption("9");
  await form.getByLabel("Price (USD)", { exact: true }).fill("18");
  const share = form.locator("[data-market-club-share]");
  await share.getByRole("radio", { name: "A set amount" }).check();
  await share.getByLabel("Amount for the club (USD)").fill("25");
  await form.getByLabel("Choose disc photos").setInputFiles(photoFile);
  await form.locator(".market-photo-thumb").first().waitFor();
  await form.getByRole("button", { name: "Post listing" }).click();
  await form.getByText("The club's share is at least $1 and no more than the price.").waitFor();
  await share.getByRole("radio", { name: "25%" }).check();
  await assertFits(seller.page, "sell form with a club share");
  await form.getByRole("button", { name: "Post listing" }).click();
  await seller.page.waitForURL(/#market\/listing\/\d+$/);
  const listingId = Number(/listing\/(\d+)$/.exec(seller.page.url())[1]);
  await seller.page.locator("[data-market-view=listing][data-market-state=ready]").getByText("25% of this sale goes to the club").waitFor();
  await go(seller.page, "market", "[data-market-view=browse][data-market-state=ready]");
  await seller.page.locator(`article.market-card[data-market-listing="${listingId}"] [data-market-club-share]`).getByText("25% to the club").waitFor();

  // Sold to a member: the seller sends the club's share and says so.
  const deal = (await api(`/market/listings/${listingId}/buy`, { method: "POST", token: tokens.buyer })).deal;
  await api(`/market/deals/${deal.id}/complete`, { method: "POST", token: tokens.seller, body: { outcome: "sold" } });
  await go(seller.page, "my-market", "[data-market-view=mine][data-market-state=ready]");
  const panel = seller.page.locator(`[data-market-donation-deal="${deal.id}"]`);
  await panel.getByText("You pledged $4.50 of this sale to the club.").waitFor();
  assert.equal(await panel.getByLabel("Amount for the club (USD)").inputValue(), "4.50");
  assert.equal(await panel.getByRole("link", { name: "Send $4.50 with PayPal" }).getAttribute("href"), "https://paypal.me/greenvillediscgolf/4.50");
  await assertFits(seller.page, "club donation to send");
  await panel.screenshot({ path: join(shotsDir, "flow-donation-send-390-light.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "I sent it" }).click();
  await seller.page.locator(`[data-market-donation-deal="${deal.id}"][data-market-donation="sent"]`)
    .getByText("Waiting for the club to confirm your $4.50 donation arrived.").waitFor();

  // An admin checks the club PayPal and confirms: the karma lands then.
  const admin = await open(P, { member: tokens.admin });
  await admin.page.goto(origin + "/admin.html#marketplace", { waitUntil: "domcontentloaded" });
  const card = admin.page.locator("li[data-admin-market-donation]").first();
  await card.getByText("$4.50 from Taylor Morgan").waitFor();
  await card.getByText("Received gives them +40 karma.", { exact: false }).waitFor();
  await assertFits(admin.page, "admin donation to confirm");
  await card.screenshot({ path: join(shotsDir, "flow-donation-admin-390-light.png"), animations: "disabled" });
  await card.getByRole("button", { name: "Received", exact: true }).click();
  await admin.page.getByText("No donations waiting.", { exact: false }).waitFor();
  assert.deepEqual({ ...db.raw.prepare("SELECT status, karma, amount_cents FROM market_donations WHERE deal_id = ?").get(deal.id) },
    { status: "confirmed", karma: 40, amount_cents: 450 });
  await go(seller.page, "my-market", "[data-market-view=mine][data-market-state=ready]");
  await seller.page.locator(`[data-market-donation-deal="${deal.id}"][data-market-donation="confirmed"]`)
    .getByText("The club received your $4.50 donation: +40 karma. Thank you!").waitFor();
  assert.equal((await api("/lost-found/me", { token: tokens.seller })).karma.karma, 40, "the karma joins the seller's karma");
  await seller.context.close();
  await admin.context.close();
  console.log("club donation: pledged 25% on the listing, sent from My marketplace, confirmed by an admin, +40 karma");
}

try {
  await runFlows();
  await runBagSell();
  await runDonations();
  if (!process.env.GVDG_MARKET_SKIP_SCREENS) await runScreens();
  await runGlass();
  assert.deepEqual(pageErrors, [], "page errors");
  console.log("marketplace browser QA passed; screenshots in " + shotsDir);
} finally {
  await browser.close();
  await vite.close();
  globalThis.fetch = realFetch;
}
