// Browser QA for Lost & Found (lost-found.html, member Home, the homepage strip and the admin queue).
//
// The API is the REAL Worker (auth-worker/src/index.ts, loaded through Vite SSR) running in-process over an
// in-memory SQLite database with every migration applied, in-memory KV and R2, a captured Resend (the
// guest's 6-digit code is read from the captured email) and a MOCKED Gemini that "reads" the ink on a photo
// drawn in a canvas (it returns the real boxes of the words it wrote). Redaction is the real photon WASM.
//
// Flows (390 light): a guest verifies by email and posts a found disc whose photo has a name and phone
// written on it; the public photo is the server-redacted copy (the ink region visibly changes, the rest does
// not) and the original is never served; a member's lost post carries the same name and phone as PRIVATE
// text; the match notice reaches the member; "Is this yours?" -> That's mine -> relayed contact -> the finder
// marks Returned -> the owner confirms -> +10 karma; the finder posts a celebration (its photo redacted too)
// that shows on the Returned wall, the member Home card and the homepage strip; another member reports it
// and the report reaches the admin Lost & Found queue. Then the key screens are checked at 390 light /
// 390 dark / 320 large-text dark / 1280 light for horizontal overflow and clipped labels, screenshotted, and
// glass on/off is checked on the lists and the wall.
//
// Usage: CHROMIUM_PATH=/usr/bin/chromium GVDG_QA_NO_SANDBOX=1 node scripts/qa/lost-found-browser-qa.mjs
// Env: GVDG_LF_SHOTS=<dir> (default: a temp dir), GVDG_LF_PORT, GVDG_LF_SKIP_SCREENS=1 (flows + glass only).

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
let geminiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) {
    const body = JSON.parse(String(init?.body || "{}"));
    mail.push({ to: body.to?.[0], subject: body.subject, text: body.text });
    return new Response("{}", { status: 200 });
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
const WORKER_PATHS = /^\/(lost-found|admin\/lost-found|market|admin\/market|me\/messages|me\/notices)(\/|$)/;

function fixture(path, authorization) {
  if (path === "/me") {
    const sub = authorization ? tokenOwners.get(authorization.slice(7)) : null;
    const person = Object.values(people).find((row) => row.memberId === sub);
    return person ? [200, { sub: person.memberId, name: person.name, isAdmin: person.isAdmin === true, mustChangePin: false, pdgaNo: "" }] : [401, { error: "unauthorized" }];
  }
  if (path === "/me/dashboard-theme") return [200, { theme: glassTheme }];
  if (path === "/courses") return [200, { courses: db.raw.prepare("SELECT id, name, location FROM courses ORDER BY id LIMIT 30").all() }];
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
      if (url.pathname === "/proof.html") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(proofHtml);
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
        // Background work (AI read, redaction, matching, notices) finishes before the page sees the answer.
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
};
const tokens = {};
for (const [key, person] of Object.entries(people)) tokens[key] = await memberToken(person);
let proofHtml = "<p>no proof yet</p>";

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

/** A disc photo with a name and phone number written on it, plus the true boxes of that writing. */
async function makeInkPhoto(file, lines) {
  const { context, page } = await open(profiles.light390);
  await page.goto(origin + "/proof.html");
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
    const boxes = [];
    for (const [text, x, y, size] of lines) {
      g.font = `italic bold ${size}px "Comic Sans MS", cursive, sans-serif`;
      g.fillText(text, x, y);
      const m = g.measureText(text);
      boxes.push({ text, x0: x, x1: x + m.width, y0: y - m.actualBoundingBoxAscent, y1: y + m.actualBoundingBoxDescent });
    }
    return { url: canvas.toDataURL("image/jpeg", 0.9), boxes };
  }, lines);
  await context.close();
  await writeFile(file, Buffer.from(result.url.split(",")[1], "base64"));
  const ink = result.boxes.map((box) => ({
    text: box.text, type: /\d{3}/.test(box.text) ? "phone" : "name",
    // Gemini's format: [ymin, xmin, ymax, xmax] normalised to 0-1000.
    box_2d: [Math.round(box.y0 / 0.72), Math.round(box.x0 / 0.96), Math.round(box.y1 / 0.72), Math.round(box.x1 / 0.96)],
  }));
  return { file, boxes: result.boxes, reply: JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "Star Destroyer",
    ink, unreadable_writing: false, ink_confidence: "high" }) };
}

/** Mean absolute pixel difference between two images inside and outside the ink boxes (in the browser). */
async function compareRegions(originalUrl, publicUrl, boxes) {
  const { context, page } = await open(profiles.light390);
  await page.goto(origin + "/proof.html");
  const result = await page.evaluate(async ({ originalUrl, publicUrl, boxes }) => {
    const load = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
    const [a, b] = await Promise.all([load(originalUrl), load(publicUrl)]);
    const pixels = (img) => { const c = document.createElement("canvas"); c.width = 960; c.height = 720; const g = c.getContext("2d"); g.drawImage(img, 0, 0, 960, 720); return g.getImageData(0, 0, 960, 720).data; };
    const pa = pixels(a); const pb = pixels(b);
    let inside = 0; let ni = 0; let outside = 0; let no = 0;
    for (let y = 0; y < 720; y += 2) for (let x = 0; x < 960; x += 2) {
      const i = (y * 960 + x) * 4;
      const d = (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3;
      if (boxes.some((box) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1)) { inside += d; ni++; } else { outside += d; no++; }
    }
    return { inside: inside / ni, outside: outside / no };
  }, { originalUrl, publicUrl, boxes });
  await context.close();
  return result;
}

const state = {};

async function runFlows() {
  const P = profiles.light390;
  const ink = await makeInkPhoto(join(workDir, "found-disc.jpg"), [["JORDAN PARKER", 300, 440, 50], ["252-555-0187", 330, 510, 50]]);

  // 1. A member posts a lost disc with PRIVATE ink text.
  const owner = await open(P, { member: tokens.owner });
  await go(owner.page, "new/lost", "form[aria-label='Post a lost disc']");
  const lostForm = owner.page.locator("form[aria-label='Post a lost disc']");
  await lostForm.getByLabel("Brand", { exact: true }).fill("Innova");
  await lostForm.getByLabel("Mold", { exact: true }).fill("Destroyer");
  await lostForm.getByLabel("Plastic", { exact: true }).fill("Star");
  await lostForm.getByLabel("Colour", { exact: true }).fill("Orange");
  await lostForm.getByLabel("Course", { exact: true }).selectOption({ label: "ECU North Rec Complex" });
  await lostForm.getByLabel("Hole or area", { exact: true }).fill("Hole 7 by the pond");
  await lostForm.getByLabel("Reward note (optional, shown)").fill("Cold drink on me");
  await lostForm.getByLabel("What's written on it (private)").fill("Jordan Parker 252-555-0187");
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
  await form.getByLabel("Course", { exact: true }).selectOption({ label: "ECU North Rec Complex" });
  await form.getByLabel("Hole or area", { exact: true }).fill("Hole 7 drop zone");
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
  await detail.locator("[data-lf-gallery='1'] img.market-gallery-main").waitFor();
  await guest.page.getByText("Any writing on the disc is blurred in this photo.").waitFor();
  state.guest = await guest.page.evaluate(() => JSON.parse(localStorage.getItem("gvdg_market_guest")));
  assert(state.guest?.token && state.guest.name === "Gail Finder", "the shared guest token is stored");
  assert.equal(JSON.stringify(state.guest).includes("gail@"), false, "the guest's email is not kept client-side");
  console.log("guest verified by email and posted a found disc with an inked photo");

  // 3. The public photo is the redacted copy; the original is private and never served.
  const row = db.raw.prepare("SELECT id, original_key, public_key, boxes, redaction FROM lf_photos WHERE post_id = ?").get(state.foundId);
  assert.equal(row.redaction, "public");
  assert.equal(row.boxes, 2, "both pieces of ink were blurred");
  const publicBytes = Buffer.from(photos.objects.get(row.public_key).bytes);
  const originalBytes = Buffer.from(photos.objects.get(row.original_key).bytes);
  assert.equal(publicBytes.equals(originalBytes), false);
  const servedNow = await realFetch(origin + "/api/lost-found/photos/" + row.id);
  assert.equal(Buffer.from(await servedNow.arrayBuffer()).equals(publicBytes), true, "the photo URL serves the redacted copy");
  for (const path of ["/api/lost-found/photos/" + row.id + "/original", "/api/lost-found/originals/" + row.id]) {
    assert.equal((await realFetch(origin + path)).status, 404, path + " is not a way to the original");
  }
  const originalUrl = "data:image/jpeg;base64," + originalBytes.toString("base64");
  const publicUrl = "data:image/jpeg;base64," + publicBytes.toString("base64");
  const diff = await compareRegions(originalUrl, publicUrl, ink.boxes);
  assert(diff.inside > 25, "the ink region visibly changed (mean diff " + diff.inside.toFixed(1) + ")");
  assert(diff.outside < 8, "the rest of the photo is untouched (mean diff " + diff.outside.toFixed(1) + ")");
  proofHtml = `<!doctype html><meta charset="utf-8"><title>Redaction proof</title><style>
    body{margin:0;padding:24px;background:#0f0f1e;color:#f4f4f9;font:16px Archivo,system-ui,sans-serif}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{width:100%;border-radius:10px;display:block}
    figcaption{margin:10px 0 0;font-weight:700}small{display:block;font-weight:500;opacity:.8;margin-top:4px}
    h1{font-size:22px;margin:0 0 16px}</style>
    <h1>Lost &amp; Found photo privacy: what the server stores vs what anyone can see</h1>
    <div class="row"><figure><img src="${originalUrl}" alt="original"><figcaption>Original (private R2 key, never served)<small>As uploaded by the finder</small></figcaption></figure>
    <figure><img src="${publicUrl}" alt="public"><figcaption>Public copy (served at /lost-found/photos/${row.id})<small>Ink boxes from the AI, padded and mosaicked by the Worker (photon WASM). Mean pixel change: ink ${diff.inside.toFixed(0)}, rest ${diff.outside.toFixed(1)}</small></figcaption></figure></div>`;
  const proof = await open(profiles.light1280);
  await proof.page.goto(origin + "/proof.html");
  await proof.page.screenshot({ path: join(shotsDir, "proof-original-vs-public.png"), fullPage: true });
  await proof.context.close();
  console.log(`public photo is the redacted copy (ink region changed by ${diff.inside.toFixed(0)}, rest by ${diff.outside.toFixed(1)}); originals never served`);

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

  // 7. The finder celebrates (the celebration photo is redacted too) -> wall, Top finders.
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
  assert.equal(db.raw.prepare("SELECT boxes, redaction FROM lf_photos WHERE celebration_id IS NOT NULL").get().redaction, "public");
  console.log("celebration on the Returned wall with Top finders");

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
  assert.equal((await api("/admin/lost-found/summary", { token: tokens.admin })).openReports, 1);
  console.log("report reached the admin Lost & Found queue");

  // Seed more data for the screenshots: open found posts (one with the AI down, so its photo waits), more lost
  // posts, a second confirmed return, and a possible match for the admin review list.
  const clean = await makeInkPhoto(join(workDir, "clean-disc.jpg"), []);
  const cleanPhoto = "data:image/jpeg;base64," + (await readFile(clean.file)).toString("base64");
  env.GEMINI_API_KEY = "";
  state.waiting = (await api("/lost-found/posts", { method: "POST", token: tokens.finder2, body: {
    kind: "found", color: "Pink", courseId: 2, area: "Basket 12 creek", photos: [cleanPhoto],
  } })).post;
  env.GEMINI_API_KEY = "gk_qa";
  for (const [brand, mold, plastic, color, area, courseId] of [["Discraft", "Buzzz", "ESP", "Blue", "Hole 3 left rough", 5], ["MVP", "Volt", "Neutron", "Purple", "Parking lot", 1]]) {
    await api("/lost-found/posts", { method: "POST", token: tokens.finder2, body: {
      kind: "found", brand, mold, plastic, color, courseId, area, holding: brand === "MVP" ? "club_bin" : "finder", binNote: brand === "MVP" ? "ECU North Rec shed" : "",
      photos: [cleanPhoto],
    } });
  }
  await api("/lost-found/posts", { method: "POST", token: tokens.other, body: { kind: "lost", brand: "Axiom", mold: "Envy", plastic: "Proton", color: "Teal", courseId: 2, area: "Hole 15 ravine",
    rewardNote: "$10", privateInk: "RC 252 555 0144" } });
  await api("/lost-found/posts", { method: "POST", token: tokens.other, body: { kind: "lost", brand: "Discraft", mold: "Buzzz", color: "Blue", courseId: 5, privateInk: "Riley" } });
  assert.equal((await api("/lost-found/posts/" + state.waiting.id)).post.photoPending, 1, "the AI-down post shows no photo yet");
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
  ["found-detail-redacted", () => ({}), () => "post/" + state.foundId, "[data-lf-view=post][data-lf-state=ready] [data-lf-gallery='1'] img"],
  ["post-form", () => ({ member: tokens.other }), "new/found", "form[aria-label='Post a found disc']"],
  ["is-this-yours", () => ({ member: tokens.other }), () => "match/" + state.possibleMatchId, ".lf-match .lf-decide"],
  ["my-posts", () => ({ guest: state.guest }), "mine", "[data-lf-view=mine][data-lf-state=ready]"],
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

try {
  await runFlows();
  await runBuiltCheck();
  if (!process.env.GVDG_LF_SKIP_SCREENS) await runScreens();
  await runGlass();
  // The background cron path works too: nothing due right now, and a tick is a no-op.
  const tick = await lfProcess.runLostFoundTick(env);
  assert.equal(tick.published, 0);
  assert.deepEqual(pageErrors, [], "page errors");
  console.log("Lost & Found browser QA passed (" + geminiCalls + " mocked Gemini calls); screenshots in " + shotsDir);
} finally {
  await browser.close();
  await vite.close();
  globalThis.fetch = realFetch;
}
