import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const apiBase = "http://127.0.0.1:8788";
const evidenceDir = path.join(repoRoot, ".omo/evidence/members-dashboard-react");
const teeUploadPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=", "base64");

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(repoRoot, normalized);
      if (!filePath.startsWith(repoRoot + path.sep)) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { "Content-Type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(error && error.code === "ENOENT" ? 404 : 500);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function collectPageErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function waitForText(page, selector, expected, label) {
  try {
    await page.waitForFunction(
      ({ selector: query, expected: text }) => document.querySelector(query)?.textContent?.includes(text),
      { selector, expected },
      { timeout: 10_000 },
    );
  } catch {
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(`Timed out waiting for ${label} to include ${expected}. Page text:\n${body}`);
  }
}

async function expectReactTab(page, name) {
  const selected = await page.getByRole("tab", { name }).getAttribute("aria-selected");
  if (selected !== "true") throw new Error(`Expected React tab ${name} to be selected, got ${selected}`);
}

async function captureFullPage(page, filePath) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await page.screenshot({ path: filePath, fullPage: true });
}

async function captureState(browser, origin, viewport, slug) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  const apiState = await installMemberDashboardApiRoutes(page, apiBase);
  await page.addInitScript(() => sessionStorage.setItem("gvdg_member_token", "qa-token"));

  await page.goto(`${origin}/gvdg-members.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#members.members-react-shell-ready", { timeout: 10_000 });
  await page.waitForSelector("#members.members-react-overview-ready", { timeout: 10_000 });
  await page.waitForSelector("#members.members-react-registration-ready", { timeout: 10_000 });
  await page.waitForSelector("#members.members-react-board-ready", { timeout: 10_000 });
  await page.waitForSelector("#members.members-react-tee-signs-ready", { timeout: 10_000 });
  await page.waitForSelector("#members.members-react-club-ready", { timeout: 10_000 });
  await expectReactTab(page, "Overview");
  await page.waitForSelector('[data-react-overview-dashboard="ready"]', { timeout: 10_000 });
  await page.waitForSelector('[data-react-registration-panel="ready"]', { timeout: 10_000 });
  await page.waitForSelector('[data-react-board-panel="ready"]', { state: "attached", timeout: 10_000 });
  await page.waitForSelector('[data-react-tee-signs-panel="ready"]', { state: "attached", timeout: 10_000 });
  await page.waitForSelector('[data-react-club-panel="ready"]', { state: "attached", timeout: 10_000 });
  await page.waitForSelector('[data-react-member-directory="ready"]', { state: "attached", timeout: 10_000 });
  await page.waitForSelector('[data-react-meeting-minutes="ready"]', { state: "attached", timeout: 10_000 });
  await page.waitForSelector('[data-react-pdga-dashboard="ready"]', { timeout: 10_000 });
  await waitForText(page, "#membersReactRatingPanel", "941", "React live rating");
  await page.waitForSelector('[data-react-club-ratings="ready"]', { timeout: 10_000 });
  await page.waitForSelector('[data-react-live-scoring="ready"]', { timeout: 10_000 });
  await page.waitForSelector('[data-react-wallet="ready"]', { timeout: 10_000 });
  await waitForText(page, "[data-react-club-ratings]", "906", "React club ratings");
  await waitForText(page, "[data-react-wallet]", "$12.50", "React wallet balance");
  await waitForText(page, "[data-react-registration-panel]", "GVDG QA Doubles", "React registration event");
  await waitForText(page, "[data-react-registration-panel]", "Warm-up round before league", "React casual round");
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
  await captureFullPage(page, path.join(evidenceDir, `${slug}-overview.png`));

  await page.getByRole("tab", { name: "Events" }).click();
  await waitForText(page, "#membersReactDashboardShell", "Event Registration", "events title");
  await expectReactTab(page, "Events");
  await page.waitForSelector('[data-react-casual-form="ready"]', { timeout: 10_000 });
  await page.locator('[data-react-registration-panel] input[data-register-pair="team"]').waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('[data-react-casual-form] textarea').fill(`QA browser casual ${slug}`);
  await page.getByRole("button", { name: "Post casual round" }).click();
  await page.waitForFunction(
    ({ expected }) => document.querySelector("[data-react-registration-panel]")?.textContent?.includes(expected),
    { expected: `QA browser casual ${slug}` },
    { timeout: 10_000 },
  );
  if (!apiState.casualPostBody || apiState.casualPostBody.course_id !== 1 || apiState.casualPostBody.layout_id !== 11) {
    throw new Error(`Casual round POST body was not captured correctly: ${JSON.stringify(apiState.casualPostBody)}`);
  }
  await page.waitForTimeout(250);
  await captureFullPage(page, path.join(evidenceDir, `${slug}-events.png`));

  await page.getByRole("tab", { name: "Board" }).click();
  await waitForText(page, "#membersReactDashboardShell", "Member Board", "board title");
  await expectReactTab(page, "Board");
  await page.locator('[data-react-board-panel="ready"]').waitFor({ state: "visible", timeout: 10_000 });
  await waitForText(page, "[data-react-board-panel]", "League night", "React board fixture");
  await page.locator("[data-react-board-panel] .board-compose textarea").fill(`QA board post ${slug}`);
  await page.locator("[data-react-board-panel] .board-compose button").click();
  await waitForText(page, "[data-react-board-panel]", `QA board post ${slug}`, "posted board message");
  if (!apiState.boardPostBody || apiState.boardPostBody.body !== `QA board post ${slug}` || apiState.boardPostBody.parent_id !== null) {
    throw new Error(`Board POST body was not captured correctly: ${JSON.stringify(apiState.boardPostBody)}`);
  }
  await page.waitForTimeout(250);
  await captureFullPage(page, path.join(evidenceDir, `${slug}-board.png`));

  await page.getByRole("tab", { name: "Tee Signs" }).click();
  await waitForText(page, "#membersReactDashboardShell", "Tee Sign Capture", "tee signs title");
  await expectReactTab(page, "Tee Signs");
  await page.locator('[data-react-tee-signs-panel="ready"]').waitFor({ state: "visible", timeout: 10_000 });
  await waitForText(page, "[data-react-tee-signs-panel]", "Blue - Par 3", "React tee sign fixture");
  await page.setInputFiles('[data-react-tee-file]', {
    name: "qa-tee-sign.png",
    mimeType: "image/png",
    buffer: teeUploadPng,
  });
  await page.locator("[data-react-tee-signs-panel] .ts-preview").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("[data-react-tee-signs-panel] .passkey-btn").click();
  await waitForText(page, "[data-react-tee-signs-panel]", "Uploaded. Crotts is reading the sign.", "tee upload status");
  await waitForText(page, "[data-react-tee-signs-panel]", "Hole 1", "uploaded tee sign row");
  if (!apiState.teeSignPostBody || apiState.teeSignPostBody.courseId !== 1 || apiState.teeSignPostBody.hole !== 1 || !String(apiState.teeSignPostBody.image || "").startsWith("data:image/jpeg;base64,")) {
    throw new Error(`Tee sign POST body was not captured correctly: ${JSON.stringify(apiState.teeSignPostBody)}`);
  }
  await page.waitForTimeout(250);
  await captureFullPage(page, path.join(evidenceDir, `${slug}-tee.png`));

  await page.getByRole("tab", { name: "Club" }).click();
  await waitForText(page, "#membersReactDashboardShell", "GVDG Member Directory", "club title");
  await expectReactTab(page, "Club");
  await page.locator('[data-react-club-panel="ready"]').waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#doublesLeague").waitFor({ state: "visible", timeout: 10_000 });
  const clubPanel = page.locator('[data-react-club-panel]');
  await waitForText(page, "[data-react-club-panel]", "Membership Growth Since 2004", "React club growth chart");
  await waitForText(page, "[data-react-club-panel]", "Future Course Improvements - Ayden", "React meeting minutes");
  await clubPanel.locator(".members-search").fill("Martinez");
  await waitForText(page, "[data-react-club-panel] .members-grid", "Juan Martinez", "React directory search");
  await waitForText(page, "[data-react-club-panel] .members-count", "Showing 1 of 1 members", "React directory search count");
  await clubPanel.locator(".members-search").fill("");
  await clubPanel.getByRole("button", { name: "PDGA Members" }).click();
  await waitForText(page, "[data-react-club-panel] .members-count", "Showing 12 of", "React directory PDGA filter count");
  await clubPanel.getByRole("button", { name: "All Members" }).click();
  await waitForText(page, "[data-react-club-panel] .members-count", "Showing 12 of", "React directory all count");
  await clubPanel.getByRole("button", { name: /Show More/ }).click();
  await waitForText(page, "[data-react-club-panel] .members-count", "Showing 24 of", "React directory load more count");
  const minutesToggle = clubPanel.getByRole("button", { name: /January 12, 2026/ });
  if (await minutesToggle.getAttribute("aria-expanded") !== "true") throw new Error("React meeting minutes did not start expanded.");
  await minutesToggle.click();
  if (await minutesToggle.getAttribute("aria-expanded") !== "false") throw new Error("React meeting minutes did not collapse.");
  await minutesToggle.click();
  if (await minutesToggle.getAttribute("aria-expanded") !== "true") throw new Error("React meeting minutes did not re-expand.");
  await page.waitForTimeout(250);
  await captureFullPage(page, path.join(evidenceDir, `${slug}-club.png`));

  const overflow = await page.evaluate(() => {
    const y = window.scrollY;
    window.scrollTo(9999, y);
    const x = window.scrollX;
    window.scrollTo(0, y);
    return x;
  });
  if (overflow > 1) {
    const offenders = await page.evaluate(() => {
      return [...document.querySelectorAll("body *")].map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          id: node.id || "",
          className: String(node.className || ""),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      }).filter((row) => row.right > window.innerWidth + 1 || row.left < -1).slice(0, 8);
    });
    throw new Error(`${slug} has horizontal overflow of ${overflow}px: ${JSON.stringify(offenders)}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  await context.close();
}

const staticServer = await startStaticServer();
const browser = await chromium.launch({ headless: true });

try {
  await mkdir(evidenceDir, { recursive: true });
  await captureState(browser, staticServer.origin, { width: 390, height: 844 }, "mobile");
  await captureState(browser, staticServer.origin, { width: 768, height: 1024 }, "tablet");
  await captureState(browser, staticServer.origin, { width: 1280, height: 900 }, "desktop");
} finally {
  await browser.close();
  await staticServer.close();
}

console.log("members dashboard browser QA passed");
