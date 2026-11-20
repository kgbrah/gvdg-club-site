// Read-only drive of the LIVE member and admin apps on gvdgclub.com as the QA admin.
// Visits every member and admin destination at phone / large-text / desktop sizes, light and dark, and
// records console + page errors, failed requests, horizontal overflow and clipped labels, with screenshots.
// It only navigates (hash routes); it never submits a form or presses an action button.
//
// Run in CI (secrets): GVDG_STAGING_QA_TOKEN, or GVDG_STAGING_QA_IDENTIFIER + GVDG_STAGING_QA_PIN.
// Optional: GVDG_SITE_URL (default https://gvdgclub.com), GVDG_API_URL (default https://auth.gvdgclub.com),
// GVDG_LIVE_DRIVE_OUT (default ./live-drive), GVDG_LIVE_DRIVE_ONLY ("admin:courses,member:events"), CHROMIUM_PATH.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { ADMIN_DESTINATIONS, MEMBER_DESTINATIONS, appHref } from "../../src/shared/app-navigation.js";

const siteUrl = (process.env.GVDG_SITE_URL || "https://gvdgclub.com").replace(/\/$/, "");
const apiUrl = (process.env.GVDG_API_URL || "https://auth.gvdgclub.com").replace(/\/$/, "");
const out = process.env.GVDG_LIVE_DRIVE_OUT || "live-drive";
await mkdir(join(out, "shots"), { recursive: true });

const env = (name) => (process.env[name] || "").trim();

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json", Origin: siteUrl };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(apiUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`API ${method} ${path} -> ${response.status}: ${(data && data.error) || text.slice(0, 120)}`);
  return data;
}

async function qaToken() {
  if (env("GVDG_STAGING_QA_TOKEN")) return env("GVDG_STAGING_QA_TOKEN");
  const identifier = env("GVDG_STAGING_QA_IDENTIFIER");
  const pin = env("GVDG_STAGING_QA_PIN");
  if (!identifier || !pin) throw new Error("Set GVDG_STAGING_QA_TOKEN, or GVDG_STAGING_QA_IDENTIFIER plus GVDG_STAGING_QA_PIN.");
  const data = await api("/login", { method: "POST", body: { identifier, pin } });
  if (data && data.mustChangePin === true) {
    // Same handling as the post-deploy member E2E: re-set the same PIN to clear the forced-change flag.
    return (await api("/set-pin", { method: "POST", token: data.token, body: { newPin: pin } })).token;
  }
  return data.token;
}

const token = await qaToken();
const me = await api("/me", { token });
if (me.isAdmin !== true) throw new Error("The QA member must be an admin to drive the admin app.");

// Real ids for the admin's event- and course-scoped tools.
const events = (await api("/events").catch(() => ({ events: [] }))).events || [];
const courses = (await api("/courses").catch(() => ({ courses: [] }))).courses || [];
const liveOrNext = events.find((event) => event.status === "live") || events.find((event) => event.status === "scheduled") || events[0];
const finalEvent = events.find((event) => event.status === "final") || liveOrNext;
const courseId = courses[0]?.id;
function adminContext(item) {
  if (item.context === "course") return courseId ? { courseId } : {};
  if (item.context === "event") return { eventId: (item.key === "results" ? finalEvent : liveOrNext)?.id };
  return {};
}

const variants = [
  { name: "390-dark", width: 390, height: 844, mode: "dark" },
  { name: "390-light", width: 390, height: 844, mode: "light" },
  { name: "320-dark-large", width: 320, height: 760, mode: "dark", large: true },
  { name: "1280-light", width: 1280, height: 900, mode: "light" },
];

const IGNORED_REQUEST = /\/cdn-cgi\/rum|google-analytics|googletagmanager/;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const findings = [];
let visited = 0;

async function inspect(page, label) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
    const clipped = [...document.querySelectorAll("button, a, [role=button], summary")].filter((node) => {
      const box = node.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2 || node.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" || node.scrollWidth <= node.clientWidth + 1) return false;
      return !(style.textOverflow === "ellipsis" && !/flex|grid/.test(style.display));
    }).map((node) => (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) + " (" + node.scrollWidth + ">" + node.clientWidth + ")");
    // Deepest offenders first: those are the element actually sticking out, not its ancestors.
    const wide = overflow > 1 ? [...document.body.querySelectorAll("*")]
      .filter((node) => node.getBoundingClientRect().right > width + 0.5)
      .filter((node, _, all) => !all.some((other) => other !== node && node.contains(other)))
      .slice(0, 4).map((node) => node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + "." + String(node.className).split(" ")[0]
        + "@" + Math.round(node.getBoundingClientRect().right)) : [];
    // Content spilling out of a non-clipping box widens the page without moving any element's edge
    // (e.g. a long unbreakable word). Report those boxes too.
    const spill = overflow > 1 ? [...document.body.querySelectorAll("*")].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible"
        && box.left + node.scrollWidth > width + 0.5;
    }).filter((node, _, all) => !all.some((other) => other !== node && node.contains(other)))
      .slice(0, 4).map((node) => "spill:" + node.tagName.toLowerCase() + "." + String(node.className).split(" ")[0]
        + " '" + (node.textContent || "").trim().slice(0, 40) + "' " + node.scrollWidth + ">" + node.clientWidth) : [];
    return { overflow, clipped, wide: wide.concat(spill) };
  });
}

async function drive(role, file, items, variant) {
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, colorScheme: variant.mode,
    serviceWorkers: "block" });
  await context.addInitScript(({ value, mode, large }) => {
    try {
      localStorage.setItem("gvdg_member_token", value);
      localStorage.setItem("theme", mode);
    } catch { /* storage blocked */ }
    if (large) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "130%"; });
  }, { value: token, mode: variant.mode, large: Boolean(variant.large) });
  const only = (process.env.GVDG_LIVE_DRIVE_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const item of items.filter((entry) => !only.length || only.includes(role + ":" + entry.key))) {
    const page = await context.newPage();
    const issues = [];
    page.on("console", (message) => { if (message.type() === "error") issues.push("console: " + message.text().slice(0, 200)); });
    page.on("pageerror", (error) => issues.push("pageerror: " + error.message.slice(0, 200)));
    page.on("response", (response) => {
      const url = response.url();
      if (response.status() >= 400 && !IGNORED_REQUEST.test(url) && !/favicon/.test(url)) issues.push("http " + response.status() + " " + url.slice(0, 140));
    });
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (!IGNORED_REQUEST.test(url) && request.failure()?.errorText !== "net::ERR_ABORTED") issues.push("reqfail " + request.failure()?.errorText + " " + url.slice(0, 140));
    });
    const href = siteUrl + "/" + file + appHref(role, item.key, role === "admin" ? adminContext(item) : {});
    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.getByRole("heading", { name: item.label, level: 1, exact: true }).first().waitFor({ timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      let layout = await inspect(page);
      if (layout.overflow > 1) {
        // Re-measure after a pause: separates an entrance animation from a real layout overflow.
        await page.waitForTimeout(1500);
        layout = await inspect(page);
      }
      if (layout.overflow > 1) issues.push("h-overflow " + layout.overflow + "px " + layout.wide.join(" "));
      if (layout.clipped.length) issues.push("clipped: " + layout.clipped.join(" | "));
      await page.screenshot({ path: join(out, "shots", `${role}-${item.key}-${variant.name}.png`), animations: "disabled" });
    } catch (error) {
      issues.push("load: " + error.message.split("\n")[0].slice(0, 200));
      await page.screenshot({ path: join(out, "shots", `${role}-${item.key}-${variant.name}-FAILED.png`) }).catch(() => {});
    }
    visited += 1;
    if (issues.length) findings.push({ role, destination: item.key, variant: variant.name, issues: [...new Set(issues)] });
    await page.close();
  }
  await context.close();
}

try {
  for (const variant of variants) {
    await drive("member", "gvdg-members.html", MEMBER_DESTINATIONS, variant);
    await drive("admin", "admin.html", ADMIN_DESTINATIONS, variant);
    console.log(variant.name + " done");
  }
} finally {
  await browser.close();
}

const summary = { siteUrl, version: await fetch(siteUrl + "/version.json").then((r) => r.json()).catch(() => null), visited,
  member: MEMBER_DESTINATIONS.length, admin: ADMIN_DESTINATIONS.length, variants: variants.map((v) => v.name), findings };
await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`Visited ${visited} live screens (${MEMBER_DESTINATIONS.length} member + ${ADMIN_DESTINATIONS.length} admin x ${variants.length} variants).`);
for (const finding of findings) console.log(`${finding.role} ${finding.destination} @${finding.variant}\n  ` + finding.issues.join("\n  "));
if (findings.length) process.exitCode = 1;
