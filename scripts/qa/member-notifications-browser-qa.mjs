// Account > Notifications: permission and push subscription are mocked. Checks the opt-in flow,
// the per-category switch, the denied/unsupported states, and light/dark at 390px.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { createServer } from "vite";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const member = { sub: "m_qa", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: false };
const shots = process.env.GVDG_NOTIFY_IMAGES || join(tmpdir(), "gvdg-member-notifications");
const apiRoot = "/fixture";
const calls = [];
let server = { devices: [], prefs: { bagTags: true, messages: true, announcements: true } };

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}

const vite = await createServer({
  configFile: false, cacheDir: await mkdtemp(join(tmpdir(), "gvdg-notify-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_NOTIFY_PORT || 5293), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{ name: "notify-fixture", configureServer(app) {
    app.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      const send = (data, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
      if (url.pathname === "/gvdg-members.html") {
        const mode = url.searchParams.get("mode") || "light";
        const seed = '<script>localStorage.setItem("gvdg_member_token","member-token");localStorage.setItem("theme",' + JSON.stringify(mode) + ');</script>';
        const html = (await readFile("gvdg-members.html", "utf8")).replace(/<link[^>]+https:[^>]+>/g, "")
          .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
          .replace('data-auth-base=""', 'data-auth-base="' + apiRoot + '"')
          .replace(/src="members-app\/[^"]+"/, 'src="/src/members-app/main.js"')
          .replace("<head>", "<head>" + seed);
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await app.transformIndexHtml(url.pathname, html));
        return;
      }
      if (!url.pathname.startsWith(apiRoot + "/")) { next(); return; }
      const path = url.pathname.slice(apiRoot.length);
      if (path === "/me") return send({ ...member, mustChangePin: false });
      if (path === "/me/push-subscription") {
        const body = request.method === "GET" ? {} : await readBody(request);
        calls.push({ method: request.method, body });
        if (request.method === "PUT") {
          if (!server.devices.includes(body.endpoint)) server.devices.push(body.endpoint);
          if (body.prefs) server.prefs = { ...server.prefs, ...body.prefs };
          return send({ ok: true, prefs: server.prefs });
        }
        if (request.method === "DELETE") { server.devices = server.devices.filter((d) => d !== body.endpoint); return send({ ok: true }); }
        return send(server.unconfigured ? { configured: false, publicKey: null } : { configured: true, publicKey: "BEl6" + "A".repeat(83), devices: server.devices.length, subscribed: server.devices.length > 0, prefs: server.prefs });
      }
      send({});
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
await mkdir(shots, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

function mockPush({ permission = "default", supported = true }) {
  return `(() => {
    let subscription = null;
    const make = () => ({ endpoint: "https://push.example/device-1", toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } }; }, unsubscribe: async () => { subscription = null; return true; } });
    class N { static permission = ${JSON.stringify(permission)}; static async requestPermission() { N.permission = "granted"; return "granted"; } }
    ${supported ? "window.Notification = N; window.PushManager = function PushManager() {};" : "delete window.PushManager;"}
    const registration = { pushManager: { getSubscription: async () => subscription, subscribe: async () => (subscription = make()) } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration, addEventListener() {} } });
  })();`;
}

async function open(mode, mock) {
  const context = await browser.newContext({ viewport: { width: 390, height: 870 }, serviceWorkers: "block" });
  await context.route(/^https?:/, (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(mockPush(mock));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(30_000);
  await page.goto(origin + "/gvdg-members.html?mode=" + mode + "#account", { waitUntil: "commit" });
  await page.locator("[data-member-notifications]").waitFor();
  return { page, context, errors };
}

for (const mode of ["light", "dark"]) {
  server = { devices: [], prefs: { bagTags: true, messages: true, announcements: true } };
  calls.length = 0;
  const view = await open(mode, {});
  const { page } = view;
  const master = page.locator("[data-member-switch='notifications']");
  assert.equal(await master.getAttribute("aria-checked"), "false");
  assert.equal(await page.locator("[data-member-switch='announcements']").count(), 0, "announcements category hidden until notifications are on");
  assert.equal(await page.locator("[data-member-switch='bag-tags']").count(), 0, "category hidden until notifications are on");
  await master.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, "notifications-off-" + mode + ".png"), animations: "disabled" });
  await master.click();
  await page.locator("[data-member-notifications='on']").waitFor();
  assert.equal(await master.getAttribute("aria-checked"), "true");
  const ann = page.locator("[data-member-switch='announcements']");
  assert.equal(await ann.getAttribute("aria-checked"), "true", "Club announcements default on");
  const bag = page.locator("[data-member-switch='bag-tags']");
  assert.equal(await bag.getAttribute("aria-checked"), "true", "Bag tag challenges default on");
  assert.deepEqual(calls.find((c) => c.method === "PUT").body.prefs, { bagTags: true, messages: true, announcements: true });
  await page.screenshot({ path: join(shots, "notifications-on-" + mode + ".png"), animations: "disabled" });
  await ann.click();
  await page.waitForFunction(() => document.querySelector("[data-member-switch='announcements']")?.getAttribute("aria-checked") === "false");
  assert.equal(server.prefs.announcements, false, "announcements preference saved to the server");
  await bag.click();
  await page.waitForFunction(() => document.querySelector("[data-member-switch='bag-tags']")?.getAttribute("aria-checked") === "false");
  assert.equal(server.prefs.bagTags, false, "preference saved to the server");
  await page.screenshot({ path: join(shots, "notifications-category-off-" + mode + ".png"), animations: "disabled" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
  await master.click();
  await page.locator("[data-member-notifications='off']").waitFor();
  assert.equal(server.devices.length, 0, "turning off removes the device");
  assert.deepEqual(view.errors, []);
  await view.context.close();
  console.log("Notifications toggle verified at 390px in " + mode);
}

const denied = await open("light", { permission: "denied" });
await denied.page.locator("[data-member-notifications='denied']").waitFor();
await denied.page.screenshot({ path: join(shots, "notifications-denied-light.png"), animations: "disabled" });
await denied.context.close();
const unsupported = await open("light", { supported: false });
await unsupported.page.locator("[data-member-notifications='unsupported']").waitFor();
await unsupported.context.close();
server = { devices: [], prefs: { bagTags: true, messages: true, announcements: true }, unconfigured: true };
const off = await open("light", {});
await off.page.locator("[data-member-notifications='unconfigured']").waitFor();
await off.context.close();
console.log("Denied, unsupported and unconfigured states verified. Screenshots " + shots);
await browser.close();
await vite.close();
