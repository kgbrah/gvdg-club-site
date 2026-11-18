// Browser QA for Lost & Found (lost-found.html, member Home, the homepage strip and the admin queue).
//
// The API is the REAL Worker (auth-worker/src/index.ts, loaded through Vite SSR) running in-process over an
// in-memory SQLite database with every migration applied, in-memory KV and R2, a captured Resend (the
// guest's 6-digit code is read from the captured email) and a MOCKED Gemini that "reads" the ink on a photo
// drawn in a canvas. Photos are public as uploaded; the read is private.
//
// Flows: the public menu shows Lost & Found next to Pro Shop at 1280 / 1100 / 1025 and in the 1024 / 768 / 390 /
// 320 large-text menus without wrapping. Then (390 light): every post form says photos are public, with the tip; a
// member's lost post carries a name and phone as PRIVATE text; a guest verifies by email and posts a found disc
// whose photo shows that name and phone: the photo is up at once, the guest (only) sees "This photo may show a
// name or phone number" with Replace photo / Keep it, nobody else does, and no payload carries the ink; Replace
// photo swaps the file (the old one 404s and leaves storage); the match notice reaches the member; "Is this
// yours?" -> That's mine -> relayed contact -> Returned -> confirmed -> +10 karma; the finder's celebration shows
// on the Returned wall (its nudge kept from My posts), member Home and the homepage strip; a report reaches the
// admin queue with the reported photo and Remove photo. Then the key screens are checked at 390 light / 390 dark /
// 320 large-text dark / 1280 light for overflow and clipped labels, screenshotted, and glass on/off is checked.
//
// Usage: CHROMIUM_PATH=/usr/bin/chromium GVDG_QA_NO_SANDBOX=1 node scripts/qa/lost-found-browser-qa.mjs
// Env: GVDG_LF_SHOTS=<dir> (default: a temp dir), GVDG_LF_PORT, GVDG_LF_SKIP_SCREENS=1 (flows + glass only),
// GVDG_LF_MENU_ONLY=1 (just the menu fit checks and screenshots).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { createServer } from "vite";
import { GLASS_PRESETS, buildTheme } from "../../src/shared/dashboard-theme-model.js";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const shotsDir = process.env.GVDG_LF_SHOTS || await mkdtemp(join(tmpdir(), "gvdg-lf-shots-"));
await mkdir(shotsDir, { recursive: true });
const workDir = await mkdtemp(join(tmpdir(), "gvdg-lf-work-"));

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
      return hit ? { body: new Blob([hit.bytes]).stream(), arrayBuffer: async () => hit.bytes.slice().buffer, httpMetadata: { contentType: hit.type } } : null;
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
        async run() { const info = db.prepare(sql).run(...bound); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      };
      return stmt;
    },
  };
}

const people = {
  owner: { memberId: "m_qa_owner", name: "Jordan Parker" },
  other: { memberId: "m_qa_other", name: "Riley Chen" },
  admin: { memberId: "m_qa_admin", name: "Avery Brooks", isAdmin: true },
  finder2: { memberId: "m_qa_finder", name: "Taylor Morgan" },
};
const roster = Object.fromEntries(Object.values(people).map((person) => ["member:" + person.memberId,
  JSON.stringify({ ...person, isAdmin: person.isAdmin === true, pinHash: "qa", mustChangePin: false })]));
const secret = "qa-" + "s".repeat(40);
const db = await memoryD1();
const photos = memoryR2();
const mail = [];
const NO_INK = JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "Star Destroyer", ink: [], unreadable_writing: false, ink_confidence: "high" });
let geminiQueue = [];
// Whisper (Groq first, OpenRouter as the backup), mocked: what the next clip "says", what was sent, and a Groq
// answer to force (e.g. its free-plan 429) for the next call.
let whisperQueue = [];
const whisperCalls = [];
let groqStatusNext = 0;
let geminiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body || "{}"));
    mail.push({ to: body.to?.[0], subject: body.subject, text: body.text });
    return new Response("{}", { status: 200 });
  }
  if (url === "https://openrouter.ai/api/v1/audio/transcriptions" || url === "https://api.groq.com/openai/v1/audio/transcriptions") {
    const form = init?.body;
    const file = form?.get?.("file");
    const provider = url.includes("groq") ? "groq" : "openrouter";
    whisperCalls.push({ provider, model: form?.get?.("model"), language: form?.get?.("language"), prompt: form?.get?.("prompt") ?? null,
      name: file?.name, type: file?.type, size: file?.size, auth: new Headers(init?.headers).get("Authorization") });
    if (provider === "groq" && groqStatusNext) {
      const status = groqStatusNext;
      groqStatusNext = 0;
      return Response.json({ error: { message: "limit" } }, { status });
    }
    return Response.json({ text: whisperQueue.shift() ?? "" });
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    geminiCalls += 1;
    const body = String(init?.body || "");
    const text = body.includes("SAME physical disc") ? '{"same":"yes"}' : geminiQueue.shift() ?? NO_INK;
    return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
  }
  if (/^https:\/\/[^/]*push|fcm\.googleapis|updates\.push/.test(url)) return new Response("", { status: 201 });
  return realFetch(input, init);
};

// ---------------------------------------------------------------------------------------------------
// Vite server: pages + the real Worker for Lost & Found, messages and admin needs; small fixtures for the rest
// ---------------------------------------------------------------------------------------------------

const entries = {
  "/lost-found.html": "/src/public-app/main.js",
  "/pro-shop.html": "/src/public-app/main.js",
  "/admin.html": "/src/admin-app/main.js",
  "/gvdg-members.html": "/src/members-app/main.js",
  "/index.html": "/src/home-app/main.js",
};
let worker = null;
let jwt = null;
let env = null;
let origin = "";
let glassTheme = null;
const tokenOwners = new Map();
const WORKER_PATHS = /^\/(lost-found|admin\/lost-found|market|admin\/market|me\/messages|me\/notices|me\/bag|voice\/disc|courses\/\d+\/layouts)(\/|$)/;

function fixture(path, authorization) {
  if (path === "/me") {
    const sub = authorization ? tokenOwners.get(authorization.slice(7)) : null;
    const person = Object.values(people).find((row) => row.memberId === sub);
    return person ? [200, { sub: person.memberId, name: person.name, isAdmin: person.isAdmin === true, mustChangePin: false, pdgaNo: "" }] : [401, { error: "unauthorized" }];
  }
  if (path === "/me/dashboard-theme") return [200, { theme: glassTheme }];
  if (path === "/courses") return [200, { courses: db.raw.prepare("SELECT id, name, location, lat, lng FROM courses ORDER BY id LIMIT 30").all() }];
  // A casual card this phone is on (the QA's "Return to round" detection); members have no live club event.
  if (path === "/rounds/QA9/live/mine") return [200, { status: "live", cardId: 1, cardmates: [{ name: "Riley Chen" }] }];
  if (path === "/my-live-rounds") return [200, { rounds: [] }];
  if (path === "/shop/products") return [200, { products: [] }];
  if (path === "/shop/wallet") return [200, { balance_cents: 0, transactions: [], orders: [] }];
  if (path === "/payments/config") return [200, { enabled: false }];
  if (path === "/events" || path === "/registration/open") return [200, { events: [] }];
  if (path === "/my-registrations") return [200, { registrations: [] }];
  if (path === "/my-live-rounds") return [200, { rounds: [] }];
  if (path === "/admin/members") return [200, { members: Object.values(people) }];
  if (path === "/admin/members/applications") return [200, { applications: [] }];
  if (path === "/admin/orders") return [200, { unfulfilled: 0, orders: [] }];
  if (path === "/admin/tee-signs") return [200, { teeSigns: [] }];
  if (path === "/admin/bag-tags") return [200, { leagues: [], requests: [], challenges: [], holders: [] }];
  if (path === "/admin/community/reviews") return [200, { queue: [], more: false }];
  return [200, {}];
}

async function memberToken(person) {
  const token = await jwt.signSession({ sub: person.memberId, mustChangePin: false }, secret, 43200);
  tokenOwners.set(token, person.memberId);
  return token;
}

function shellHtml(html) {
  return html
    .replace(/<link[^>]+https:[^>]+>/g, "")
    .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
    .replace(/\sdata-(?:auth|api)-base="[^"]*"/g, "")
    .replace("<body", '<body data-auth-base="/api" data-api-base="/api"');
}

const vite = await createServer({
  configFile: false,
  cacheDir: await mkdtemp(join(tmpdir(), "gvdg-lf-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_LF_PORT || 0), strictPort: Boolean(process.env.GVDG_LF_PORT), hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  logLevel: "warn",
  plugins: [{ name: "lost-found-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/lost-found-built.html" || url.pathname === "/pro-shop-built.html") {
        // The shipped pages as is: the BUILT public-app.js, which lazy-loads public-app/chunks/lf-app-*.js.
        const html = shellHtml(await readFile(url.pathname.replace("-built", "").slice(1), "utf8"));
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
        return;
      }
      if (url.pathname.startsWith("/public-app/") && url.pathname.endsWith(".js")) {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(await readFile(url.pathname.slice(1)));
        return;
      }
      if (url.pathname === "/blank.html") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><meta charset=utf-8><title>canvas</title>");
        return;
      }
      const entry = entries[url.pathname];
      if (entry) {
        const html = shellHtml(await readFile(url.pathname.slice(1), "utf8"))
          .replace(/src="(?:public-app|admin-app|members-app|home-app)\/[^"]+\.js(?:\?v=\d+)?"/, 'src="' + entry + '"')
          .replace(/<link rel="modulepreload"[^>]*>/g, "");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await server.transformIndexHtml(url.pathname, html));
        return;
      }
      if (!url.pathname.startsWith("/api/")) return next();
      const path = url.pathname.slice("/api".length);
      if (WORKER_PATHS.test(path)) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
        headers.set("Origin", origin);
        headers.set("CF-Connecting-IP", "198.51.100." + (1 + (mail.length % 200)));
        const pending = [];
        const result = await worker.fetch(new Request("https://worker.qa" + path + url.search, {
          method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
        }), env, { waitUntil: (promise) => pending.push(promise) });
        const body = Buffer.from(await result.arrayBuffer());
        // Background work (the private AI read, matching, notices) finishes before the page sees the answer.
        while (pending.length) await Promise.allSettled(pending.splice(0));
        const out = {};
        result.headers.forEach((value, key) => { out[key] = value; });
        response.writeHead(result.status, out);
        response.end(body);
        return;
      }
      const [status, data] = fixture(path, request.headers.authorization);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    });
  } }],
});
await vite.listen();
origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
worker = (await vite.ssrLoadModule("/auth-worker/src/index.ts")).default;
jwt = await vite.ssrLoadModule("/auth-worker/src/jwt.ts");
const lfProcess = await vite.ssrLoadModule("/auth-worker/src/lf-process.ts");
env = {
  ROSTER: memoryKv(roster), RATELIMIT: memoryKv(), DB: db, PHOTOS: photos, JWT_SECRET: secret, SESSION_TTL_SEC: "43200",
  ALLOWED_ORIGINS: origin, RESEND_API_KEY: "re_qa", GEMINI_API_KEY: "gk_qa", EXPECTED_ORIGIN: "https://gvdgclub.com",
  // The QA makes more reads a minute than a real club; the free-tier pacing is covered by the Worker tests.
  LF_VISION_PER_MINUTE: "1000",
};
const tokens = {};
for (const [key, person] of Object.entries(people)) tokens[key] = await memberToken(person);

/** Call the in-process Worker directly (seeding / assertions), as the browser would. */
async function api(path, { method = "GET", token, body } = {}) {
  const headers = { Origin: origin, "CF-Connecting-IP": "198.51.100.250" };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const pending = [];
  const result = await worker.fetch(new Request("https://worker.qa" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, { waitUntil: (promise) => pending.push(promise) });
  while (pending.length) await Promise.allSettled(pending.splice(0));
  const text = await result.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!result.ok) throw new Error(`${method} ${path} -> ${result.status} ${text}`);
  return data;
}

// ---------------------------------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------------------------------

// A simulated camera (Chromium's moving test pattern, permission granted) so the in-app camera can be driven.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...(process.env.GVDG_QA_NO_SANDBOX ? ["--no-sandbox"] : [])],
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
  });
  await context.addInitScript(({ mode, large, member, guest, theme, ids }) => {
    localStorage.setItem("theme", mode);
    if (theme) for (const id of ids) localStorage.setItem("gvdg_dashboard_theme:" + id, JSON.stringify(theme));
    if (member) localStorage.setItem("gvdg_member_token", member);
    if (guest) localStorage.setItem("gvdg_market_guest", JSON.stringify(guest));
    if (large) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "20px"; }, { once: true });
  }, { mode: profile.mode, large: Boolean(profile.large), member: member || "", guest: guest || null, theme: theme || null, ids: [...Object.values(people).map((row) => row.memberId), "me"] });
  await context.route(/^https?:/, (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(profile.name + ": " + error.message));
  // React warnings (duplicate keys, bad props) count as failures; expected 401/404 resource loads do not.
  page.on("console", (message) => {
    if (message.type() === "error" && !/^Failed to load resource/.test(message.text())) pageErrors.push(profile.name + " console: " + message.text().slice(0, 200));
  });
  return { context, page };
}

async function assertFits(page, label) {
  await page.evaluate(() => document.fonts.ready);
  // Same clipped-label rule as the marketplace / member-subpages QA: a visible button, link or summary whose
  // text overflows without a real ellipsis is clipped (flex/grid buttons never render one).
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
  const target = origin + "/lost-found.html" + (hash ? "#" + hash : "");
  if (page.url() === target) await page.reload({ waitUntil: "domcontentloaded" });
  else await page.goto(target, { waitUntil: "domcontentloaded" });
  if (ready) await page.locator(ready).first().waitFor();
}

async function guestCode(email) {
  const message = [...mail].reverse().find((row) => row.to === email && /verification code/.test(row.subject));
  assert(message, "a code email was sent to " + email);
  return /code is (\d{6})/.exec(message.text)[1];
}

/** A disc photo with (optionally) a name and phone number written on it, and the mocked Gemini read of it. */
async function makeInkPhoto(file, lines) {
  const { context, page } = await open(profiles.light390);
  await page.goto(origin + "/blank.html");
  const result = await page.evaluate(async (lines) => {
    const canvas = document.createElement("canvas");
    canvas.width = 960; canvas.height = 720;
    const g = canvas.getContext("2d");
    const grass = g.createLinearGradient(0, 0, 0, 720);
    grass.addColorStop(0, "#4f8a3c"); grass.addColorStop(1, "#2f5d27");
    g.fillStyle = grass; g.fillRect(0, 0, 960, 720);
    for (let i = 0; i < 900; i++) { g.fillStyle = i % 2 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.08)"; g.fillRect((i * 97) % 960, (i * 53) % 720, 2, 14); }
    const disc = g.createRadialGradient(440, 330, 40, 480, 360, 300);
    disc.addColorStop(0, "#ff8a5b"); disc.addColorStop(1, "#e85a28");
    g.fillStyle = disc; g.beginPath(); g.arc(480, 360, 300, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(0,0,0,.18)"; g.lineWidth = 16; g.beginPath(); g.arc(480, 360, 286, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "rgba(255,255,255,.88)"; g.textAlign = "center"; g.font = "bold 58px sans-serif"; g.fillText("DESTROYER", 480, 290);
    g.font = "26px sans-serif"; g.fillText("INNOVA  ·  STAR", 480, 330);
    g.textAlign = "left"; g.fillStyle = "#151515";
    for (const [text, x, y, size] of lines) {
      g.font = `italic bold ${size}px "Comic Sans MS", cursive, sans-serif`;
      g.fillText(text, x, y);
    }
    return canvas.toDataURL("image/jpeg", 0.9);
  }, lines);
  await context.close();
  await writeFile(file, Buffer.from(result.split(",")[1], "base64"));
  const ink = lines.map(([text]) => ({ text, type: /\d{3}/.test(text) ? "phone" : "name" }));
  return { file, reply: JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "Star Destroyer",
    ink, unreadable_writing: false, ink_confidence: "high" }) };
}

const PHOTO_TIP = "Photos are public. Cover any name or phone number on the disc (a thumb or a strip of tape works) or show the other side.";
const NUDGE = "This photo may show a name or phone number, and anyone can see it.";
const INK_TEXT = /JORDAN PARKER|252-555-0187|0187/;

/** No payload anyone but the poster gets carries the ink, a nudge, or a storage key. */
async function assertNoLeak(label, paths, token) {
  for (const path of paths) {
    const text = JSON.stringify(await api(path, { token }));
    assert.doesNotMatch(text, INK_TEXT, label + ": " + path + " carries the ink");
    assert.doesNotMatch(text, /"nudge"|myPhotos|"nudges":\[\{|lost-found\/post-/, label + ": " + path + " carries a nudge or a storage key");
  }
}

const state = {};

async function runFlows() {
  const P = profiles.light390;
  const ink = await makeInkPhoto(join(workDir, "found-disc.jpg"), [["JORDAN PARKER", 300, 440, 50], ["252-555-0187", 330, 510, 50]]);

  // 1. A member posts a lost disc with PRIVATE ink text.
  const owner = await open(P, { member: tokens.owner });
  await go(owner.page, "new/lost", "form[aria-label='Post a lost disc']");
  const lostForm = owner.page.locator("form[aria-label='Post a lost disc']");
  await lostForm.getByLabel("Brand", { exact: true }).selectOption("Innova");
  await lostForm.getByLabel("Mold", { exact: true }).fill("Destroyer");
  await lostForm.getByLabel("Plastic", { exact: true }).selectOption("Star");
  await lostForm.getByLabel("Colour", { exact: true }).selectOption("Orange");
  await lostForm.getByLabel("Weight (if you know it)", { exact: true }).selectOption("175");
  await pickCourse(lostForm, "ECU North", "ECU North Rec Complex");
  await lostForm.getByLabel("Hole lost on", { exact: true }).selectOption("7");
  await lostForm.getByLabel("Where exactly (optional)", { exact: true }).fill("by the pond");
  await lostForm.getByLabel("Reward note (optional, shown)").fill("Cold drink on me");
  await lostForm.getByLabel("What's written on it (private)").fill("Jordan Parker 252-555-0187");
  await lostForm.locator("[data-lf-photo-tip]").getByText(PHOTO_TIP).waitFor();
  await shot(owner.page, "flow-lost-form-390-light");
  await assertFits(owner.page, "lost form");
  await lostForm.getByRole("button", { name: "Post lost disc" }).click();
  await owner.page.waitForURL(/#post\/\d+$/);
  state.lostId = Number(/post\/(\d+)$/.exec(owner.page.url())[1]);
  await owner.page.locator("[data-lf-view=post][data-lf-state=ready]").waitFor();
  await owner.page.locator(".lf-private").getByText("What's written on it: Jordan Parker 252-555-0187").waitFor();
  assert.equal((await api("/lost-found/posts/" + state.lostId)).post.privateInk, undefined, "the public view has no private ink");
  console.log("member posted a lost disc with private ink text");

  // 2. A guest verifies by email and posts the found disc with the inked photo.
  const guest = await open(P);
  await go(guest.page, "new/found", "form[aria-label='Post a found disc']");
  const form = guest.page.locator("form[aria-label='Post a found disc']");
  await form.getByLabel("Choose disc photos").setInputFiles(ink.file);
  await form.locator(".market-photo-thumb").first().waitFor();
  await pickCourse(form, "ecu", "ECU North Rec Complex");
  await form.getByLabel("Hole found on", { exact: true }).selectOption("7");
  await form.getByLabel("Where exactly (optional)", { exact: true }).fill("drop zone");
  await form.locator("[data-lf-photo-tip]").getByText(PHOTO_TIP).waitFor();
  await form.getByText("Anyone can see the photos you post.", { exact: false }).waitFor();
  assert.equal(await form.getByText(/blur/i).count(), 0, "the form promises no blurring");
  await shot(guest.page, "flow-found-form-390-light");
  await assertFits(guest.page, "found form");
  geminiQueue.push(ink.reply);
  await form.getByRole("button", { name: "Post found disc" }).click();
  const gate = guest.page.locator("[data-market-guest-gate=start]");
  await gate.waitFor();
  await gate.getByLabel("Display name").fill("Gail Finder");
  await gate.getByLabel("Email (never shown)").fill("gail@example.test");
  await gate.getByRole("button", { name: "Email me a code" }).click();
  const codeGate = guest.page.locator("[data-market-guest-gate=code]");
  await codeGate.waitFor();
  await codeGate.getByLabel("6-digit code").fill(await guestCode("gail@example.test"));
  await codeGate.getByRole("button", { name: "Verify code" }).click();
  await guest.page.waitForURL(/#post\/\d+$/);
  state.foundId = Number(/post\/(\d+)$/.exec(guest.page.url())[1]);
  const detail = guest.page.locator("[data-lf-view=post][data-lf-state=ready]");
  await detail.waitFor();
  // The photo is up at once.
  await detail.locator("[data-lf-gallery='1'] img.market-gallery-main").waitFor();
  state.guest = await guest.page.evaluate(() => JSON.parse(localStorage.getItem("gvdg_market_guest")));
  assert(state.guest?.token && state.guest.name === "Gail Finder", "the shared guest token is stored");
  assert.equal(JSON.stringify(state.guest).includes("gail@"), false, "the guest's email is not kept client-side");
  console.log("guest verified by email and posted a found disc; its photo is up straight away");

  // 3. The private read found a name and phone in the photo: the guest (only) gets the nudge, never the text.
  const nudge = guest.page.locator("[data-lf-nudges] [data-lf-nudge]");
  await nudge.getByText(NUDGE).waitFor();
  await nudge.getByRole("button", { name: "Replace photo" }).waitFor();
  await nudge.getByRole("button", { name: "Keep it" }).waitFor();
  assert.doesNotMatch(await guest.page.locator("main, body").first().innerText(), INK_TEXT, "the poster's page never shows what was read");
  await shot(guest.page, "flow-nudge-390-light");
  await assertFits(guest.page, "post with the nudge");
  const firstPhoto = db.raw.prepare("SELECT id, photo_key, nudge FROM lf_photos WHERE post_id = ?").get(state.foundId);
  assert.equal(firstPhoto.nudge, "shown");
  const viewer = await open(P, { member: tokens.other });
  await go(viewer.page, "post/" + state.foundId, "[data-lf-view=post][data-lf-state=ready] [data-lf-gallery='1'] img");
  assert.equal(await viewer.page.locator("[data-lf-nudges], [data-lf-nudge]").count(), 0, "nobody else sees the nudge");
  assert.equal(await viewer.page.getByText(NUDGE).count(), 0);
  assert.doesNotMatch(await viewer.page.locator("body").innerText(), INK_TEXT);
  await shot(viewer.page, "flow-found-post-viewer-390-light");
  await viewer.context.close();
  const publicPaths = ["/lost-found/posts?kind=found", "/lost-found/posts?kind=lost", "/lost-found/posts/" + state.foundId, "/lost-found/returned",
    "/lost-found/returned?view=strip"];
  await assertNoLeak("signed out", publicPaths);
  await assertNoLeak("another member", [...publicPaths, "/lost-found/me"], tokens.other);
  console.log("the nudge shows to the poster only; no payload carries the ink");

  // Replace photo: a new upload (the writing covered) takes its place; the old file 404s and leaves storage.
  const covered = await makeInkPhoto(join(workDir, "covered.jpg"), []);
  geminiQueue.push(covered.reply);
  await nudge.locator("input[type=file]").setInputFiles(covered.file);
  await guest.page.locator("[data-lf-nudges]").waitFor({ state: "detached" });
  const replaced = db.raw.prepare("SELECT id, photo_key, nudge, read_state FROM lf_photos WHERE post_id = ? AND status = 'public'").get(state.foundId);
  assert.notEqual(replaced.id, firstPhoto.id);
  assert.deepEqual([replaced.nudge, replaced.read_state], ["", "done"]);
  assert.equal(photos.objects.has(firstPhoto.photo_key), false, "the old file left storage");
  assert.equal((await realFetch(origin + "/api/lost-found/photos/" + firstPhoto.id)).status, 404);
  assert.equal((await realFetch(origin + "/api/lost-found/photos/" + replaced.id)).status, 200);
  await detail.locator(`[data-lf-gallery='1'] img[src$="/lost-found/photos/${replaced.id}"]`).waitFor();
  // The old read still helps matching; the post is unchanged otherwise.
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM lf_extractions WHERE post_id = ? AND ink_phones <> ''").get(state.foundId).n, 1);
  console.log("Replace photo swapped the file; the old one is gone");

  // 4. The match notice reaches the member (in-app + Lost & Found), and "Is this yours?" -> That's mine.
  const match = db.raw.prepare("SELECT id, status, candidate_id, reasons FROM lf_matches WHERE found_id = ?").get(state.foundId);
  assert.equal(match.status, "notified");
  assert.equal(match.candidate_id, people.owner.memberId);
  assert.match(match.reasons, /ink_phone/);
  state.matchId = match.id;
  const notices = await api("/me/notices", { token: tokens.owner });
  assert(notices.notices.some((notice) => notice.title === "Is this your disc?" && notice.href === "/gvdg-members.html#lost-found"), "member got the match notice");
  assert(mail.some((row) => row.to === "gail@example.test" && row.subject === "Someone may own the disc you found"), "finder told by email");
  await go(owner.page, "mine", "[data-lf-view=mine][data-lf-state=ready]");
  await owner.page.locator("[data-lf-section=matches] [data-lf-match-row]").first().waitFor();
  await shot(owner.page, "flow-mine-match-390-light");
  await owner.page.locator("[data-lf-section=matches] a.market-card-title").first().click();
  const matchPanel = owner.page.locator(".lf-match");
  await matchPanel.waitFor();
  await matchPanel.getByText("The phone number on the disc matches").waitFor();
  assert.equal(await owner.page.getByText("0187").count(), 0, "the match view never shows the private ink");
  await shot(owner.page, "flow-is-this-yours-390-light");
  await assertFits(owner.page, "is this yours");
  await matchPanel.getByLabel("Anything the finder should know? (optional)").fill("I can meet at the course Saturday morning.");
  await matchPanel.getByRole("button", { name: "That's mine" }).click();
  await owner.page.waitForURL(/#claim\/\d+$/);
  state.claimId = Number(/claim\/(\d+)$/.exec(owner.page.url())[1]);
  await owner.page.locator("[data-lf-view=claim][data-lf-claim-status=open]").waitFor();
  console.log("member saw the match and said That's mine");

  // 5. Contact: relayed by email because the finder is a guest; no addresses shown.
  const thread = owner.page.locator(".lf-thread");
  await thread.getByLabel("Message").fill("Saturday 9am at the first tee works for me.");
  await thread.getByRole("button", { name: "Send message" }).click();
  await thread.locator(".lf-message.is-mine").filter({ hasText: "Saturday 9am" }).waitFor();
  const relay = mail.find((row) => row.to === "gail@example.test" && /a message about/.test(row.subject));
  assert(relay && relay.text.includes("Saturday 9am") && !/m_qa_owner|@example/.test(relay.text.replace("gail@example.test", "")), "relayed without addresses");
  console.log("contact relayed to the guest finder by email");

  // 6. The finder marks it returned (My posts shows the pending return), the owner confirms, +10 karma.
  await go(guest.page, "mine", "[data-lf-view=mine][data-lf-state=ready]");
  await guest.page.locator(`[data-lf-claim-row="${state.claimId}"][data-lf-claim-status=open]`).waitFor();
  await go(guest.page, "claim/" + state.claimId, "[data-lf-view=claim][data-lf-role=finder]");
  await guest.page.locator(".lf-thread .lf-message").filter({ hasText: "Saturday 9am" }).waitFor();
  await guest.page.getByRole("button", { name: "Returned" }).click();
  await guest.page.getByText("Marked returned. The owner will confirm.").waitFor();
  await go(owner.page, "mine", "[data-lf-view=mine][data-lf-state=ready]");
  await owner.page.locator(`[data-lf-claim-row="${state.claimId}"][data-lf-claim-status=returned]`).waitFor();
  await shot(owner.page, "flow-mine-pending-return-390-light");
  await assertFits(owner.page, "my posts with a pending return");
  await go(owner.page, "claim/" + state.claimId, "[data-lf-view=claim][data-lf-claim-status=returned]");
  await owner.page.getByRole("button", { name: "I got it back" }).click();
  await owner.page.locator("[data-lf-karma-awarded=true]").getByText("Back home! Gail Finder earned +10 karma.").waitFor();
  const karma = db.raw.prepare("SELECT person_id, delta FROM lf_karma").all();
  assert.deepEqual(karma.map((row) => row.delta), [10]);
  assert.match(karma[0].person_id, /^mg_/, "the guest finder earned the karma");
  await shot(owner.page, "flow-confirmed-karma-390-light");
  console.log("finder marked Returned, owner confirmed, +10 karma once");

  // 7. The finder celebrates -> wall, Top finders. The photo is up at once; its nudge is kept from My posts.
  const celebrationInk = await makeInkPhoto(join(workDir, "celebration.jpg"), [["JORDAN P", 360, 450, 56]]);
  await go(guest.page, "claim/" + state.claimId, "[data-lf-view=claim][data-lf-claim-status=confirmed]");
  await guest.page.getByText("Back home! You earned +10 karma.").waitFor();
  await guest.page.getByRole("link", { name: "Post a celebration" }).click();
  const celebrate = guest.page.locator("form[aria-label='Post a celebration']");
  await celebrate.waitFor();
  await celebrate.getByLabel("Choose disc photos").setInputFiles(celebrationInk.file);
  await celebrate.locator(".market-photo-thumb").first().waitFor();
  await celebrate.getByLabel("Caption").fill("Back in Jordan's bag where it belongs!");
  geminiQueue.push(celebrationInk.reply);
  await celebrate.getByRole("button", { name: "Post celebration" }).click();
  await guest.page.waitForURL(/#returned$/);
  const wall = guest.page.locator("[data-lf-view=returned][data-lf-state=ready]");
  await wall.waitFor();
  const card = wall.locator("[data-lf-celebration]").first();
  await card.getByText("Back in Jordan's bag where it belongs!").waitFor();
  await card.locator("img").waitFor();
  await wall.locator("[data-lf-top-finders]").getByText("Karma 10 · 1 disc returned").waitFor();
  assert.deepEqual({ ...db.raw.prepare("SELECT status, nudge FROM lf_photos WHERE celebration_id IS NOT NULL").get() }, { status: "public", nudge: "shown" });
  await go(guest.page, "mine", "[data-lf-view=mine][data-lf-state=ready] [data-lf-nudges]");
  const celebrationNudge = guest.page.locator("[data-lf-nudge]").filter({ hasText: "Your celebration of the" });
  await celebrationNudge.getByText(NUDGE).waitFor();
  await shot(guest.page, "flow-mine-nudge-390-light");
  await celebrationNudge.getByRole("button", { name: "Keep it" }).click();
  await guest.page.locator("[data-lf-nudges]").waitFor({ state: "detached" });
  assert.equal(db.raw.prepare("SELECT nudge FROM lf_photos WHERE celebration_id IS NOT NULL").get().nudge, "kept");
  console.log("celebration on the Returned wall with Top finders; its nudge was kept from My posts");

  // 8. Member Home card and the public homepage strip.
  const home = await open(P, { member: tokens.other });
  await home.page.goto(origin + "/gvdg-members.html", { waitUntil: "domcontentloaded" });
  const homeCard = home.page.locator("[data-member-returned]");
  await homeCard.waitFor();
  await homeCard.getByText("Gail Finder returned an Innova Star Destroyer").waitFor();
  await homeCard.locator("img").waitFor();
  console.log("member Home shows the Recently returned card");
  const site = await open(P);
  const stripRequests = [];
  site.page.on("request", (request) => { if (request.url().includes("/lost-found/returned")) stripRequests.push(request.url()); });
  await site.page.goto(origin + "/index.html", { waitUntil: "domcontentloaded" });
  await site.page.waitForTimeout(800);
  assert.equal(stripRequests.length, 0, "the homepage strip waits until it is scrolled near");
  await site.page.locator("#homeReactReturnedApp").scrollIntoViewIfNeeded();
  const strip = site.page.locator("#returned-discs[data-home-returned-strip]");
  await strip.waitFor();
  await strip.getByText("Back in Jordan's bag where it belongs!").waitFor();
  assert.equal(stripRequests.length, 1);
  console.log("homepage strip loads lazily and shows the return");

  // 9. Another member reports the celebration -> admin Lost & Found queue (and Needs you).
  const other = await open(P, { member: tokens.other });
  await go(other.page, "returned", "[data-lf-view=returned][data-lf-state=ready]");
  const reported = other.page.locator("[data-lf-celebration]").first();
  await reported.getByRole("button", { name: "Report" }).click();
  await reported.getByLabel("Why are you reporting this?").selectOption("privacy");
  await reported.getByLabel("Anything else (optional)").fill("Please check the photo before it stays up.");
  await reported.getByRole("button", { name: "Send report" }).click();
  await other.page.getByText("Thanks. A club admin will take a look.").waitFor();
  const admin = await open(P, { member: tokens.admin });
  await admin.page.goto(origin + "/admin.html#lost-found", { waitUntil: "domcontentloaded" });
  const report = admin.page.locator("li[data-admin-lf-report]").first();
  await report.getByText("Celebration · Gail Finder (guest)").waitFor();
  await report.getByText("Shows private information · reported by Riley Chen").waitFor();
  await report.locator("img[data-admin-lf-photo]").waitFor();
  await report.getByRole("button", { name: "Remove photo" }).waitFor();
  assert.deepEqual(await api("/admin/lost-found/summary", { token: tokens.admin }), { openReports: 1 });
  console.log("report reached the admin Lost & Found queue with the photo and Remove photo");

  // Seed more data for the screenshots: open found posts (one with the AI down: its photo is up anyway), more lost
  // posts, a nudge on Taylor's post, and a possible match for the admin review list.
  const clean = await makeInkPhoto(join(workDir, "clean-disc.jpg"), []);
  const cleanPhoto = "data:image/jpeg;base64," + (await readFile(clean.file)).toString("base64");
  env.GEMINI_API_KEY = "";
  state.waiting = (await api("/lost-found/posts", { method: "POST", token: tokens.finder2, body: {
    kind: "found", color: "Pink", courseId: 2, area: "Basket 12 creek", photos: [cleanPhoto],
  } })).post;
  env.GEMINI_API_KEY = "gk_qa";
  const taylorInk = await makeInkPhoto(join(workDir, "taylor.jpg"), [["T MORGAN", 330, 450, 54], ["252 555 0123", 330, 515, 46]]);
  geminiQueue.push(taylorInk.reply);
  state.nudged = (await api("/lost-found/posts", { method: "POST", token: tokens.finder2, body: {
    kind: "found", brand: "Discmania", mold: "PD", plastic: "S-Line", color: "Red", courseId: 1, area: "Hole 2",
    photos: ["data:image/jpeg;base64," + (await readFile(taylorInk.file)).toString("base64")] } })).post;
  for (const [brand, mold, plastic, color, area, courseId] of [["Discraft", "Buzzz", "ESP", "Blue", "Hole 3 left rough", 5], ["MVP", "Volt", "Neutron", "Purple", "Parking lot", 1]]) {
    await api("/lost-found/posts", { method: "POST", token: tokens.finder2, body: {
      kind: "found", brand, mold, plastic, color, courseId, area, holding: brand === "MVP" ? "club_bin" : "finder", binNote: brand === "MVP" ? "ECU North Rec shed" : "",
      photos: [cleanPhoto],
    } });
  }
  await api("/lost-found/posts", { method: "POST", token: tokens.other, body: { kind: "lost", brand: "Axiom", mold: "Envy", plastic: "Proton", color: "Teal", courseId: 2, area: "Hole 15 ravine",
    rewardNote: "$10", privateInk: "RC 252 555 0144" } });
  await api("/lost-found/posts", { method: "POST", token: tokens.other, body: { kind: "lost", brand: "Discraft", mold: "Buzzz", color: "Blue", courseId: 5, privateInk: "Riley" } });
  assert.equal((await api("/lost-found/posts/" + state.waiting.id)).post.photos.length, 1, "the AI-down post shows its photo anyway");
  // A possible (undecided) match for the "Is this yours?" screens: Riley's lost Buzzz vs Taylor's found Buzzz.
  const possible = db.raw.prepare("SELECT id, status FROM lf_matches WHERE candidate_id = ? ORDER BY id DESC LIMIT 1").get(people.other.memberId);
  assert(possible, "the lost Buzzz got a possible match");
  state.possibleMatchId = possible.id;
  await guest.context.close();
  for (const view of [owner, home, site, other, admin]) await view.context.close();
}

async function runBuiltCheck() {
  // The built bundle (as deployed) lazy-loads the Lost & Found chunk; the Pro Shop never does.
  const built = await open(profiles.light390);
  const scripts = [];
  built.page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });
  await built.page.goto(origin + "/pro-shop-built.html", { waitUntil: "domcontentloaded" });
  await built.page.locator("[data-react-pro-shop]").waitFor();
  assert.equal(scripts.some((path) => path.includes("/chunks/lf-app-")), false, "the Pro Shop does not load the Lost & Found chunk");
  await built.page.goto(origin + "/lost-found-built.html", { waitUntil: "domcontentloaded" });
  await built.page.locator("[data-react-lost-found=ready] article.lf-card").first().waitFor();
  assert.equal(scripts.some((path) => /^\/public-app\/chunks\/lf-app-[\w-]+\.js$/.test(path)), true, "the Lost & Found chunk loads on demand");
  await built.context.close();
  console.log("built bundle lazy-loads the Lost & Found chunk");
}

const lfScreens = [
  ["found-list", () => ({}), "found", "[data-lf-view=found][data-lf-state=ready] article.lf-card"],
  ["lost-list", () => ({}), "lost", "[data-lf-view=lost][data-lf-state=ready] article.lf-card"],
  ["found-detail", () => ({}), () => "post/" + state.foundId, "[data-lf-view=post][data-lf-state=ready] [data-lf-gallery='1'] img"],
  ["post-nudge", () => ({ member: tokens.finder2 }), () => "post/" + state.nudged.id, "[data-lf-view=post][data-lf-state=ready] [data-lf-nudge]"],
  ["post-form", () => ({ member: tokens.other }), "new/found", "form[aria-label='Post a found disc'] [data-lf-photo-tip]"],
  ["lost-form", () => ({ member: tokens.other }), "new/lost", "form[aria-label='Post a lost disc'] [data-lf-photo-tip]"],
  ["celebrate-form", () => ({ member: tokens.owner }), () => "celebrate/" + state.claimId, "form[aria-label='Post a celebration'] [data-lf-photo-tip]"],
  ["is-this-yours", () => ({ member: tokens.other }), () => "match/" + state.possibleMatchId, ".lf-match .lf-decide"],
  ["my-posts", () => ({ guest: state.guest }), "mine", "[data-lf-view=mine][data-lf-state=ready]"],
  ["my-posts-nudge", () => ({ member: tokens.finder2 }), "mine", "[data-lf-view=mine][data-lf-state=ready] [data-lf-nudge]"],
  ["returned-wall", () => ({}), "returned", "[data-lf-view=returned][data-lf-state=ready] [data-lf-top-finders]"],
  ["claim-confirmed", () => ({ guest: state.guest }), () => "claim/" + state.claimId, "[data-lf-view=claim][data-lf-state=ready]"],
];
const otherScreens = [
  ["home-card", () => ({ member: tokens.other }), "/gvdg-members.html", "[data-member-returned]"],
  ["homepage-strip", () => ({}), "/index.html", "#returned-discs[data-home-returned-strip]"],
  ["admin-queue", () => ({ member: tokens.admin }), "/admin.html#lost-found", "li[data-admin-lf-report]"],
  ["member-lost-found", () => ({ member: tokens.owner }), "/gvdg-members.html#lost-found", "[data-member-lost-found=ready]"],
];

async function runScreens() {
  for (const profile of [profiles.light390, profiles.dark390, profiles.dark320, profiles.light1280]) {
    for (const [name, who, hash, ready] of lfScreens) {
      const view = await open(profile, who());
      await go(view.page, typeof hash === "function" ? hash() : hash, ready);
      await view.page.waitForLoadState("networkidle").catch(() => {});
      await assertFits(view.page, profile.name + " " + name);
      await shot(view.page, name + "-" + profile.name);
      await view.context.close();
    }
    for (const [name, who, path, ready] of otherScreens) {
      const view = await open(profile, who());
      await view.page.goto(origin + path, { waitUntil: "domcontentloaded" });
      if (name === "homepage-strip") await view.page.locator("#homeReactReturnedApp").scrollIntoViewIfNeeded();
      const target = view.page.locator(ready).first();
      await target.waitFor();
      await view.page.waitForLoadState("networkidle").catch(() => {});
      await assertFits(view.page, profile.name + " " + name);
      if (name === "home-card" || name === "homepage-strip") {
        await target.scrollIntoViewIfNeeded();
        await target.screenshot({ path: join(shotsDir, name + "-" + profile.name + ".png"), animations: "disabled" });
      } else {
        await shot(view.page, name + "-" + profile.name);
      }
      await view.context.close();
    }
    console.log(profile.name + ": " + (lfScreens.length + otherScreens.length) + " Lost & Found screens fit");
  }
}

// Glass theme: Lost & Found cards and panels turn to glass when a member's theme has it on, and stay solid off.
async function runGlass() {
  const wallpaper = "data:image/jpeg;base64," + (await readFile("img/slide5.jpg")).toString("base64");
  for (const mode of ["dark", "light"]) {
    for (const glass of ["off", "frosted"]) {
      const theme = buildTheme({ mode, preset: "Frost", wallpaper, glass: GLASS_PRESETS[glass] });
      glassTheme = theme;
      const profile = { ...profiles[mode === "dark" ? "dark390" : "light390"], name: "390-" + mode + "-glass-" + glass };
      for (const [name, hash, ready, selector] of [
        ["found-list", "found", "article.lf-card", "article.lf-card"],
        ["returned-wall", "returned", "[data-lf-top-finders]", ".lf-top"],
      ]) {
        const view = await open(profile, { member: tokens.owner, theme });
        await go(view.page, hash, ready);
        await view.page.waitForFunction(() => document.body.classList.contains("player-theme-active"));
        const look = await view.page.evaluate((selector) => {
          const card = document.querySelector(selector);
          const style = getComputedStyle(card);
          const bg = style.backgroundColor;
          const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(bg)?.[1];
          const comma = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(bg)?.[1];
          const raw = slash ?? comma;
          const alpha = raw == null ? 1 : raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
          return { glassClass: document.body.classList.contains("player-theme-glass"), blur: style.backdropFilter || style.webkitBackdropFilter || "", alpha, bg };
        }, selector);
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
  console.log("glass theme: Lost & Found cards turn to glass when on and stay solid when off");
}

// ---------------------------------------------------------------------------------------------------
// In-app camera: Take photo opens a full-screen viewfinder; shots go through the same resize and upload as picked
// photos. Driven with Chromium's simulated camera; init scripts stand in for a blocked camera, a computer with no
// camera and a phone browser without the in-app camera.
// ---------------------------------------------------------------------------------------------------

const CAMERA_SPY = () => {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) return;
  const real = media.getUserMedia.bind(media);
  window.__gvStreams = [];
  media.getUserMedia = async (constraints) => {
    window.__gvConstraints = constraints;
    const stream = await real(constraints);
    window.__gvStreams.push(stream);
    return stream;
  };
};
const CAMERA_BLOCKED = () => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
};
const NO_CAMERA = () => {
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "", groupId: "", label: "" }];
};
const NO_LIVE_CAMERA = () => {
  Object.defineProperty(MediaDevices.prototype, "getUserMedia", { configurable: true, value: undefined });
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: undefined });
};

async function cameraView(profile, who, scripts = [CAMERA_SPY]) {
  const view = await open(profile, who);
  for (const script of scripts) await view.context.addInitScript(script);
  return view;
}

async function cameraTracks(page) {
  return page.evaluate(() => (window.__gvStreams || []).flatMap((stream) => stream.getTracks()).map((track) => track.kind + ":" + track.readyState));
}

async function snapShots(sheet, count) {
  const shutter = sheet.getByRole("button", { name: "Take photo", exact: true });
  for (let index = 0; index < count; index++) {
    await shutter.click();
    await sheet.locator(".gv-camera-shot").nth(index).waitFor();
  }
}

async function runCamera() {
  const P = profiles.light390;

  // 1. A lost post with two photos from the in-app camera, end to end: viewfinder, two shots, Done, posted, stored.
  const member = await cameraView(P, { member: tokens.finder2 });
  await go(member.page, "new/lost", "form[aria-label='Post a lost disc']");
  const form = member.page.locator("form[aria-label='Post a lost disc']");
  await form.locator(".photo-add-row[data-photo-camera=live]").waitFor();
  assert.equal((await form.locator(".market-photo-add").innerText()).trim(), "Choose photos", "the picker reads Choose photos next to Take photo");
  await assertFits(member.page, "lost form with Take photo");
  await shot(member.page, "camera-lost-form-390-light");
  await form.getByRole("button", { name: "Take photo" }).click();
  const sheet = member.page.locator(".gv-camera[data-gv-camera=ready]");
  await sheet.waitFor();
  assert.equal(await sheet.getAttribute("aria-modal"), "true");
  await sheet.getByText("Your disc, or one just like it.").waitFor();
  assert.equal((await sheet.locator(".gv-camera-count").innerText()).trim(), "0 of 2");
  assert.equal(await sheet.getByRole("button", { name: "Done" }).isDisabled(), true, "Done waits for a shot");
  assert.equal(await member.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Take photo", "the shutter has focus");
  const asked = await member.page.evaluate(() => window.__gvConstraints);
  assert.equal(asked.audio, false, "the camera never asks for the microphone");
  assert.equal(asked.video.facingMode.ideal, "environment", "the back camera first");
  await assertFits(member.page, "camera ready 390");
  await member.page.screenshot({ path: join(shotsDir, "camera-ready-390-light.png"), animations: "disabled" });
  await snapShots(sheet, 2);
  assert.equal((await sheet.locator(".gv-camera-count").innerText()).trim(), "2 of 2");
  assert.equal(await sheet.getByRole("button", { name: /^Take photo \(that's the most/ }).isDisabled(), true, "the shutter stops at the post's limit");
  await assertFits(member.page, "camera with two shots 390");
  await member.page.screenshot({ path: join(shotsDir, "camera-two-shots-390-light.png"), animations: "disabled" });
  await sheet.getByRole("button", { name: "Use 2 photos" }).click();
  await member.page.locator(".gv-camera").waitFor({ state: "detached" });
  await form.locator(".market-photo-thumb").nth(1).waitFor();
  assert.equal(await form.getByRole("button", { name: "Take photo" }).count(), 0, "no Take photo once the post is full");
  assert.equal(await member.page.evaluate(() => document.documentElement.style.overflow), "", "the page scrolls again");
  const tracks = await cameraTracks(member.page);
  assert(tracks.length > 0 && tracks.every((track) => track === "video:ended"), "the camera is off after Done (" + tracks.join(", ") + ")");
  await form.getByLabel("Mold", { exact: true }).fill("Firebird");
  await form.getByLabel("Colour", { exact: true }).selectOption("Red");
  await form.getByRole("button", { name: "Post lost disc" }).click();
  await member.page.waitForURL(/#post\/\d+$/);
  const cameraPostId = Number(/post\/(\d+)$/.exec(member.page.url())[1]);
  await member.page.locator("[data-lf-view=post][data-lf-state=ready] [data-lf-gallery='2']").waitFor();
  const stored = db.raw.prepare("SELECT photo_key FROM lf_photos WHERE post_id = ? AND status = 'public' ORDER BY id").all(cameraPostId);
  assert.equal(stored.length, 2, "both camera photos were stored");
  for (const row of stored) {
    const bytes = photos.objects.get(row.photo_key)?.bytes;
    assert(bytes && bytes[0] === 0xff && bytes[1] === 0xd8, "a stored camera photo is a JPEG");
  }
  await member.context.close();
  console.log("in-app camera: two shots on a lost post, posted and stored as JPEGs; the camera turns off after Done");

  // 2. Close and Escape: nothing taken closes at once; a shot asks first; the camera is off afterwards; focus returns.
  const closer = await cameraView(P, { member: tokens.other });
  await go(closer.page, "new/found", "form[aria-label='Post a found disc']");
  const found = closer.page.locator("form[aria-label='Post a found disc']");
  const take = found.getByRole("button", { name: "Take photo" });
  await take.click();
  const closeSheet = closer.page.locator(".gv-camera[data-gv-camera=ready]");
  await closeSheet.getByText("The top of the disc, then the bottom. Cover any name or phone number.").waitFor();
  await closer.page.keyboard.press("Escape");
  await closer.page.locator(".gv-camera").waitFor({ state: "detached" });
  assert.equal(await closer.page.evaluate(() => document.activeElement?.textContent), "Take photo", "focus goes back to Take photo");
  // The phone's Back button closes the camera and keeps the form and what's typed; with a shot taken it asks first.
  await found.getByLabel("Where exactly (optional)", { exact: true }).fill("Hole 9 creek");
  const formUrl = closer.page.url();
  await take.click();
  await closeSheet.waitFor();
  await closer.page.evaluate(() => history.back());
  await closer.page.locator(".gv-camera").waitFor({ state: "detached" });
  assert.equal(closer.page.url(), formUrl, "Back closed the camera, not the form");
  assert.equal(await found.getByLabel("Where exactly (optional)", { exact: true }).inputValue(), "Hole 9 creek", "what was typed is still there");
  await take.click();
  await closeSheet.waitFor();
  await snapShots(closeSheet, 1);
  await closer.page.evaluate(() => history.back());
  await closer.page.locator(".gv-camera [role=alertdialog]").getByText("Discard this photo?").waitFor();
  await closer.page.locator(".gv-camera [role=alertdialog]").getByRole("button", { name: "Keep shooting" }).click();
  assert.equal(await closeSheet.locator(".gv-camera-shot").count(), 1, "Back with a shot asks and keeps it");
  await closeSheet.getByRole("button", { name: "Use 1 photo" }).click();
  await found.locator(".market-photo-thumb").first().waitFor();
  await closer.page.waitForTimeout(300);
  assert.equal(closer.page.url(), formUrl, "Done leaves the form where it was");
  await found.getByRole("button", { name: "Remove photo 1" }).click();
  await found.getByLabel("Where exactly (optional)", { exact: true }).fill("");
  await take.click();
  await closeSheet.waitFor();
  await snapShots(closeSheet, 1);
  await closeSheet.getByRole("button", { name: "Close camera" }).click();
  const ask = closer.page.locator(".gv-camera [role=alertdialog]");
  await ask.getByText("Discard this photo?").waitFor();
  await closer.page.screenshot({ path: join(shotsDir, "camera-discard-390-light.png"), animations: "disabled" });
  await ask.getByRole("button", { name: "Keep shooting" }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(await closeSheet.locator(".gv-camera-shot").count(), 1, "Keep shooting keeps the shot");
  await closer.page.keyboard.press("Escape");
  await ask.getByRole("button", { name: "Discard" }).click();
  await closer.page.locator(".gv-camera").waitFor({ state: "detached" });
  assert.equal(await found.locator(".market-photo-thumb").count(), 0, "discarded shots don't reach the form");
  assert((await cameraTracks(closer.page)).every((track) => track === "video:ended"), "the camera is off after closing");

  // 3. Retake from the "may show a name or phone number" nudge: a found disc posted from the camera, read as inked,
  // then retaken in place.
  await take.click();
  await closeSheet.waitFor();
  await snapShots(closeSheet, 1);
  await closeSheet.getByRole("button", { name: "Use 1 photo" }).click();
  await found.locator(".market-photo-thumb").first().waitFor();
  geminiQueue.push((await makeInkPhoto(join(workDir, "camera-ink.jpg"), [["RILEY 252-555-0144", 300, 520, 40]])).reply);
  await found.getByRole("button", { name: "Post found disc" }).click();
  await closer.page.waitForURL(/#post\/\d+$/);
  const nudgedId = Number(/post\/(\d+)$/.exec(closer.page.url())[1]);
  const nudge = closer.page.locator("[data-lf-nudges] [data-lf-nudge]");
  await nudge.getByRole("button", { name: "Retake photo" }).waitFor();
  await nudge.getByRole("button", { name: "Replace photo" }).waitFor();
  await assertFits(closer.page, "nudge with Retake photo");
  await shot(closer.page, "camera-nudge-retake-390-light");
  const before = db.raw.prepare("SELECT id FROM lf_photos WHERE post_id = ? AND status = 'public'").get(nudgedId);
  await nudge.getByRole("button", { name: "Retake photo" }).click();
  const retake = closer.page.locator(".gv-camera[data-gv-camera=ready]");
  await retake.getByText("Cover the name or phone number with a thumb or a strip of tape.").waitFor();
  assert.equal((await retake.locator(".gv-camera-count").innerText()).trim(), "0 of 1");
  await snapShots(retake, 1);
  await retake.getByRole("button", { name: "Use 1 photo" }).click();
  await closer.page.locator("[data-lf-nudges]").waitFor({ state: "detached" });
  const after = db.raw.prepare("SELECT id FROM lf_photos WHERE post_id = ? AND status = 'public'").get(nudgedId);
  assert.notEqual(after.id, before.id, "Retake photo replaced the photo");
  await closer.context.close();
  console.log("in-app camera: Escape / Close ask before dropping shots; Retake photo replaces a nudged photo");

  // 4. Camera blocked on a phone: say so, then hand off to the phone's camera app or the photo picker.
  const blocked = await cameraView(P, { member: tokens.other }, [CAMERA_BLOCKED]);
  await go(blocked.page, "new/found", "form[aria-label='Post a found disc']");
  const blockedForm = blocked.page.locator("form[aria-label='Post a found disc']");
  await blockedForm.getByRole("button", { name: "Take photo" }).click();
  const blockedSheet = blocked.page.locator(".gv-camera[data-gv-camera=error]");
  await blockedSheet.locator("[data-gv-camera-error=blocked]").getByText("Camera access is off for this site.", { exact: false }).waitFor();
  await assertFits(blocked.page, "camera blocked 390");
  await blocked.page.screenshot({ path: join(shotsDir, "camera-blocked-390-light.png"), animations: "disabled" });
  const sample = await makeInkPhoto(join(workDir, "camera-fallback.jpg"), []);
  let chooser = blocked.page.waitForEvent("filechooser");
  await blockedSheet.getByRole("button", { name: "Use the camera app" }).click();
  let picker = await chooser;
  assert.equal(await picker.element().getAttribute("capture"), "environment", "the hand-off opens the phone's camera");
  await picker.setFiles(sample.file);
  await blockedForm.locator(".market-photo-thumb").first().waitFor();
  await blockedForm.getByRole("button", { name: "Take photo" }).click();
  chooser = blocked.page.waitForEvent("filechooser");
  await blocked.page.locator(".gv-camera[data-gv-camera=error]").getByRole("button", { name: "Choose photos instead" }).click();
  picker = await chooser;
  assert.equal(picker.isMultiple(), true, "Choose photos instead opens the regular picker");
  await picker.setFiles(sample.file);
  await blockedForm.locator(".market-photo-thumb").nth(1).waitFor();
  assert.equal(await blocked.page.locator("input[data-gv-photo-input]").count(), 0, "the hand-off input is gone afterwards");
  await blocked.context.close();

  // 5. A phone browser without the in-app camera: Take photo goes straight to the phone's camera app.
  const legacy = await cameraView(P, { member: tokens.other }, [NO_LIVE_CAMERA]);
  await go(legacy.page, "new/found", "form[aria-label='Post a found disc']");
  const legacyForm = legacy.page.locator("form[aria-label='Post a found disc']");
  await legacyForm.locator(".photo-add-row[data-photo-camera=app]").waitFor();
  chooser = legacy.page.waitForEvent("filechooser");
  await legacyForm.getByRole("button", { name: "Take photo" }).click();
  picker = await chooser;
  assert.equal(await picker.element().getAttribute("capture"), "environment");
  await picker.setFiles(sample.file);
  await legacyForm.locator(".market-photo-thumb").first().waitFor();
  await legacy.context.close();

  // 6. A computer with no camera sees the picker exactly as before; one with a camera gets Take photo too.
  const desk = await cameraView(profiles.light1280, { member: tokens.other }, [NO_CAMERA]);
  await go(desk.page, "new/found", "form[aria-label='Post a found disc']");
  const deskForm = desk.page.locator("form[aria-label='Post a found disc']");
  await deskForm.locator(".photo-add-row[data-photo-camera=none]").waitFor();
  assert.equal(await deskForm.getByRole("button", { name: "Take photo" }).count(), 0);
  assert.equal((await deskForm.locator(".market-photo-add").innerText()).trim(), "Add photos", "no camera: the old wording");
  await desk.context.close();
  console.log("in-app camera: blocked -> camera app or picker; no in-app camera -> camera app; no camera -> picker as before");

  // 7. The Pro Shop sell form gets the same camera.
  const seller = await cameraView(P, { member: tokens.finder2 });
  await seller.page.goto(origin + "/pro-shop.html#market/sell", { waitUntil: "domcontentloaded" });
  const sell = seller.page.locator("form[aria-label='Sell a disc']");
  await sell.getByRole("button", { name: "Take photo" }).click();
  const sellSheet = seller.page.locator(".gv-camera[data-gv-camera=ready]");
  await sellSheet.getByText("The top, the bottom and any ink or rim dents.").waitFor();
  assert.equal((await sellSheet.locator(".gv-camera-count").innerText()).trim(), "0 of 4");
  await snapShots(sellSheet, 2);
  await sellSheet.getByRole("button", { name: "Use 2 photos" }).click();
  await sell.locator(".market-photo-thumb").nth(1).waitFor();
  await assertFits(seller.page, "sell form after camera");
  await shot(seller.page, "camera-sell-form-390-light");
  await seller.context.close();

  // 8. The viewfinder at the other sizes: dark, 320 px with large text, desktop.
  for (const profile of [profiles.dark390, profiles.dark320, profiles.light1280]) {
    const view = await cameraView(profile, { member: tokens.other });
    await go(view.page, "new/found", "form[aria-label='Post a found disc']");
    await view.page.locator("form[aria-label='Post a found disc']").getByRole("button", { name: "Take photo" }).click();
    const sized = view.page.locator(".gv-camera[data-gv-camera=ready]");
    await sized.waitFor();
    await snapShots(sized, 2);
    const box = await sized.boundingBox();
    assert(box && Math.abs(box.width - profile.width) <= 1 && Math.abs(box.height - profile.height) <= 1, profile.name + " the camera fills the screen");
    const bar = await view.page.evaluate(() => [...document.querySelectorAll(".gv-camera-bar > *")].map((node) => { const r = node.getBoundingClientRect(); return [r.left, r.right]; }));
    assert(bar.every(([left, right], index) => left >= 0 && right <= profile.width && (index === 0 || left >= bar[index - 1][1])), profile.name + " the camera controls don't overlap");
    const fit = await view.page.evaluate(() => {
      const stage = document.querySelector(".gv-camera-stage").getBoundingClientRect();
      const video = document.querySelector(".gv-camera-video");
      const box = video.getBoundingClientRect();
      // The picture drawn with object-fit: contain, inside the video box.
      const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
      return { stage: [stage.top, stage.bottom, stage.left, stage.right], box: [box.top, box.bottom, box.left, box.right],
        picture: [video.videoWidth * scale, video.videoHeight * scale] };
    });
    assert(fit.box[0] >= fit.stage[0] - 1 && fit.box[1] <= fit.stage[1] + 1 && fit.box[2] >= fit.stage[2] - 1 && fit.box[3] <= fit.stage[3] + 1,
      profile.name + " the preview stays inside its area (" + JSON.stringify(fit) + ")");
    await assertFits(view.page, profile.name + " camera");
    await view.page.screenshot({ path: join(shotsDir, "camera-two-shots-" + profile.name + ".png"), animations: "disabled" });
    await view.context.close();
  }
  console.log("in-app camera: Pro Shop sell form; viewfinder fits at 390 dark, 320 large text and 1280");
}

// ---------------------------------------------------------------------------------------------------
// One-thumb disc details: pick-lists (brand -> its plastics, colour, weight, the course's holes), "Other…" for
// anything unlisted, the scoring app's "Found a disc" prefill and way back, and "Say it" (a real recording from
// Chromium's simulated microphone -> the real Worker route -> mocked Whisper on OpenRouter -> the pick-lists).
// ---------------------------------------------------------------------------------------------------

/** The course search: type, then tap the course in the results. */
async function pickCourse(form, query, name) {
  const picker = form.locator("[data-course-picker]");
  if (await picker.getAttribute("data-course-picker") === "chosen") await picker.getByRole("button", { name: "Change course" }).click();
  await form.getByLabel("Course", { exact: true }).fill(query);
  await form.locator(".course-results").getByRole("button", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await form.locator("[data-course-picker=chosen]").getByText(name, { exact: true }).waitFor();
}

async function selected(locator) {
  return locator.evaluate((node) => node.options[node.selectedIndex]?.textContent || "");
}

async function runPickers() {
  const P = profiles.light390;
  const course = db.raw.prepare("SELECT id, name FROM courses ORDER BY id LIMIT 1").get();
  db.raw.prepare("INSERT INTO course_layouts (course_id, name, holes) VALUES (?, 'QA 21', ?)")
    .run(course.id, JSON.stringify(Array.from({ length: 21 }, (_, index) => ({ hole: index + 1, par: 3 }))));

  // 1. From the scoring app: course and hole are filled in; "Back to your round" stays through posting.
  const view = await cameraView(P, { member: tokens.other });
  await go(view.page, `new/found?course=${course.id}&hole=7&from=score&return=${encodeURIComponent("score.html?round=QA77")}`, "form[aria-label='Post a found disc']");
  const form = view.page.locator("form[aria-label='Post a found disc']");
  const back = view.page.locator("[data-lf-round-return]");
  assert.equal(await back.getAttribute("href"), "score.html?round=QA77");
  await form.locator("[data-course-picker=chosen]").getByText(course.name, { exact: true }).waitFor();
  const hole = form.getByLabel("Hole found on", { exact: true });
  await view.page.waitForFunction(() => document.querySelectorAll("#lfHole option").length === 1 + 21 + 1);
  assert.equal(await hole.inputValue(), "7", "the hole from the round is chosen");
  assert.equal(await selected(hole), "Hole 7");

  // 2. Brand narrows the plastics; Other… opens a text box; changing brand drops a plastic that no longer fits.
  const brand = form.getByLabel("Brand", { exact: true });
  const plastic = form.getByLabel("Plastic", { exact: true });
  await brand.selectOption("Discraft");
  const discraft = await plastic.locator("option").allTextContents();
  assert(discraft.includes("ESP") && !discraft.includes("Star"), "Discraft lists its own plastics");
  await plastic.selectOption("ESP");
  await brand.selectOption("Innova");
  assert.equal(await plastic.inputValue(), "", "ESP isn't an Innova plastic");
  await plastic.selectOption("Champion");
  await brand.selectOption("__other__");
  await form.getByLabel("Brand (not listed)").fill("Yikun");
  assert.equal(await brand.inputValue(), "__other__");
  assert.equal(await plastic.inputValue(), "Champion", "an unlisted brand keeps the plastic (every plastic is offered)");
  await form.getByLabel("Colour", { exact: true }).selectOption("Pink");
  const weights = await form.getByLabel("Weight (if you know it)", { exact: true }).locator("option").allTextContents();
  assert.deepEqual([weights[1], weights.at(-1)], ["200 g", "100 g"]);
  await assertFits(view.page, "found form pick-lists");
  await shot(view.page, "pickers-found-form-390-light");

  // 3. Say it: record, stop, Whisper hears the disc, the lists fill in (brand, its plastic, colour, weight, hole).
  env.OPENROUTER_API_KEY = "or_qa";
  env.GROQ_API_KEY = "gsk_qa";
  whisperQueue.push("Orange Star Destroyer, 175 grams, found it on hole 12.");
  const voice = form.locator("[data-disc-voice]");
  await voice.getByRole("button", { name: "Say the disc details" }).click();
  await voice.locator("[data-disc-voice=recording]").or(form.locator("[data-disc-voice=recording]")).first().waitFor();
  await view.page.waitForTimeout(1200);
  await form.getByRole("button", { name: "Stop recording" }).click();
  await form.locator(".disc-voice-heard").getByText("Heard: “Orange Star Destroyer, 175 grams, found it on hole 12.”").waitFor();
  assert.deepEqual(await Promise.all([brand, plastic, form.getByLabel("Colour", { exact: true }), form.getByLabel("Weight (if you know it)", { exact: true }), hole]
    .map((node) => node.inputValue())), ["Innova", "Star", "Orange", "175", "12"]);
  assert.equal(await form.getByLabel("Mold", { exact: true }).inputValue(), "Destroyer");
  await form.locator(".disc-voice-result").getByText("Filled in the brand, mold, plastic, colour, weight and hole. Check them below.").waitFor();
  const sent = whisperCalls.at(-1);
  assert.deepEqual([sent.provider, sent.model, sent.auth], ["groq", "whisper-large-v3-turbo", "Bearer gsk_qa"], "Groq's free Whisper goes first");
  assert.match(sent.prompt || "", /Buzzz/, "with the disc spelling hint");
  assert(sent.size > 256 && /^audio\//.test(sent.type) && sent.name.startsWith("disc."), "a real clip went to Whisper: " + JSON.stringify(sent));
  const micTracks = await cameraTracks(view.page);
  assert(micTracks.length > 0 && micTracks.every((track) => track === "audio:ended"), "voice uses only the microphone, and turns it off (" + micTracks.join(", ") + ")");
  await assertFits(view.page, "found form after voice");
  await shot(view.page, "voice-filled-found-form-390-light");

  // Nothing heard / the daily budget: a plain message, the form untouched.
  whisperQueue.push("um");
  await voice.getByRole("button", { name: "Say the disc details" }).click();
  await view.page.waitForTimeout(700);
  await form.getByRole("button", { name: "Stop recording" }).click();
  await form.locator(".disc-voice-result").getByText("Nothing matched the lists. Pick them below, or try again.").waitFor();
  assert.equal(await brand.inputValue(), "Innova");

  // Post it: weight and hole are stored and shown; the way back to the round is still there.
  await form.getByLabel("Where exactly (optional)", { exact: true }).fill("left of the basket");
  await form.getByLabel("Choose disc photos").setInputFiles((await makeInkPhoto(join(workDir, "picker-post.jpg"), [])).file);
  await form.locator(".market-photo-thumb").first().waitFor();
  await form.getByRole("button", { name: "Post found disc" }).click();
  await view.page.waitForURL(/#post\/\d+$/);
  const postId = Number(/post\/(\d+)$/.exec(view.page.url())[1]);
  const row = db.raw.prepare("SELECT brand, plastic, color, weight_g, hole, area FROM lf_posts WHERE id = ?").get(postId);
  assert.deepEqual({ ...row }, { brand: "Innova", plastic: "Star", color: "Orange", weight_g: 175, hole: 12, area: "Hole 12 · left of the basket" });
  const facts = view.page.locator("[data-lf-view=post][data-lf-state=ready] .market-facts");
  await facts.getByText("175 g").waitFor();
  await facts.getByText("Hole 12 · left of the basket").waitFor();
  assert.equal(await view.page.locator("[data-lf-round-return]").getAttribute("href"), "score.html?round=QA77");
  await view.context.close();
  console.log("pick-lists: brand -> plastics, Other…, colour, weight, the course's 21 holes; the round prefill and way back");
  console.log("voice: a recorded clip went through the Worker to Groq's Whisper (mocked) and filled brand, mold, plastic, colour, weight and hole");

  // 4. The Pro Shop sell and WANTED forms: same lists and Say it.
  whisperQueue.push("Discraft ESP Buzzz, blue, one seventy seven");
  groqStatusNext = 429; // Groq's free-plan limit: this clip falls back to OpenRouter
  const seller = await cameraView(P, { member: tokens.finder2 });
  await seller.page.goto(origin + "/pro-shop.html#market/sell", { waitUntil: "domcontentloaded" });
  const sell = seller.page.locator("form[aria-label='Sell a disc']");
  await sell.getByRole("button", { name: "Say the disc details" }).click();
  await seller.page.waitForTimeout(900);
  await sell.getByRole("button", { name: "Stop recording" }).click();
  await sell.locator(".disc-voice-heard").waitFor();
  assert.deepEqual(whisperCalls.slice(-2).map((call) => call.provider), ["groq", "openrouter"], "a Groq limit falls back to OpenRouter");
  assert.deepEqual(await Promise.all(["Brand", "Plastic", "Color", "Weight (g)", "Mold"].map((label) => sell.getByLabel(label, { exact: true }).inputValue())),
    ["Discraft", "ESP", "Blue", "177", "Buzzz"]);
  await assertFits(seller.page, "sell form after voice");
  await shot(seller.page, "voice-filled-sell-form-390-light");
  await seller.page.goto(origin + "/pro-shop.html#wanted/new", { waitUntil: "domcontentloaded" });
  const wanted = seller.page.locator("[data-market-view=wanted-new] form");
  await wanted.getByLabel("Brand", { exact: true }).selectOption("MVP");
  assert((await wanted.getByLabel("Plastic", { exact: true }).locator("option").allTextContents()).includes("Neutron"));
  await wanted.getByLabel("Min weight (g)").selectOption("170");
  await assertFits(seller.page, "wanted form pick-lists");
  await seller.context.close();
  delete env.OPENROUTER_API_KEY;
  delete env.GROQ_API_KEY;

  // 5. The pick-lists at the other sizes.
  for (const profile of [profiles.dark390, profiles.dark320, profiles.light1280]) {
    const sized = await cameraView(profile, { member: tokens.other });
    await go(sized.page, "new/lost", "form[aria-label='Post a lost disc']");
    const lost = sized.page.locator("form[aria-label='Post a lost disc']");
    await lost.getByLabel("Brand", { exact: true }).selectOption("__other__");
    await lost.getByLabel("Brand (not listed)").fill("Yikun");
    await assertFits(sized.page, profile.name + " lost form pick-lists");
    await shot(sized.page, "pickers-lost-form-" + profile.name);
    await sized.context.close();
  }
  console.log("pick-lists and Say it on the Pro Shop sell and WANTED forms; fit at 390 dark, 320 large text and 1280");
}

// ---------------------------------------------------------------------------------------------------
// Where you are: the course search, the course and hole filled in from the phone's location (read silently when
// location is already allowed; "Use my location" asks), the course and "where exactly" from voice, and "Return to
// round" pinned on every screen while you're on a live card (from the scoring app's link, or found on its own).
// ---------------------------------------------------------------------------------------------------

async function runLocation() {
  const P = profiles.light390;
  const course = db.raw.prepare("SELECT id, name FROM courses ORDER BY id LIMIT 1 OFFSET 1").get();
  // Put this course in open country (no other course within miles) with nine holes running north, 120 m apart.
  db.raw.prepare("UPDATE courses SET lat = ?, lng = ? WHERE id = ?").run(35.0, -78.0, course.id);
  const metresLat = (m) => m / 111_320;
  const nine = Array.from({ length: 9 }, (_, index) => ({ hole: index + 1, par: 3,
    tee: { lat: 35.0 + metresLat(index * 120), lng: -78.0 }, target: { lat: 35.0 + metresLat(index * 120 + 90), lng: -78.0 } }));
  db.raw.prepare("INSERT INTO course_layouts (course_id, name, holes) VALUES (?, 'QA nine', ?)").run(course.id, JSON.stringify(nine));
  const onHole5 = { latitude: 35.0 + metresLat(4 * 120 + 45), longitude: -78.0 + 20 / (111_320 * Math.cos(35 * Math.PI / 180)) };

  // 1. Location already allowed: the course and the hole you're on fill in by themselves.
  const view = await cameraView(P, { member: tokens.other });
  await view.context.grantPermissions(["geolocation"], { origin });
  await view.context.setGeolocation(onHole5);
  await go(view.page, "new/found", "form[aria-label='Post a found disc']");
  const form = view.page.locator("form[aria-label='Post a found disc']");
  await form.locator("[data-course-picker=chosen]").getByText(course.name, { exact: true }).waitFor();
  await form.getByText("Filled in from your location. Change it if that's wrong.").waitFor();
  await view.page.waitForFunction(() => document.querySelector("#lfHole")?.value === "5");
  await form.getByText("The hole closest to you.").waitFor();
  await assertFits(view.page, "found form filled from location");
  await shot(view.page, "location-filled-found-form-390-light");
  // Change: the search lists nearby courses first, with distances; typing narrows by name or town.
  await form.getByRole("button", { name: "Change course" }).click();
  const results = form.locator(".course-results");
  await results.getByRole("button").first().getByText(course.name).waitFor();
  assert.match(await results.getByRole("button").first().innerText(), /· (?:Here|0\.\d mi)$/, "the nearest course first, with its distance");
  await form.getByLabel("Course", { exact: true }).fill("ecu nor");
  await results.getByRole("button", { name: /^ECU North Rec Complex/ }).waitFor();
  await shot(view.page, "course-search-390-light");
  await results.getByRole("button", { name: /^ECU North Rec Complex/ }).click();
  assert.equal(await form.locator("#lfHole").inputValue(), "", "a different course clears the hole");
  assert.equal(await form.getByText("Filled in from your location.", { exact: false }).count(), 0, "the note goes once you change it");
  await view.context.close();

  // 2. Location not allowed yet: nothing is asked on open; "Use my location" asks, and says so when it's refused.
  const asking = await cameraView(P, { member: tokens.other });
  await go(asking.page, "new/found", "form[aria-label='Post a found disc']");
  const askForm = asking.page.locator("form[aria-label='Post a found disc']");
  await askForm.locator("[data-course-picker=search]").waitFor();
  await askForm.getByRole("button", { name: "Use my location" }).click();
  await askForm.getByText("Location is off for this site. Search by name or town instead.").waitFor();
  await asking.context.grantPermissions(["geolocation"], { origin });
  await asking.context.setGeolocation(onHole5);
  await askForm.getByRole("button", { name: "Use my location" }).click();
  await askForm.locator("[data-course-picker=chosen]").getByText(course.name, { exact: true }).waitFor();
  await asking.page.waitForFunction(() => document.querySelector("#lfHole")?.value === "5");
  await asking.context.close();
  console.log("location: the course and hole fill in when allowed; Use my location asks; search by name or town, nearest first");

  // 3. Voice names the course, the hole and where exactly.
  env.GROQ_API_KEY = "gsk_qa";
  const speaker = await cameraView(P, { member: tokens.other });
  await go(speaker.page, "new/lost", "form[aria-label='Post a lost disc']");
  const lost = speaker.page.locator("form[aria-label='Post a lost disc']");
  whisperQueue.push(`Blue ESP Buzzz, lost it on hole 3 at ${course.name}, in the woods left of the fairway.`);
  await lost.getByRole("button", { name: "Say the disc details" }).click();
  await speaker.page.waitForTimeout(900);
  await lost.getByRole("button", { name: "Stop recording" }).click();
  await lost.locator(".disc-voice-result").getByText("Filled in the brand, mold, plastic, colour, course, hole and where exactly. Check them below.").waitFor();
  await lost.locator("[data-course-picker=chosen]").getByText(course.name, { exact: true }).waitFor();
  assert.equal(await lost.locator("#lfHole").inputValue(), "3");
  assert.equal(await lost.getByLabel("Where exactly (optional)", { exact: true }).inputValue(), "In the woods left of the fairway");
  await assertFits(speaker.page, "lost form after voice with course and spot");
  await shot(speaker.page, "voice-course-spot-lost-form-390-light");
  await speaker.context.close();
  delete env.GROQ_API_KEY;
  console.log("voice: the course, hole and where exactly are filled in");

  // 4. Return to round: on a live card (this phone's recent round, checked live), pinned on every screen.
  const player = await cameraView(P, { member: tokens.other });
  await player.context.addInitScript(() => {
    localStorage.setItem("gvdg_recent_rounds", JSON.stringify([{ code: "QA9", label: "Casual round QA9", updatedAt: Date.now() - 600_000 },
      { code: "OLD1", label: "Last week", updatedAt: Date.now() - 6 * 86_400_000 }]));
  });
  await go(player.page, "found", "[data-lf-view=found][data-lf-state=ready]");
  const back = player.page.locator("[data-lf-round-return]");
  await back.waitFor();
  assert.equal(await back.getAttribute("href"), "score.html?round=QA9");
  assert.equal((await back.innerText()).trim(), "Return to round");
  const pinned = await back.evaluate((node) => { const r = node.getBoundingClientRect(); return { position: getComputedStyle(node).position, bottom: innerHeight - r.bottom, height: r.height }; });
  assert(pinned.position === "fixed" && pinned.bottom >= 8 && pinned.bottom <= 40 && pinned.height >= 48, "pinned at the bottom, thumb-sized: " + JSON.stringify(pinned));
  await go(player.page, "new/lost", "form[aria-label='Post a lost disc']");
  await back.waitFor();
  // The last control on the page isn't hidden behind the pinned button.
  await player.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const clear = await player.page.evaluate(() => {
    const submit = document.querySelector("form[aria-label='Post a lost disc'] button[type=submit]").getBoundingClientRect();
    const pin = document.querySelector("[data-lf-round-return]").getBoundingClientRect();
    return submit.bottom <= pin.top || submit.top >= pin.bottom;
  });
  assert(clear, "the post button scrolls clear of Return to round");
  await assertFits(player.page, "lost form with Return to round");
  await shot(player.page, "return-to-round-lost-form-390-light", { fullPage: false });
  await player.context.close();
  // Not on a card: no button.
  const idle = await cameraView(P, { member: tokens.other });
  await go(idle.page, "found", "[data-lf-view=found][data-lf-state=ready]");
  await idle.page.waitForLoadState("networkidle").catch(() => {});
  assert.equal(await idle.page.locator("[data-lf-round-return]").count(), 0);
  await idle.context.close();
  for (const profile of [profiles.dark320, profiles.light1280]) {
    const sized = await cameraView(profile, { member: tokens.other });
    await go(sized.page, `new/found?course=${course.id}&hole=4&from=score&return=${encodeURIComponent("score.html?round=QA9")}`, "form[aria-label='Post a found disc']");
    await sized.page.locator("[data-lf-round-return]").waitFor();
    await assertFits(sized.page, profile.name + " found form with Return to round");
    await shot(sized.page, "return-to-round-" + profile.name, { fullPage: false });
    await sized.context.close();
  }
  console.log("Return to round: pinned on every screen while on a live card (from the scoring app or found), none otherwise");

  // 5. The Found / Lost list filter uses the same search: nothing listed until you type or ask for nearby courses.
  const lister = await cameraView(P, {});
  await lister.context.grantPermissions(["geolocation"], { origin });
  await lister.context.setGeolocation(onHole5);
  const asked = [];
  lister.page.on("request", (request) => { if (request.url().includes("/lost-found/posts?")) asked.push(new URL(request.url()).searchParams.get("course")); });
  await go(lister.page, "found", "[data-lf-view=found][data-lf-state=ready]");
  const filters = lister.page.locator(".lf-filters");
  const allCards = await lister.page.locator("article.lf-card").count();
  assert(allCards > 0);
  assert.equal(await filters.locator(".course-results").count(), 0, "no course list until you search");
  await filters.getByLabel("Course", { exact: true }).fill("ecu");
  await filters.locator(".course-results").getByRole("button", { name: /^ECU North Rec Complex/ }).click();
  await filters.locator("[data-course-picker=chosen]").getByText("ECU North Rec Complex", { exact: true }).waitFor();
  const ecu = db.raw.prepare("SELECT id FROM courses WHERE name = 'ECU North Rec Complex'").get().id;
  await lister.page.waitForFunction(() => document.querySelector("[data-lf-view=found]")?.getAttribute("data-lf-state") === "ready");
  assert(asked.includes(String(ecu)), "the list reloads for that course");
  const ecuCards = await lister.page.locator("article.lf-card").count();
  assert.equal(ecuCards, db.raw.prepare("SELECT COUNT(*) AS n FROM lf_posts WHERE kind = 'found' AND course_id = ? AND status IN ('open', 'claimed') AND hidden = 0").get(ecu).n);
  await assertFits(lister.page, "found list filtered by course");
  await shot(lister.page, "list-course-filter-390-light", { fullPage: false });
  await filters.getByRole("button", { name: "All courses" }).click();
  await filters.locator("[data-course-picker=search]").waitFor();
  await lister.page.waitForFunction((n) => document.querySelectorAll("article.lf-card").length === n, allCards);
  await filters.getByRole("button", { name: "Courses near me" }).click();
  await filters.locator(".course-results").getByRole("button").first().getByText(course.name).waitFor();
  await lister.context.close();
  console.log("list filter: course search (type or near me), All courses clears it");
}

// ---------------------------------------------------------------------------------------------------
// My Bag meets Lost & Found (real Worker): "I lost this disc" opens a lost post filled in from the bag, with the
// bag's private photo shown on the post only when ticked; a found disc whose writing matches a bag disc tells its
// owner "… in your bag" (and nobody else why).
// ---------------------------------------------------------------------------------------------------

function seedBagDisc(owner, record) {
  const id = crypto.randomUUID();
  db.raw.prepare(`INSERT INTO member_practice_records (owner, id, kind, revision, occurred_on, payload, last_op, updated_at)
    VALUES (?, ?, 'disc', 1, '2026-11-01', ?, 'op-' || ?, ?)`)
    .run(owner, id, JSON.stringify({ brand: "", model: "", plastic: "", weightGrams: null, notes: "", inBag: true, archived: false, ...record }), id, Date.now());
  return id;
}

async function runBag() {
  const P = profiles.light390;
  const bagPhoto = await makeInkPhoto(join(workDir, "bag-wave.jpg"), []);
  const photoUrl = "data:image/jpeg;base64," + (await readFile(bagPhoto.file)).toString("base64");
  const discId = seedBagDisc(people.owner.memberId, { brand: "MVP", model: "Wave", plastic: "Neutron", color: "Blue", weightGrams: 171, ink: "JP 252-555-0166" });
  const photoId = (await api("/me/bag/photos", { method: "POST", token: tokens.owner, body: { discId, image: photoUrl } })).photo.id;

  // 1. I lost this disc: the form fills in from the bag; the bag photo goes on the post only once ticked.
  const view = await cameraView(P, { member: tokens.owner });
  await view.context.addInitScript(({ discId, photoId }) => {
    if (!sessionStorage.getItem("gvdg_lf_bag_handoff")) sessionStorage.setItem("gvdg_lf_bag_handoff", JSON.stringify({
      discId, brand: "MVP", mold: "Wave", plastic: "Neutron", color: "Blue", weightG: "171", ink: "JP 252-555-0166", photos: [photoId] }));
  }, { discId, photoId });
  await go(view.page, "new/lost?from=bag", "form[aria-label='Post a lost disc']");
  const form = view.page.locator("form[aria-label='Post a lost disc']");
  await form.getByText("Filled in from your bag. Add where you lost it, check the rest, and post.").waitFor();
  assert.deepEqual(await Promise.all(["Brand", "Plastic", "Colour", "Weight (if you know it)", "Mold"].map((label) => form.getByLabel(label, { exact: true }).inputValue())),
    ["MVP", "Neutron", "Blue", "171", "Wave"]);
  assert.equal(await form.getByLabel("What's written on it (private)").inputValue(), "JP 252-555-0166");
  const chooser = form.locator("[data-lf-bag-photos]");
  await chooser.locator("img").first().waitFor();
  assert.match(await chooser.locator("img").first().getAttribute("src"), /^blob:/, "the bag photo is fetched privately");
  await pickCourse(form, "ecu", "ECU North Rec Complex");
  await form.getByLabel("Hole lost on", { exact: true }).selectOption("4");
  await assertFits(view.page, "lost form from the bag");
  await shot(view.page, "bag-lost-form-390-light");
  await chooser.getByLabel("Show on the post").check();
  await form.getByRole("button", { name: "Post lost disc" }).click();
  await view.page.waitForURL(/#post\/\d+$/);
  const postId = Number(/post\/(\d+)$/.exec(view.page.url())[1]);
  await view.page.locator("[data-lf-view=post][data-lf-state=ready] [data-lf-gallery='1']").waitFor();
  assert.deepEqual({ ...db.raw.prepare("SELECT bag_disc_id, private_ink FROM lf_posts WHERE id = ?").get(postId) }, { bag_disc_id: discId, private_ink: "JP 252-555-0166" });
  assert.equal(await view.page.evaluate(() => sessionStorage.getItem("gvdg_lf_bag_handoff")), null, "the handoff is cleared once posted");
  assert.deepEqual((await api("/me/bag", { token: tokens.owner })).lost.map((row) => [row.discId, row.postId, row.status]), [[discId, postId, "open"]]);
  await view.context.close();
  console.log("My Bag: I lost this disc filled the lost post; the ticked bag photo went on it; the bag shows the post");

  // 2. A found disc with a member's bag-disc writing on it: only that member hears, and the match names their bag disc.
  const riley = seedBagDisc(people.other.memberId, { brand: "Innova", model: "Firebird", plastic: "Champion", color: "Red", ink: "RC 252-555-0177" });
  const ink = await makeInkPhoto(join(workDir, "bag-firebird.jpg"), [["252 555 0177", 300, 520, 44]]);
  geminiQueue.push(JSON.stringify({ brand: "Innova", mold: "Firebird", plastic: "Champion", colors: ["red"], stamp: "Champion Firebird",
    ink: [{ text: "252 555 0177", type: "phone" }], unreadable_writing: false, ink_confidence: "high" }));
  const finder = await cameraView(P, { member: tokens.finder2 });
  await go(finder.page, "new/found", "form[aria-label='Post a found disc']");
  const found = finder.page.locator("form[aria-label='Post a found disc']");
  await found.getByLabel("Choose disc photos").setInputFiles(ink.file);
  await found.locator(".market-photo-thumb").first().waitFor();
  await found.getByLabel("Mold", { exact: true }).fill("Firebird");
  await found.getByRole("button", { name: "Post found disc" }).click();
  await finder.page.waitForURL(/#post\/\d+$/);
  const foundId = Number(/post\/(\d+)$/.exec(finder.page.url())[1]);
  await finder.context.close();
  const match = db.raw.prepare("SELECT id, candidate_id, bag_disc_id, status FROM lf_matches WHERE found_id = ? AND bag_disc_id IS NOT NULL").get(foundId);
  assert.deepEqual([match?.candidate_id, match?.bag_disc_id, match?.status], [people.other.memberId, riley, "notified"]);
  const owner = await cameraView(P, { member: tokens.other });
  await go(owner.page, "match/" + match.id, "[data-lf-match]");
  await owner.page.locator("[data-lf-match-bag]").getByText("looks like the Red Innova Champion Firebird in your bag", { exact: false }).waitFor();
  await assertFits(owner.page, "bag match view");
  await shot(owner.page, "bag-match-390-light");
  await owner.context.close();
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM member_notices WHERE member_id = ? AND body LIKE '%in your bag%'").get(people.other.memberId).n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM member_notices WHERE member_id = ? AND body LIKE '%bag%'").get(people.finder2.memberId).n, 0);
  console.log("My Bag: a found disc with a member's bag-disc writing told only that member, naming the disc in their bag");
}

// ---------------------------------------------------------------------------------------------------
// A disc listed for sale that carries a lost owner's writing: the seller is told (privately), and the admins get it
// under Admin > Marketplace > Possible lost discs for sale, where Mark reviewed clears it.
// ---------------------------------------------------------------------------------------------------

async function runMarketLost() {
  const lost = (await api("/lost-found/posts", { method: "POST", token: tokens.owner, body: {
    kind: "lost", brand: "Discmania", mold: "PD", plastic: "S-Line", color: "Yellow", courseId: null, area: "", privateInk: "Jordan P 252-555-0199" } })).post;
  db.raw.prepare("INSERT OR REPLACE INTO market_seller_settings (member_id, notify_email) VALUES (?, ?)").run(people.finder2.memberId, "taylor@example.test");
  const photo = await makeInkPhoto(join(workDir, "listing-pd.jpg"), [["252 555 0199", 300, 520, 44]]);
  geminiQueue.push(JSON.stringify({ brand: "Discmania", mold: "PD", plastic: "S-Line", colors: ["yellow"], stamp: "PD", ink: [{ text: "252 555 0199", type: "phone" }],
    unreadable_writing: false, ink_confidence: "high" }));
  const listing = (await api("/market/listings", { method: "POST", token: tokens.finder2, body: {
    brand: "Discmania", mold: "PD", plastic: "S-Line", discType: "driver", weightG: 173, color: "Yellow", condition: 7, priceCents: 1500, quantity: 1,
    photos: ["data:image/jpeg;base64," + (await readFile(photo.file)).toString("base64")] } })).listing;
  assert.equal(db.raw.prepare("SELECT verdict FROM market_lost_checks WHERE listing_id = ? AND lost_id = ?").get(listing.id, lost.id)?.verdict, "strong");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM member_notices WHERE member_id = ? AND title = ?")
    .get(people.finder2.memberId, "A disc you listed may be someone's lost disc").n, 1);
  for (const profile of [profiles.light390, profiles.light1280]) {
    const view = await open(profile, { member: tokens.admin });
    await view.page.goto(origin + "/admin.html#marketplace", { waitUntil: "domcontentloaded" });
    const card = view.page.locator(`[data-admin-market-lost="${listing.id}-${lost.id}"]`);
    await card.waitFor();
    await card.getByText("Looks like the lost", { exact: false }).waitFor();
    assert.equal(await card.getByRole("link", { name: "Discmania S-Line PD" }).getAttribute("href"), "lost-found.html#post/" + lost.id);
    assert.equal(await card.getByRole("link", { name: "Open the listing" }).getAttribute("href"), "pro-shop.html#market/listing/" + listing.id);
    assert.doesNotMatch(await card.innerText(), /0199|Jordan P/, "the lost owner's private writing never shows");
    await assertFits(view.page, profile.name + " admin possible lost discs");
    await card.screenshot({ path: join(shotsDir, "admin-market-lost-" + profile.name + ".png") });
    if (profile === profiles.light1280) {
      await card.getByLabel("Reason (logged)").fill("Messaged the seller");
      await card.getByRole("button", { name: "Mark reviewed" }).click();
      await card.waitFor({ state: "detached" });
      await view.page.getByText("No listings look like a reported lost disc.").waitFor();
    }
    await view.context.close();
  }
  console.log("Marketplace: a listing with a lost owner's writing alerted the seller and went to the admins' review list; Mark reviewed clears it");
}

// The public menu: Lost & Found sits next to Pro Shop on every page that renders it (public pages and the
// homepage share src/shared/site-nav.js). Desktop widths keep one line; at 1024 and below the menu opens as a
// panel; phones include 320 px with large text. Nothing wraps, overflows or clips.
async function runMenu() {
  const menuShots = join(shotsDir, "menu");
  await mkdir(menuShots, { recursive: true });
  const widths = [
    { name: "1280", width: 1280, height: 800, mode: "light" },
    { name: "1100", width: 1100, height: 800, mode: "light" },
    { name: "1025", width: 1025, height: 800, mode: "dark" },
    { name: "1024-menu", width: 1024, height: 800, mode: "light", menu: true },
    { name: "768-menu", width: 768, height: 1000, mode: "dark", menu: true },
    { name: "390-menu", width: 390, height: 844, mode: "light", menu: true },
    { name: "320-large-dark-menu", width: 320, height: 760, mode: "dark", menu: true, large: true },
  ];
  for (const page of ["/index.html", "/lost-found.html", "/pro-shop.html"]) {
    for (const profile of widths) {
      const view = await open(profile);
      await view.page.goto(origin + page, { waitUntil: "domcontentloaded" });
      const nav = view.page.locator("header nav[aria-label='Main navigation']");
      await nav.waitFor();
      const link = nav.getByRole("link", { name: "Lost & Found", exact: true });
      if (profile.menu) {
        await nav.locator(".menu-toggle").click();
        await link.waitFor({ state: "visible" });
      } else {
        await link.waitFor({ state: "visible" });
      }
      await view.page.evaluate(() => document.fonts.ready);
      const layout = await view.page.evaluate(() => {
        const items = [...document.querySelectorAll("header .nav-links > li")].filter((li) => li.getBoundingClientRect().width > 0);
        const order = items.map((li) => (li.querySelector("a, button")?.textContent || "").trim());
        const wrapped = items.filter((li) => {
          const target = li.querySelector("a, button");
          if (!target) return false;
          // Text only (an icon such as the More caret sits at its own height).
          const lines = new Set();
          const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) if (rect.width > 0) lines.add(Math.round(rect.top));
          }
          return lines.size > 1;
        }).map((li) => li.textContent.trim());
        const tops = new Set(items.map((li) => Math.round(li.getBoundingClientRect().top)));
        const header = document.querySelector("header").getBoundingClientRect();
        const rightmost = Math.max(...[...document.querySelectorAll("header nav *")].map((node) => node.getBoundingClientRect().right));
        return { order, wrapped, rows: tops.size, headerHeight: Math.round(header.height), rightmost, width: innerWidth };
      });
      const label = page + " " + profile.name;
      const shop = layout.order.indexOf("Pro Shop");
      assert.equal(layout.order[shop + 1], "Lost & Found", label + ": Lost & Found sits right after Pro Shop");
      assert.deepEqual(layout.wrapped, [], label + ": no menu label wraps");
      assert(layout.rightmost <= layout.width + 1, label + ": the menu stays inside the viewport");
      if (!profile.menu) {
        assert.equal(layout.rows, 1, label + ": the desktop menu is one row");
        assert(layout.headerHeight <= 100, label + ": the header keeps its height (" + layout.headerHeight + ")");
      }
      await assertFits(view.page, label);
      const file = join(menuShots, page.slice(1).replace(".html", "") + "-" + profile.name + ".png");
      if (profile.menu) await view.page.screenshot({ path: file, animations: "disabled" });
      else await view.page.screenshot({ path: file, clip: { x: 0, y: 0, width: profile.width, height: 120 }, animations: "disabled" });
      await view.context.close();
    }
  }
  console.log("public menu: Lost & Found next to Pro Shop fits at 1280/1100/1025, in the 1024/768 menu and on phones");
}

try {
  if (process.env.GVDG_LF_MENU_ONLY) {
    await runMenu();
    assert.deepEqual(pageErrors, [], "page errors");
    console.log("Lost & Found menu QA passed; screenshots in " + join(shotsDir, "menu"));
    process.exit(0);
  }
  await runMenu();
  await runFlows();
  await runBuiltCheck();
  if (!process.env.GVDG_LF_SKIP_SCREENS) await runScreens();
  await runGlass();
  await runCamera();
  await runPickers();
  await runLocation();
  await runBag();
  await runMarketLost();
  // The background cron path works too: nothing due right now, and a tick reads nothing.
  const tick = await lfProcess.runLostFoundTick(env);
  assert.equal(tick.reads, 0);
  assert.deepEqual(pageErrors, [], "page errors");
  console.log("Lost & Found browser QA passed (" + geminiCalls + " mocked Gemini calls); screenshots in " + shotsDir);
} finally {
  await browser.close();
  await vite.close();
  globalThis.fetch = realFetch;
}
