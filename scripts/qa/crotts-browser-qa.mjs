import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const screenshots = process.env.GVDG_CROTTS_SCREENSHOTS || "/tmp/gvdg-crotts-qa";
await mkdir(screenshots, { recursive: true });
const paths = { "/index.html": "home", "/events.html": "public", "/gvdg-members.html": "members", "/admin.html": "admin", "/score.html": "score" };
const built = await build({ configFile: false, logLevel: "silent",
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  build: { write: false, rolldownOptions: {
    input: Object.fromEntries(Object.values(paths).map((app) => [app, `src/${app}-app/main.js`])),
    output: { entryFileNames: "[name]-fixture.js" },
  } },
});
const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => result.output);
const bundles = new Map(outputs.map((file) => ["/" + file.fileName, file.type === "chunk" ? file.code : file.source]));
const html = new Map(await Promise.all(Object.entries(paths).map(async ([path, app]) => [path,
  (await readFile("." + path, "utf8"))
    .replace(/src="(?:home|public|members|admin|score)-app\/[^\"]+"/, `src="/${app}-fixture.js"`)
    .replace(/<link[^>]+https:[^>]+>/g, "")
    .replace(/<script[^>]+src="pwa\.js[^\"]*"[^>]*><\/script>/, "")
    .replace(/<body\b([^>]*)>/, (_match, attrs) => '<body data-api-base="/fixture-api" data-auth-base="/fixture-api"' + attrs.replace(/ data-(?:api|auth)-base="[^"]*"/g, "") + '>'),
])));
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  try {
    if (!html.has(path) && !bundles.has(path) && !/^\/(?:img\/[\w/.-]+|src\/shared\/[\w.-]+|[\w-]+\.css)$/.test(path)) return response.writeHead(404).end();
    if (path.includes("..")) return response.writeHead(404).end();
    const value = html.get(path) ?? bundles.get(path) ?? await readFile("." + path);
    response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream" }).end(value);
  } catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const success = {
  reply: "The next round is listed on the Events page. Check the schedule for the start time and layout.",
  actions: [
    { href: "https://example.invalid", label: "External action" },
    { href: "javascript:alert(1)", label: "Script action" },
    { href: "score.html?event=4&token=private", label: "Private parameters" },
    { href: "events.html#event/42", label: "Open the next event" },
    { href: "events.html#event/42", label: "Duplicate event" },
  ],
};
const testPhoto = { name: "test-lie.jpg", mimeType: "image/jpeg", buffer: await readFile("img/crotts.jpg") };
const answer = (reply, status = 200) => ({ status, json: reply });

async function openPage(path, width, { mode = "light", scale = 1, isAdmin = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width > 600 ? 900 : 720 }, colorScheme: mode, serviceWorkers: "block" });
  const requests = [];
  const errors = [];
  let respond = async (route) => route.fulfill(answer(success));
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/fixture-api/")) return route.continue();
    const endpoint = url.pathname.slice("/fixture-api".length);
    if (endpoint === "/assistant") {
      assert.equal(route.request().method(), "POST");
      requests.push(route.request().postDataJSON());
      return respond(route);
    }
    if (endpoint === "/me") return route.fulfill(answer({ sub: "m_fixture", name: "Taylor Morgan", isAdmin }));
    if (endpoint.endsWith("/live/mine")) {
      const hole = { hole: 1, par: 3, distance_ft: 282, tee: { lat: 35, lng: -82 }, target: { lat: 35.0006, lng: -82 } };
      const player = { index: 0, name: "Taylor Morgan", cardId: "c0", isMe: true, canEnterScorecard: true, startingHole: 1, scores: {}, scorecards: {} };
      return route.fulfill(answer({ status: "live", roundCode: "QA44", recoveryRoundId: "qa-help-round", rev: 1, holes: [hole],
        players: [player], cardmates: [player], cardId: "c0", playerIndex: 0, courseName: "Rocky Ford", layoutName: "Long tees", missing: [] }));
    }
    return route.fulfill(answer({ events: [], courses: [], rounds: [], rows: [], devices: [], orders: [] }));
  });
  await context.routeWebSocket("**/fixture-api/**", () => {});
  await context.addInitScript(({ mode, scale }) => {
    localStorage.setItem("gvdg_member_token", "qa-crotts-token");
    localStorage.setItem("gvdg_member_name", "Taylor Morgan");
    localStorage.setItem("theme", mode);
    if (scale !== 1) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
  }, { mode, scale });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /CrottsWidget|CrottsHelpLink/.test(message.text())) errors.push(message.text());
  });
  await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  const help = page.getByRole("dialog", { name: "Crotts assistant" });
  const control = (name) => help.getByRole("button", { name, exact: true });
  const input = help.getByRole("textbox", { name: "Message Crotts" });
  const title = help.getByRole("heading", { name: "Crotts assistant" });
  const close = control("Close Crotts assistant");
  const attach = control("Attach a photo or video of the lie");
  const send = control("Send");
  const remove = control("Remove attachment");
  const focused = (locator) => locator.evaluate((element) => element === document.activeElement).then((active) => assert.ok(active));
  const focusSettled = (locator) => locator.evaluate((element) => element.matches(":focus"));
  async function finishOpen() {
    await help.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Crotts assistant");
    await page.waitForFunction(() => document.querySelector("#crotts-panel")?.getAttribute("aria-modal") === "true");
    assert.equal(await help.getAttribute("aria-modal"), "true");
    assert.equal(await page.locator(".crotts-overlay").evaluate((overlay) => overlay.parentElement === document.body), true);
    assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
    const inertBackground = await page.evaluate(() => [...document.body.children]
      .filter((child) => !child.matches(".crotts-overlay,#gvdg-a11y-announcer,script,style,link"))
      .every((child) => child.hasAttribute("inert")));
    assert.equal(inertBackground, true);
    const frame = await help.evaluate((panel) => {
      const { top, bottom } = panel.getBoundingClientRect();
      const heading = panel.querySelector("#crotts-head").getBoundingClientRect();
      const composer = panel.querySelector("#crotts-form").getBoundingClientRect();
      const overlay = Number(getComputedStyle(panel.parentElement).zIndex);
      const dock = document.querySelector("body > .admin-dock, body > .member-nav-dock");
      return { topGap: heading.top - top, bottomGap: bottom - composer.bottom, aboveDock: !dock || overlay > Number(getComputedStyle(dock).zIndex) };
    });
    assert.ok(frame.topGap <= 2 && frame.bottomGap <= 2 && frame.aboveDock, "dialog chrome fits its panel and stays above the dock");
    await page.evaluate(() => document.fonts.ready);
  }
  async function verifyClosed(opener) {
    await help.waitFor({ state: "detached" });
    await page.waitForFunction(() => !document.body.style.overflow);
    assert.equal(await focusSettled(opener), true);
    // The dialog isolates body siblings. Inactive carousel slides intentionally
    // remain inert after Help closes so offscreen course controls stay untabbable.
    assert.equal(await page.evaluate(() => [...document.body.children].some((node) => node.hasAttribute("inert"))), false);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".carousel-slide-courses[aria-hidden='true']")]
      .every((node) => node.hasAttribute("inert"))), true);
  }
  async function screenshot(label) { await page.screenshot({ path: join(screenshots, label + ".png"), animations: "disabled" }); }
  return { page, context, requests, errors, help, control, input, title, close, attach, send, remove, focused, finishOpen, verifyClosed, screenshot,
    respondWith(next) { respond = next; } };
}

async function verifyMembers() {
  const view = await openPage("/gvdg-members.html#home", 320, { mode: "dark", scale: 1.3 });
  const { page, context, help, input, close, attach, send, remove, requests } = view;
  try {
    const opener = page.getByRole("link", { name: "Help", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await view.finishOpen();
    await page.keyboard.press("Shift+Tab");
    await view.focused(input);
    await page.keyboard.press("Tab");
    await view.focused(close);
    assert.equal(await send.isDisabled(), true);
    await view.screenshot("help-member-320-large-dark");
    const initial = await Promise.all([page.waitForEvent("filechooser"), attach.click()]);
    await initial[0].setFiles([]);
    assert.equal(await remove.count(), 0);
    assert.equal(await send.isDisabled(), true);
    await help.locator("input[type=file]").setInputFiles(testPhoto);
    await help.getByText("Photo attached", { exact: true }).waitFor();
    const replacement = await Promise.all([page.waitForEvent("filechooser"), attach.click()]);
    await replacement[0].setFiles([]);
    await help.getByText("Photo attached", { exact: true }).waitFor();
    await remove.click();
    await view.focused(attach);
    assert.equal(await send.isDisabled(), true);
    assert.equal(requests.length, 0);
    await help.locator("input[type=file]").setInputFiles({ name: "unreadable.jpg", mimeType: "image/jpeg", buffer: Buffer.from("invalid image") });
    await help.getByRole("alert").getByText(/read that file/).waitFor();
    await help.locator("input[type=file]").setInputFiles(testPhoto);
    await help.getByText("Photo attached").waitFor();
    await input.fill("Where is the next round?");
    let release;
    const pending = new Promise((done) => { release = done; });
    view.respondWith(async (route) => { await pending; return route.abort("connectionreset"); });
    await Promise.all([page.waitForRequest((request) => request.url().endsWith("/assistant")), input.press("Enter")]);
    const sending = view.control("Sending");
    await sending.waitFor();
    assert.equal(await sending.isDisabled(), true);
    assert.equal(await attach.isDisabled(), true);
    assert.equal(await input.getAttribute("readonly"), "");
    await input.press("Enter");
    await page.waitForRequest((request) => request.url().endsWith("/assistant"), { timeout: 400 }).catch(() => {});
    assert.equal(requests.length, 1);
    await view.screenshot("help-member-upload-pending");
    release();
    await help.getByRole("alert").getByText(/connect to Crotts/).waitFor();
    assert.equal(await input.inputValue(), "Where is the next round?");
    await help.getByText("Photo attached", { exact: true }).waitFor();
    await view.screenshot("help-member-retry");
    view.respondWith(async (route) => route.fulfill(answer({ error: "rate_limited" }, 429)));
    await send.click();
    await help.getByRole("alert").getByText(/minute/).waitFor();
    view.respondWith(async (route) => route.fulfill(answer(success)));
    await send.click();
    await help.getByText(success.reply).waitFor();
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[1], requests[2]);
    assert.equal(requests[0].mediaKind, "photo");
    assert.ok(requests[0].images[0].startsWith("data:image/jpeg;base64,"));
    assert.deepEqual(requests[0].history, []);
    assert.equal(await input.inputValue(), "");
    assert.equal(await remove.count(), 0);
    assert.equal(await help.getByRole("link").count(), 1);
    assert.equal(await help.getByRole("link", { name: "Open the next event" }).getAttribute("href"), "events.html#event/42");
    await view.screenshot("help-member-response");
    await page.setViewportSize({ width: 320, height: 460 });
    const geometry = await help.evaluate((panel) => {
      const r = panel.getBoundingClientRect();
      const composer = panel.querySelector("#crotts-form").getBoundingClientRect();
      const buttons = [...panel.querySelectorAll("button,[href],textarea")].filter((element) => element.getClientRects().length)
        .map((element) => [element.getBoundingClientRect().width, element.getBoundingClientRect().height]);
      const thread = panel.querySelector("#crotts-thread");
      return { left: r.left, right: r.right, bottom: composer.bottom, buttons, threadScrolls: thread.scrollHeight > thread.clientHeight };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= 320 && geometry.bottom <= 460);
    assert.ok(geometry.threadScrolls);
    for (const [width, height] of geometry.buttons) assert.ok(width >= 44 && height >= 44);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
    await view.screenshot("help-member-short-viewport");
    await page.setViewportSize({ width: 320, height: 720 });
    await page.keyboard.press("Escape");
    await view.verifyClosed(opener);
    await opener.click();
    await view.finishOpen();
    await help.getByText(success.reply).waitFor();
    await input.fill("Is it open to guests?");
    await send.click();
    await page.waitForFunction(() => document.querySelector("#crotts-input")?.value === "");
    assert.deepEqual(requests.at(-1).history, [
      { role: "user", content: "Where is the next round?\nPhoto attached" }, { role: "assistant", content: success.reply },
    ]);
    const frames = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 48;
      const context = canvas.getContext("2d");
      context.fillRect(0, 0, 48, 48);
      const stream = canvas.captureStream(15);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      const data = new Promise((done) => { recorder.ondataavailable = (event) => done(event.data); });
      recorder.start();
      for (let index = 0; index < 12; index++) {
        context.clearRect(0, 0, 48, 48);
        context.fillRect(index, 3, 20, 20);
        await new Promise((done) => setTimeout(done, 65));
      }
      recorder.stop();
      const video = await data;
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await video.arrayBuffer()));
    });
    await help.locator("input[type=file]").setInputFiles({ name: "lie.webm", mimeType: "video/webm", buffer: Buffer.from(frames) });
    await help.getByText(/^Video frames? attached$/).waitFor();
    await send.click();
    await help.getByRole("log").getByText(/^Video frames? attached$/).waitFor();
    assert.equal(requests.at(-1).mediaKind, "video");
    assert.ok(requests.at(-1).images.every((frame) => frame.startsWith("data:image/jpeg;base64,")));
    assert.ok(requests.at(-1).images.length > 0);
    await close.click();
    await view.verifyClosed(opener);
    assert.deepEqual(view.errors, []);
  } finally { await context.close(); }
}

async function verifyOpeners() {
  for (const [path, width, caption] of [["/index.html", 1280, "home-desktop"], ["/events.html", 390, "public-phone"],
    ["/score.html?round=QA44", 390, "score-phone"], ["/admin.html#today", 390, "admin-phone"]]) {
    const view = await openPage(path, width, { isAdmin: path.startsWith("/admin") });
    const { page, context } = view;
    try {
      let opener = page.getByRole("link", { name: "Help", exact: true });
      let restore = opener;
      if (caption === "home-desktop") {
        restore = page.getByRole("button", { name: "More", exact: true });
        await restore.click();
      } else if (caption === "public-phone") {
        restore = page.getByRole("button", { name: "Open menu", exact: true });
        await restore.click();
      } else if (caption === "score-phone") {
        await page.getByRole("button", { name: "Round tools" }).waitFor();
        opener = page.getByRole("button", { name: "Help", exact: true });
        restore = opener;
      }
      await opener.click();
      await view.finishOpen();
      await view.screenshot("help-" + caption);
      await page.keyboard.press("Escape");
      await view.verifyClosed(restore);
      if (caption === "admin-phone") {
        const finder = page.getByRole("searchbox", { name: "Find a tool" });
        await finder.fill("Crotts");
        await page.getByRole("button", { name: "Help", exact: true }).click();
        await view.finishOpen();
        await page.keyboard.press("Escape");
        await view.verifyClosed(finder);
      }
      if (caption === "score-phone") {
        const tools = page.getByRole("button", { name: "Round tools", exact: true });
        await tools.click();
        const sheet = page.getByRole("dialog", { name: "Round tools" });
        await sheet.waitFor();
        const cardLink = sheet.getByRole("button", { name: "Full scorecard", exact: true });
        await cardLink.focus();
        await cardLink.evaluate((control) => window.dispatchEvent(new CustomEvent("gvdg:help-request", { detail: { returnFocus: () => control } })));
        await view.finishOpen();
        await page.keyboard.press("Escape");
        await view.help.waitFor({ state: "detached" });
        await sheet.waitFor();
        await view.focused(cardLink);
        assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
        await page.keyboard.press("Escape");
        await view.verifyClosed(tools);
      }
      assert.equal(view.requests.length, 0);
      assert.deepEqual(view.errors, []);
    } finally { await context.close(); }
  }
}

try {
  await verifyMembers();
  await verifyOpeners();
  console.log("Crotts Help verified across public, member, admin and scoring entry points.");
  console.log("Screenshots " + screenshots);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
