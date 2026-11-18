import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

process.env.VITE_DISABLE_REACT_DEVTOOLS = "1";
const imageDir = process.env.GVDG_PUBLIC_IMAGES || join(tmpdir(), "gvdg-public-polish");
const today = new Date();
const fixtureDate = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);
const course = { id: 1, name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.631, lng: -77.32 };
const holes = Array.from({ length: 18 }, (_, offset) => ({
  hole: offset + 1, par: offset % 5 ? 3 : 4, distance_ft: 243 + offset * 11,
  tee: { lat: 35.631 + offset * .0003, lng: -77.32 },
  target: { lat: 35.632 + offset * .0003, lng: -77.321 },
}));
const layout = { id: 11, name: "Main layout", total_par: 58, holes };
const event = {
  id: 2, type: "tournament", name: "Pitt County Fall Open", status: "scheduled", format: "stroke",
  play_format: "singles", date: fixtureDate, course_id: 1, layout_id: 11, players: [],
  entry_fee_cents: 1500, ctp_fee_cents: 300, divisions: ["MA2", "FA2"],
};
const league = { league: { id: 4, name: "Ryder Cup" }, standings: [], teamStandings: [], roundWinners: [], events: [],
  board: {
    scoreboard: { red: { name: "Red Team", players: ["Taylor Morgan"] }, blue: { name: "Blue Team", players: ["Jordan Parker"] } },
    teamPoints: { red: 2, blue: 0 },
    weeks: [{ label: "Week 1", format: "singles", matches: [{ num: 1, red: "Taylor Morgan", blue: "Jordan Parker", winner: "red", score: "2&1", livePath: "/events.html#event/2" }] }],
  },
};
const products = [
  { id: 1, active: 1, brand: "Innova", name: "Star Mako3", color: "Blue", weight_g: 175, price_cents: 1800, product_type: "disc", stock_qty: 4 },
  { id: 2, active: 1, brand: "Axiom", name: "Neutron Envy", color: "Orange", weight_g: 173, price_cents: 1900, product_type: "disc", stock_qty: 1 },
  { id: 3, active: 1, brand: "GVDG", name: "Club mini", color: "Green", price_cents: 800, product_type: "accessory", stock_qty: 5 },
];
const state = { checkouts: [], registrations: [], retry: 0 };
const fixtures = new Map([
  ["/courses", { courses: [course] }],
  ["/courses/1/layouts", { layouts: [layout] }],
  ["/courses/1/tee-signs", { teeSigns: [] }],
  ["/course-conditions", { reports: [] }],
  ["/events", { events: [event] }],
  ["/events/2", { event }],
  ["/events/2/results", { results: [] }],
  ["/events/2/registration", { registrations: [], players: [] }],
  ["/events/2/ctps", { ctps: [] }],
  ["/events/2/ace-pot", { ace_pot: null }],
  ["/registration/open", { events: [event] }],
  ["/club-feed", { events: [], clubEvents: [] }],
  ["/pdga-events", { events: [] }],
  ["/leagues", { leagues: [league] }],
  ["/leagues/4", league],
  ["/shop/wallet", { balance_cents: 2600, orders: [] }],
  ["/payments/config", { enabled: false }],
]);
const entries = {
  "/index.html": "/src/home-app/main.js",
  "/events.html": "/src/public-app/main.js",
  "/pro-shop.html": "/src/public-app/main.js",
  "/ryder-cup.html": "/src/public-app/main.js",
  "/gvdg-blog.html": "/src/public-app/main.js",
  "/scoring-app.html": "/src/public-app/main.js",
  "/tee-sign-preview.html": "/src/tee-sign-preview-app/main.js",
};

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const vite = await createServer({
  configFile: false,
  cacheDir: process.env.GVDG_PUBLIC_CACHE_DIR || await mkdtemp(join(tmpdir(), "gvdg-public-vite-")),
  server: { host: "127.0.0.1", port: Number(process.env.GVDG_PUBLIC_PORT || 5198), strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "lucide-react"] },
  plugins: [{ name: "public-polish-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/tokens.css" && process.env.GVDG_PUBLIC_TOKEN_PATH) {
        response.writeHead(200, { "Content-Type": "text/css" });
        response.end(await readFile(process.env.GVDG_PUBLIC_TOKEN_PATH));
        return;
      }
      const entry = entries[url.pathname];
      if (entry) {
        const html = (await readFile(url.pathname.slice(1), "utf8"))
          .replace(/<script[^>]+src="pwa\.js[^"]*"[^>]*><\/script>/, "")
          .replace(/src="(?:home-app|public-app|tee-sign-preview-app)\/[^"]+"/, 'src="' + entry + '"')
          .replace(/\sdata-(?:auth|api)-base=""/, "")
          .replace("<body", '<body data-auth-base="/fixture" data-api-base="/fixture"');
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await server.transformIndexHtml(url.pathname, html));
        return;
      }
      if (!url.pathname.startsWith("/fixture/")) return next();
      const key = url.pathname.slice("/fixture".length);
      const referer = new URL(request.headers.referer || "http://localhost");
      const scenario = referer.searchParams.get("state");
      function reply(data, status = 200) {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data));
      }
      if (key === "/shop/products") {
        if (scenario === "retry" && state.retry++ === 0) return reply({ error: "temporarily unavailable" }, 503);
        if (scenario === "loading") await new Promise((resolve) => setTimeout(resolve, 1300));
        return reply({ products: scenario === "empty" ? [] : products });
      }
      if (key === "/shop/paypal-order" || key === "/shop/orders") {
        const body = await readJson(request);
        state.checkouts.push({ key, body, authorization: request.headers.authorization });
        return reply({ amount_cents: 1800 }, 201);
      }
      if (key === "/events/2/register") {
        state.registrations.push({ method: request.method, body: request.method === "POST" ? await readJson(request) : null });
        return reply({ guestToken: "deadbeef" });
      }
      if (key === "/me") return reply({ sub: "qa", name: "Fixture Member" });
      return reply(fixtures.get(key) || {});
    });
  } }],
});
await vite.listen();
const origin = vite.resolvedUrls.local[0].replace(/\/$/, "");
if (process.env.GVDG_PUBLIC_SERVE) {
  console.log(origin + "/index.html");
  await new Promise(() => {});
}

const profiles = [
  { name: "light-390", width: 390, height: 844, mode: "light" },
  { name: "dark-large-320", width: 320, height: 760, mode: "dark", large: true },
  { name: "light-1280", width: 1280, height: 900, mode: "light" },
  { name: "dark-1280", width: 1280, height: 900, mode: "dark" },
];

const destinations = {
  "/index.html": ["home", ".hero-title"],
  "/events.html": ["events", "[data-events-view=hub]"],
  "/events.html#event/2": ["event-detail", ".event-tee-signs"],
  "/events.html#league/4": ["league", "[data-react-events-league-detail]"],
  "/pro-shop.html": ["shop", "[data-react-pro-shop=ready]"],
  "/ryder-cup.html": ["ryder", "[data-react-ryder-cup=ready]"],
  "/gvdg-blog.html": ["blog", ".construction-card"],
  "/scoring-app.html": ["guide", "#app-title"],
  "/tee-sign-preview.html": ["tee-sign-preview", ".tee-preview-title"],
  "/design.html": ["design", ".chooser"],
  "/design-field.html": ["design-field", "h1"],
  "/design-night.html": ["design-night", "h1"],
  "/archive.html": ["archive", "[data-events-view=hub]"],
};

async function screenshot(page, name, { fullPage = true } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const element of document.querySelectorAll("main section, :scope > section, .fade-in, img[loading=lazy]")) {
      if (element.closest("[inert]")) continue;
      const bounds = element.getBoundingClientRect();
      if (bounds.height) window.scrollBy({ top: bounds.top - innerHeight / 4, behavior: "instant" });
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.screenshot({ path: join(imageDir, name + ".png"), fullPage, animations: "disabled" });
}

async function assertFits(page, label) {
  // No visible button or link label may be cut off (flex buttons never render an ellipsis, they just clip).
  const clipped = await page.evaluate(() => [...document.querySelectorAll("button, a, [role=button], summary")].filter((node) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2 || node.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" || node.scrollWidth <= node.clientWidth + 1) return false;
    return !(style.textOverflow === "ellipsis" && !/flex|grid/.test(style.display));
  }).map((node) => (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) + " (" + node.scrollWidth + ">" + node.clientWidth + ")"));
  if (clipped.length) throw new Error(label + " clipped labels: " + clipped.join(" | "));
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
  if (overflow <= 1) return;
  const offenders = await page.evaluate(() => Array.from(document.body.querySelectorAll("*"))
    .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
    .slice(0, 10).map((node) => node.outerHTML.slice(0, 180) + " " + Math.round(node.getBoundingClientRect().right)));
  throw new Error(label + " horizontal overflow: " + overflow + " (" + offenders.join(", ") + ")");
}

async function open(page, path, selector, profile) {
  await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  await page.locator(selector).first().waitFor({ timeout: 45_000 });
  await assertFits(page, profile.name + " " + path);
}

async function makeContext(browser, { width, height, mode, large, member }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: mode, reducedMotion: "reduce", serviceWorkers: "block" });
  await context.addInitScript(({ mode, large, member }) => {
    localStorage.setItem("theme", mode);
    if (member) localStorage.setItem("gvdg_member_token", "qa-member-token");
    if (large) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "20px"; }, { once: true });
  }, { mode, large, member });
  await context.route(/https?:\/\/(?!127\.0\.0\.1:)/, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "paypal.me") return route.fulfill({ contentType: "text/html", body: "<p>Mock PayPal handoff</p>" });
    if (url.hostname === "docs.google.com" && !url.pathname.includes("/gviz/") && !url.pathname.includes("/export")) {
      return route.fulfill({ contentType: "text/csv", body: "Name,Date,Detail,URL\n" });
    }
    if (url.hostname === "docs.google.com") return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  return context;
}

async function checkHome(page, profile) {
  await open(page, "/index.html", ".hero-title", profile);
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.press("Enter");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Home", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === "Home");
  assert((await nav.locator("#navLinks").boundingBox()).y < 90, "Mobile menu starts directly below header");
  const donate = nav.getByRole("link", { name: "Donate" });
  assert.equal(await donate.getAttribute("href"), "https://paypal.me/greenvillediscgolf");
  assert.equal(await donate.getAttribute("target"), "_blank");
  await screenshot(page, "interaction-mobile-menu", { fullPage: false });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open menu");
  await nav.getByRole("link", { name: "Donate" }).waitFor({ state: "hidden" });

  const pay = page.getByRole("link", { name: "Pay with PayPal" });
  assert.equal(await pay.getAttribute("href"), "https://paypal.me/greenvillediscgolf/15");
  assert.equal(await page.getByRole("link", { name: "Set up login" }).getAttribute("href"), "gvdg-members.html#apply");
  const positions = await page.evaluate(() => ["membership", "courses"].map((id) => document.getElementById(id).offsetTop));
  assert(positions[0] < positions[1], "Membership is before Courses");
  assert.equal(await page.locator("#membership .perk").first().evaluate((element) => getComputedStyle(element).opacity), "1");

  const activeSlide = page.locator(".carousel-slide-courses:not([inert])");
  assert.equal(await activeSlide.getByRole("button", { name: /course details/i }).count(), 2);
  await activeSlide.locator(".course-more summary").click();
  const courseCards = activeSlide.getByRole("button", { name: /course details/i });
  assert((await courseCards.count()) > 2, "Course group retains all courses");
  await courseCards.last().press("Enter");
  const modal = page.getByRole("dialog");
  await modal.getByRole("link", { name: /directions/i }).waitFor();
  await modal.getByRole("link", { name: /view on UDisc/i }).waitFor();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await courseCards.last().evaluate((element) => element === document.activeElement), true);
  await page.locator("#coursesNextBtn").click();
  assert.equal(await page.locator(".carousel-slide-courses[inert]").count(), 2);
  assert.equal(await activeSlide.getByRole("button", { name: /course details/i }).count(), 2);
  await page.waitForFunction(() => {
    const slide = document.querySelector(".carousel-slide-courses:not([inert])");
    return Math.abs(slide.getBoundingClientRect().left - slide.closest(".courses-carousel-container").getBoundingClientRect().left) < 1;
  });
  await screenshot(page, "interaction-home-courses");
}

async function checkEvents(page, profile) {
  await open(page, "/events.html", "[data-react-events-registration-card]", profile);
  const registration = page.locator("[data-react-events-registration-card]");
  await registration.getByText("Sign up", { exact: true }).click();
  const submit = registration.getByRole("button", { name: "Register", exact: true });
  await submit.click();
  await registration.getByText("Please enter your name.").waitFor();
  await registration.getByLabel("Your name").fill("Fixture Guest");
  await registration.getByLabel("Email (optional)").fill("fixture@example.test");
  await registration.getByLabel("Division").selectOption("FA2");
  await registration.getByLabel("CTP pot $3").check();
  await screenshot(page, "interaction-event-registration");
  await submit.click();
  await registration.getByText("Registered - Fixture Guest").waitFor();
  assert.deepEqual(state.registrations.at(-1), {
    method: "POST",
    body: { addons: { ctp: true, ace: false }, division: "FA2", name: "Fixture Guest", email: "fixture@example.test" },
  });
  await registration.getByRole("button", { name: "Withdraw", exact: true }).click();
  await registration.getByRole("button", { name: "Cancel", exact: true }).click();
  await registration.getByRole("button", { name: "Withdraw", exact: true }).click();
  await registration.getByRole("button", { name: "Confirm withdraw", exact: true }).click();
  await registration.getByText("Sign up", { exact: true }).waitFor();
  assert.equal(state.registrations.at(-1).method, "DELETE");

  await open(page, "/events.html#event/2", ".event-tee-signs", profile);
  assert.equal(await page.locator(".ts-hole-card").count(), 0);
  await page.locator(".event-tee-signs > summary").press("Enter");
  await page.locator(".ts-hole-card").first().waitFor();
  assert.equal(await page.locator(".ts-hole-card").count(), 6);
  await page.getByText("Holes 13–18", { exact: true }).click();
  await page.locator(".ts-hole-num").getByText("Hole 18", { exact: true }).waitFor();
  assert.equal(await page.locator(".ts-hole-card").count(), 12);
  await screenshot(page, "interaction-event-tee-signs");
  // Add to calendar opens a menu (Google / Outlook pages filled in, or the .ics file), not a bare download.
  const calendar = page.getByRole("button", { name: "Add to calendar" });
  if (await calendar.count()) {
    await calendar.click();
    const menu = page.getByRole("menu", { name: "Add to calendar" });
    await menu.waitFor();
    assert.equal(await menu.getByRole("menuitem").count(), 3);
    assert.match(await menu.getByRole("menuitem", { name: "Google Calendar" }).getAttribute("href"), /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&/);
    const box = await menu.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, "the calendar menu fits the screen");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  } else {
    throw new Error("the event page has no Add to calendar button");
  }
  await page.getByRole("button", { name: /all events/i }).click();
  await page.locator("[data-events-view=hub]").waitFor();
}

async function checkShop(page, profile) {
  await open(page, "/pro-shop.html?state=retry", ".public-state .shop-filter-reset", profile);
  await page.getByText("The shop could not load.").waitFor();
  await page.getByRole("button", { name: "Try again" }).click();
  await page.locator("[data-react-pro-shop=ready]").waitFor();
  const search = page.getByLabel("Search shop");
  await search.fill("unknown model");
  await page.getByText("No products match those filters.").waitFor();
  await search.fill("");
  await page.getByText("More filters", { exact: true }).press("Enter");
  await page.getByLabel("Brand", { exact: true }).selectOption("Innova");
  await page.getByLabel("Color", { exact: true }).selectOption("Blue");
  await page.getByLabel("Weight", { exact: true }).selectOption("175");
  await page.getByLabel("Type", { exact: true }).selectOption("disc");
  await page.getByText("Filters (4 selected)").waitFor();
  assert.equal(await page.locator(".product-card").count(), 1);
  await screenshot(page, "interaction-shop-filters");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByLabel("Sort products").selectOption("price_asc");
  assert.equal(await page.locator(".product-card").count(), 3);
  assert.match(await page.locator(".product-card").first().innerText(), /Club mini/);
  const firstDisc = page.locator(".product-card").filter({ hasText: "Star Mako3" });
  await firstDisc.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("link", { name: "Cart (1)" }).click();
  await page.getByRole("button", { name: "Increase Star Mako3 quantity" }).click();
  await page.getByRole("link", { name: "Cart (2)" }).waitFor();
  await page.getByRole("button", { name: "Decrease Star Mako3 quantity" }).click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await page.getByText(/enter your name so the club/i).waitFor();
  await page.getByLabel("Your name", { exact: true }).fill("Fixture Guest");
  await page.getByLabel("Email or phone", { exact: true }).fill("fixture@example.test");
  await screenshot(page, "interaction-shop-cart");
  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await page.waitForURL("https://paypal.me/greenvillediscgolf/18.00");
  assert.deepEqual(state.checkouts.at(-1), { key: "/shop/paypal-order",
    body: { contact: "fixture@example.test", items: [{ product_id: 1, quantity: 1 }], name: "Fixture Guest" },
    authorization: undefined,
  });
  await open(page, "/pro-shop.html?state=empty", "[data-react-pro-shop=ready]", profile);
  await page.getByText("No products are currently in stock.").waitFor();
  await open(page, "/pro-shop.html?state=loading", "[data-react-pro-shop=loading]", profile);
  await page.getByText("Loading shop products…").waitFor();
  await page.locator("[data-react-pro-shop=ready]").waitFor();
}

async function checkShopMember(browser, profile) {
  const context = await makeContext(browser, { ...profile, member: true });
  try {
    const page = await context.newPage();
    await open(page, "/pro-shop.html", "[data-react-pro-shop=ready]", profile);
    const checkout = page.getByRole("button", { name: "Spend store credit" });
    assert.equal(await checkout.isDisabled(), true);
    await page.locator(".product-card").filter({ hasText: "Star Mako3" }).getByRole("button", { name: "Add", exact: true }).click();
    await checkout.click();
    await page.getByText(/order submitted/i).waitFor();
    assert.equal(await checkout.isDisabled(), true);
    const submission = state.checkouts.at(-1);
    assert.equal(submission.key, "/shop/orders");
    assert.equal(submission.authorization, "Bearer qa-member-token");
    assert(submission.body.idempotency_key);
    assert.deepEqual(submission.body.items, [{ product_id: 1, quantity: 1 }]);
  } finally {
    await context.close();
  }
}

async function checkOtherPublicControls(page, profile) {
  await open(page, "/scoring-app.html", "#app-title", profile);
  await page.getByRole("link", { name: /watch a round/i }).click();
  assert.equal(new URL(page.url()).hash, "#watch-live");
  await page.locator("#watch-live").getByText(/new casual rounds start as/i).waitFor();
  await page.locator("#themes").getByRole("heading", { name: "Wallpaper. Color. Glass." }).waitFor();
  assert.equal(await page.locator(".theme-shot").count(), 3);
  const closedFaq = page.locator(".app-faq details:not([open])").first().locator("summary");
  await closedFaq.click();
  assert.equal(await page.locator(".app-faq details[open]").count(), 2);
  assert.equal(await page.locator("#round-clips").count(), 1);
  assert.equal(await page.locator("#customize").count(), 1);
  await open(page, "/tee-sign-preview.html", ".tee-preview-title", profile);
  await page.locator(".tee-preview-toggle").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await open(page, "/ryder-cup.html", "[data-react-ryder-scoreboard]", profile);
  const roster = page.locator(".team-panel.red .ryder-roster");
  await roster.locator("summary").click();
  await roster.getByText("Taylor Morgan").waitFor();
  await page.locator(".match-link").first().click();
  await page.waitForURL(origin + "/events.html#event/2");
  await open(page, "/gvdg-blog.html", ".construction-card", profile);
  await page.getByRole("link", { name: "Browse events" }).click();
  await page.waitForURL(origin + "/events.html");
  await open(page, "/design.html", ".chooser", profile);
  await page.getByRole("link", { name: /direction 01/i }).click();
  await page.waitForURL(origin + "/design-field.html");
  await page.locator(".switch").getByRole("link", { name: "Night" }).click();
  await page.waitForURL(origin + "/design-night.html");
}

async function checkInteractions(browser) {
  const profile = profiles[0];
  const context = await makeContext(browser, profile);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    for (const check of [checkHome, checkEvents, checkShop, checkOtherPublicControls]) {
      await check(page, profile);
      console.log(check.name + " passed");
    }
    await checkShopMember(browser, profile);
    console.log("checkShopMember passed");
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    try {
      const fallback = await noScript.newPage();
      await fallback.goto(origin + "/index.html");
      await fallback.getByRole("link", { name: "Pay $15 annual dues" }).waitFor();
      await fallback.getByRole("link", { name: "Create member login" }).waitFor();
      console.log("home no-JavaScript fallback passed");
    } finally {
      await noScript.close();
    }
  } finally {
    await context.close();
  }
}

await mkdir(imageDir, { recursive: true });
const browser = await chromium.launch();
try {
  const screenFilter = process.env.GVDG_PUBLIC_SCREENS?.split(",");
  const pageFilter = process.env.GVDG_PUBLIC_PAGES?.split(",");
  const selectedProfiles = profiles.filter((profile) => !screenFilter || screenFilter.includes(profile.name));
  for (const profile of process.env.GVDG_PUBLIC_INTERACTIONS_ONLY ? [] : selectedProfiles) {
    const context = await makeContext(browser, profile);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [path, [name, ready]] of Object.entries(destinations)) {
      if (pageFilter && !pageFilter.includes(name)) continue;
      await open(page, path, ready, profile);
      await screenshot(page, profile.name + "-" + name);
      if (["home", "events", "shop", "guide"].includes(name)) {
        await page.screenshot({ path: join(imageDir, profile.name + "-" + name + "-top.png"), animations: "disabled" });
      }
      assert.deepEqual(errors, [], profile.name + " " + path);
      console.log(profile.name + " " + name);
    }
    await context.close();
  }
  if (!process.env.GVDG_PUBLIC_SCREENS_ONLY && !pageFilter) await checkInteractions(browser);
} finally {
  await browser.close();
  await vite.close();
}
