// Shared fixture for the sitewide glass QA and screenshots: serves the built site (repo root) over HTTP,
// mocks the API with Playwright routes, and seeds a member session + theme (photo wallpaper, glass preset).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { GLASS_PRESETS, buildGlassOnlyTheme, buildTheme } from "../../src/shared/dashboard-theme-model.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
export const API = "http://127.0.0.1:8788";

export async function startSite(port = Number(process.env.GVDG_SITEWIDE_PORT || 0)) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
      if (!file.startsWith(root + sep)) return response.writeHead(403).end();
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch { response.writeHead(404).end("not found"); }
  });
  await new Promise((ready) => server.listen(port, "127.0.0.1", ready));
  return { origin: "http://127.0.0.1:" + server.address().port, close: () => new Promise((done) => server.close(done)) };
}

const holes = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 3, distance_ft: 250 + i * 10 }));
const courses = [
  { id: 1, name: "Rocky Ford Disc Golf", location: "Greenville, SC", lat: 35.62, lng: -77.38, coverage: "full" },
  { id: 2, name: "West Meadowbrook Park", location: "Greenville, SC", lat: 35.6, lng: -77.35, coverage: "full" },
  { id: 3, name: "Cleveland Park", location: "Greenville, SC", lat: 35.65, lng: -77.4, coverage: "basic" },
];
const layouts = [{ id: 11, name: "Main Layout", course_id: 1, total_par: 54, expected_holes: 18, holes }];
const events = [
  { id: 2, type: "league", name: "Sunday Bag Tag Round", status: "scheduled", format: "stroke", play_format: "singles", date: "2026-11-22",
    course_id: 1, layout_id: 11, players: [], course_name: "Rocky Ford Disc Golf", start_time: "10:00" },
  { id: 3, type: "tournament", name: "Winter Open", status: "scheduled", format: "stroke", play_format: "singles", date: "2026-12-06",
    course_id: 2, layout_id: 11, players: [], course_name: "West Meadowbrook Park" },
];
const products = [
  { id: 1, active: 1, brand: "Innova", name: "Destroyer", price_cents: 1799, product_type: "disc", stock_qty: 4, description: "Distance driver" },
  { id: 2, active: 1, brand: "Discraft", name: "Buzzz", price_cents: 1699, product_type: "disc", stock_qty: 9, description: "Midrange" },
  { id: 3, active: 1, brand: "GVDG", name: "Club Tee", price_cents: 2500, product_type: "apparel", stock_qty: 12, description: "Cotton tee" },
];
const member = { sub: "m_glass_fixture", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: true };

export function apiResponse(path) {
  if (path === "/me") return member;
  if (path === "/courses") return { courses };
  if (/^\/courses\/\d+\/layouts$/.test(path)) return { layouts };
  if (/^\/courses\/\d+\/tee-signs$/.test(path)) return { teeSigns: [] };
  if (path === "/events") return { events };
  if (/^\/events\/\d+$/.test(path)) return { event: events[0] };
  if (path === "/club-feed") return { events: [], clubEvents: [] };
  if (path === "/leagues") return { leagues: [] };
  if (path === "/meetings") return { meetings: [] };
  if (path === "/payments/config") return { enabled: false };
  if (path === "/shop/products") return { products };
  if (path === "/shop/wallet") return { balance_cents: 3250, orders: [], transactions: [] };
  if (path === "/my-live-rounds") return { rounds: [] };
  if (path === "/courses/traffic" || path.endsWith("/traffic")) return { courses: [], traffic: [] };
  return {};
}

const wallpaperCache = new Map();
export async function wallpaper(name = "slide5") {
  if (!wallpaperCache.has(name)) wallpaperCache.set(name, "data:image/jpeg;base64," + (await readFile(join(root, "img", name + ".jpg"))).toString("base64"));
  return wallpaperCache.get(name);
}

// glass: "off" | "frosted" | "clear" | "custom-<opacity>-<blur>"; kind: "photo" (preset + wallpaper) | "default" (glass-only)
export async function themeFor({ glass = "frosted", mode = "dark", kind = "photo" } = {}) {
  const preset = GLASS_PRESETS[glass] || GLASS_PRESETS.off;
  if (kind === "default") return preset.opacity || preset.blur ? buildGlassOnlyTheme(preset, mode) : null;
  return buildTheme({ mode, preset: "Frost", wallpaper: await wallpaper(), glass: preset });
}

export async function openPage(browser, origin, path, { glass = "frosted", mode = "dark", kind = "photo", width = 390, height = 844, signedIn = true,
  reducedTransparency = false, seed = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block", reducedMotion: "reduce", colorScheme: mode });
  await context.clock.setFixedTime(new Date("2026-11-16T12:00:00Z")); // stable "last updated" text for pixel comparisons
  const theme = signedIn ? await themeFor({ glass, mode, kind }) : null;
  await context.route(API + "/**", (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/me/dashboard-theme" ? { theme } : url.pathname === "/me" && !signedIn ? { error: "unauthorized" } : apiResponse(url.pathname);
    return route.fulfill({ status: url.pathname === "/me" && !signedIn ? 401 : 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await context.addInitScript(({ signedIn, mode, theme, seed }) => {
    try {
      localStorage.setItem("theme", mode);
      if (signedIn) {
        const payload = btoa(JSON.stringify({ sub: "m_glass_fixture", exp: 4102444800 })).replace(/=+$/, "");
        localStorage.setItem("gvdg_member_token", "x." + payload + ".y");
        if (theme) for (const id of ["m_glass_fixture", "me"]) localStorage.setItem("gvdg_dashboard_theme:" + id, JSON.stringify(theme));
      }
      if (seed) (0, eval)(seed);
    } catch { /* ignore */ }
  }, { signedIn, mode, theme, seed });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (reducedTransparency) {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  }
  await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  return { page, context, errors };
}
