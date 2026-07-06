import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DEFAULT_SITE_URL = "https://gvdgclub.com";
const DEFAULT_API_URL = "https://auth.gvdgclub.com";
const TOKEN_KEY = "gvdg_member_token";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

function env(name) {
  return (process.env[name] || "").trim();
}

function loadDeployEnv() {
  const file = path.join(repoRoot, ".gvdg-deploy.env");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function cleanUrl(value, fallback) {
  return (value || fallback).replace(/\/+$/, "");
}

function jsonHeaders(token) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

async function requestJson(apiBase, path, options = {}) {
  const headers = jsonHeaders(options.token);
  const init = {
    method: options.method || "GET",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs || 15_000),
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(apiBase + path, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data && typeof data.error === "string" ? data.error : text.slice(0, 200);
    throw new Error(`API ${init.method} ${path} failed with ${response.status}: ${message}`);
  }
  return data;
}

async function qaToken(apiBase) {
  const token = env("GVDG_STAGING_QA_TOKEN");
  if (token) return token;

  const identifier = env("GVDG_STAGING_QA_IDENTIFIER");
  const pin = env("GVDG_STAGING_QA_PIN");
  if (!identifier || !pin) {
    throw new Error("Set GVDG_STAGING_QA_TOKEN, or GVDG_STAGING_QA_IDENTIFIER plus GVDG_STAGING_QA_PIN.");
  }

  const data = await requestJson(apiBase, "/login", {
    method: "POST",
    body: { identifier, pin },
  });
  if (!data || typeof data.token !== "string") throw new Error("Login succeeded without a token.");
  return data.token;
}

function collectPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function usefulStats(apiBase, pdgaNo) {
  const data = await requestJson(apiBase, `/pdga-stats?pdga=${encodeURIComponent(pdgaNo)}`);
  if (data?.live_rating == null) {
    throw new Error(
      `QA member PDGA #${pdgaNo} has no live dashboard rating. Run npm run qa:ensure-staging-dashboard-data.`,
    );
  }
}

async function waitForText(page, selector, expected, label) {
  try {
    await page.waitForFunction(
      ({ selector: query, expected: text }) => document.querySelector(query)?.textContent?.includes(text),
      { selector, expected },
      { timeout: 15_000 },
    );
  } catch {
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`Timed out waiting for ${label} to include ${expected}. Page text:\n${body}`);
  }
}

async function waitForLiveRating(page) {
  try {
    await page.waitForFunction(
      () => /^\d{3,4}$/.test(document.querySelector("[data-react-live-rating] .dash-tile-num")?.textContent?.trim() || ""),
      null,
      { timeout: 15_000 },
    );
  } catch {
    const body = await page.locator("body").innerText().catch(() => "");
    const actual = await page.locator("[data-react-live-rating] .dash-tile-num").innerText().catch(() => "<missing>");
    throw new Error(`Expected a numeric React live rating, got ${actual.trim()}. Page text:\n${body}`);
  }
  return (await page.locator("[data-react-live-rating] .dash-tile-num").innerText()).trim();
}

async function expectReactTab(page, name) {
  const selected = await page.getByRole("tab", { name }).getAttribute("aria-selected");
  if (selected !== "true") throw new Error(`Expected React tab ${name} to be selected, got ${selected}`);
}

async function runBrowserQa({ siteUrl, token }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await page.addInitScript(
      ({ key, value }) => sessionStorage.setItem(key, value),
      { key: TOKEN_KEY, value: token },
    );

    await page.goto(`${siteUrl}/gvdg-members.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#members.members-react-shell-ready", { timeout: 15_000 });
    await page.waitForSelector("#members.members-react-overview-ready", { timeout: 15_000 });
    await page.waitForSelector("#members.members-react-registration-ready", { timeout: 15_000 });
    await page.waitForSelector("#members.members-react-board-ready", { timeout: 15_000 });
    await page.waitForSelector("#members.members-react-tee-signs-ready", { timeout: 15_000 });
    await page.waitForSelector("#members.members-react-club-ready", { timeout: 15_000 });
    await waitForText(page, "#membersReactDashboardShell", "Player Dashboard", "React dashboard title");
    await expectReactTab(page, "Overview");
    await page.locator('[data-react-overview-dashboard="ready"]').waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-react-registration-panel="ready"]').waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-react-board-panel="ready"]').waitFor({ state: "attached", timeout: 15_000 });
    await page.locator('[data-react-tee-signs-panel="ready"]').waitFor({ state: "attached", timeout: 15_000 });
    await page.locator('[data-react-club-panel="ready"]').waitFor({ state: "attached", timeout: 15_000 });
    await page.locator('[data-react-pdga-dashboard="ready"]').waitFor({ state: "visible", timeout: 15_000 });

    const legacyTabsHidden = await page.locator("#dashTabs").evaluate((node) => getComputedStyle(node).display === "none");
    if (!legacyTabsHidden) throw new Error("Legacy dashboard tabs were visible after React shell mounted.");
    for (const selector of ["#legacyDashboardHead", "#legacyPdgaDashboard", "#clubRatings", "#liveScoring", "#legacyDashboardActions", "#clubWallet"]) {
      const hidden = await page.locator(selector).evaluate((node) => getComputedStyle(node).display === "none");
      if (!hidden) throw new Error(`${selector} remained visible after React overview mounted.`);
    }
    for (const selector of ["#legacyRegisterTitle", "#registerList"]) {
      const hidden = await page.locator(selector).evaluate((node) => getComputedStyle(node).display === "none");
      if (!hidden) throw new Error(`${selector} remained visible after React registration mounted.`);
    }
    for (const selector of ["#legacyBoardPanel", "#legacyTeeSignsPanel"]) {
      const hidden = await page.locator(selector).evaluate((node) => getComputedStyle(node).display === "none");
      if (!hidden) throw new Error(`${selector} remained visible after its React panel mounted.`);
    }
    for (const selector of ["#legacyClubDirectoryPanel", "#legacyMeetingMinutesPanel"]) {
      const hidden = await page.locator(selector).evaluate((node) => getComputedStyle(node).display === "none");
      if (!hidden) throw new Error(`${selector} remained visible after React Club mounted.`);
    }

    await waitForLiveRating(page);

    await page.getByRole("tab", { name: "Events" }).click();
    await waitForText(page, "#membersReactDashboardShell", "Event Registration", "events tab title");
    await expectReactTab(page, "Events");
    const registerVisible = await page.locator("#clubRegister").evaluate((node) => !node.classList.contains("dtab-off"));
    if (!registerVisible) throw new Error("Events tab did not reveal the registration panel.");
    await page.locator('[data-react-casual-form="ready"]').waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("tab", { name: "Board" }).click();
    await waitForText(page, "#membersReactDashboardShell", "Member Board", "board tab title");
    await expectReactTab(page, "Board");
    const boardVisible = await page.locator("#clubBoard").evaluate((node) => !node.classList.contains("dtab-off"));
    if (!boardVisible) throw new Error("Board tab did not reveal the message board.");
    await page.locator('[data-react-board-panel="ready"]').waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("tab", { name: "Tee Signs" }).click();
    await waitForText(page, "#membersReactDashboardShell", "Tee Sign Capture", "tee signs tab title");
    await expectReactTab(page, "Tee Signs");
    const teeSignsVisible = await page.locator("#teeCapture").evaluate((node) => !node.classList.contains("dtab-off"));
    if (!teeSignsVisible) throw new Error("Tee Signs tab did not reveal the capture panel.");
    await page.locator('[data-react-tee-signs-panel="ready"]').waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("tab", { name: "Club" }).click();
    await waitForText(page, "#membersReactDashboardShell", "GVDG Member Directory", "club tab title");
    await expectReactTab(page, "Club");
    await page.locator('[data-react-club-panel="ready"]').waitFor({ state: "visible", timeout: 15_000 });
    const clubVisible = await page.locator("#membersReactClubPanel").evaluate((node) => !node.classList.contains("dtab-off"));
    if (!clubVisible) throw new Error("Club tab did not reveal the React member directory.");
    await waitForText(page, "[data-react-club-panel]", "Membership Growth Since 2004", "React club growth chart");
    await waitForText(page, "[data-react-club-panel]", "Future Course Improvements - Ayden", "React meeting minutes");
    const clubPanel = page.locator('[data-react-club-panel]');
    await clubPanel.locator(".members-search").fill("Martinez");
    await waitForText(page, "[data-react-club-panel] .members-grid", "Juan Martinez", "React directory search");
    await clubPanel.locator(".members-search").fill("");
    await clubPanel.getByRole("button", { name: "PDGA Members" }).click();
    await waitForText(page, "[data-react-club-panel] .members-count", "Showing 12 of", "React directory PDGA filter count");
    await clubPanel.getByRole("button", { name: "All Members" }).click();
    await clubPanel.getByRole("button", { name: /Show More/ }).click();
    await waitForText(page, "[data-react-club-panel] .members-count", "Showing 24 of", "React directory load more count");

    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewport = page.viewportSize()?.width || 390;
    if (width > viewport + 1) throw new Error(`Members dashboard has horizontal overflow: ${width}px > ${viewport}px.`);
    if (errors.length) throw new Error(errors.join("\n"));
    await context.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  loadDeployEnv();
  const siteUrl = cleanUrl(env("GVDG_STAGING_SITE_URL"), DEFAULT_SITE_URL);
  const apiBase = cleanUrl(env("GVDG_STAGING_API_URL"), DEFAULT_API_URL);
  const token = await qaToken(apiBase);
  const member = await requestJson(apiBase, "/me", { token });
  if (!member || typeof member.name !== "string") throw new Error("QA token did not resolve to a named member.");
  if (!member.pdgaNo) throw new Error("QA member has no linked PDGA number. Run npm run qa:ensure-staging-dashboard-data.");

  await usefulStats(apiBase, member.pdgaNo);
  await runBrowserQa({ siteUrl, token });
  console.log("staging member dashboard E2E passed");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
