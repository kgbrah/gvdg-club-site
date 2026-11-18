// Browser QA for online dues + welcome (lane D1). Serves the built static site, mocks the Worker API at
// the local API base, and checks: apply form with dues OFF (unchanged) and ON (PayPal SDK stubbed),
// homepage membership block off/on, admin Applications payment chips, the one-time welcome card, and the
// rendered welcome email. Screenshots go to GVDG_DUES_SHOTS (default: the lane folder).
//   npm run build && CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/dues-welcome-browser-qa.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";
import { appHref } from "../../src/shared/app-navigation.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiBase = "http://127.0.0.1:8788";
const shots = process.env.GVDG_DUES_SHOTS || "/home/tpuser/Projects/gvdg-polish-shots/lanes/D1-dues";
const emailPreview = process.env.GVDG_EMAIL_PREVIEW_DIR || "";
await mkdir(shots, { recursive: true });

const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".webmanifest", "application/manifest+json"], [".svg", "image/svg+xml"]]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.join(repoRoot, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(repoRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": (mime.get(path.extname(file)) || "application/octet-stream") + "; charset=utf-8" });
    response.end(body);
  } catch { response.writeHead(404); response.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ...(process.env.GVDG_QA_NO_SANDBOX ? { args: ["--no-sandbox"] } : {}),
});
const errors = [];
const json = (data, status = 200) => ({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(data) });

async function newPage({ width, dark, token } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 920 }, serviceWorkers: "block", isMobile: width < 500, hasTouch: width < 500 });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource|ERR_|favicon|fonts\.g/.test(message.text() + message.location().url)) errors.push(message.text());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page.addInitScript(({ dark, token }) => {
    localStorage.setItem("theme", dark ? "dark" : "light");
    if (token) localStorage.setItem("gvdg_member_token", token);
  }, { dark: Boolean(dark), token: token || "" });
  return { page, context };
}

async function noOverflow(page, label) {
  const m = await page.evaluate(() => ({ w: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
  assert.ok(m.s <= m.w + 1, `${label} overflows: ${JSON.stringify(m)}`);
}

// ---------- apply form: dues OFF (must be exactly the old flow) and ON (PayPal stubbed) ----------
const paypalStub = () => {
  window.paypal = {
    Buttons(opts) {
      return {
        render(host) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "PayPal (stub)";
          button.setAttribute("data-stub-paypal", "1");
          button.style.cssText = "width:100%;min-height:44px;background:#ffc439;border:0;border-radius:4px;font-weight:700";
          button.addEventListener("click", async () => {
            const orderID = await opts.createOrder();
            await opts.onApprove({ orderID });
          });
          host.appendChild(button);
        },
      };
    },
  };
};

async function applyFlow({ on, width, dark }) {
  const { page, context } = await newPage({ width, dark });
  const calls = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ path: url.pathname, method: request.method(), body });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname === "/membership/apply") {
      return route.fulfill(json({
        application: { id: "app1", name: body.name },
        payToken: "tok",
        duesOnline: on,
        duesCents: 1500,
        paypalClientId: on ? "cid" : null,
        pushPublicKey: null,
      }, 201));
    }
    if (url.pathname === "/membership/apply/app1/dues/create-order") return route.fulfill(json({ orderId: "ORDER1", amountCents: 1500 }));
    if (url.pathname === "/membership/apply/app1/dues/capture") return route.fulfill(json({ payment: { status: "paid" } }));
    if (url.pathname === "/membership/apply/app1/dues/other") return route.fulfill(json({ payment: { status: "unpaid", claimedOther: true } }));
    return route.fulfill(json({}, 404));
  });
  if (on) await page.addInitScript(paypalStub);
  await page.goto(`${origin}/gvdg-members.html#apply`, { waitUntil: "domcontentloaded" });
  await page.locator("#applyNameInput").waitFor();
  await page.locator("#applyNameInput").fill("Nina Newbie");
  await page.locator("#applyPdgaInput").fill("123456");
  await page.locator("#applyEmailInput").fill("nina@example.com");
  await page.locator("#applyPinInput").fill("2468");
  await page.locator("#applyConfirmPinInput").fill("2468");
  await noOverflow(page, `apply form ${width}`);
  await page.screenshot({ path: path.join(shots, `apply-form-${on ? "dues-on" : "dues-off"}-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
  await page.getByRole("button", { name: "Submit application" }).click();
  const posted = () => calls.find((c) => c.path === "/membership/apply")?.body;
  await page.waitForFunction(() => document.querySelector("[data-react-apply-submitted]") || /Application sent/.test(document.body.innerText));
  assert.equal(posted().email, "nina@example.com");
  assert.equal(posted().pin, "2468");
  if (!on) {
    // Unchanged flow: straight back to log in with the same message, no dues UI at all.
    await page.getByText("Application sent. After an admin approves you, log in with this PIN.").waitFor();
    assert.equal(await page.locator("[data-react-apply-submitted]").count(), 0);
    assert.equal(await page.locator("[data-stub-paypal]").count(), 0);
    await page.screenshot({ path: path.join(shots, `apply-submitted-dues-off-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
  } else {
    await page.getByRole("heading", { name: "Pay $15 dues" }).waitFor();
    await page.locator("[data-stub-paypal]").waitFor();
    await page.getByRole("button", { name: "I already paid / paying another way" }).waitFor();
    await noOverflow(page, `apply dues step ${width}`);
    await page.screenshot({ path: path.join(shots, `apply-pay-step-dues-on-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    await page.locator("[data-stub-paypal]").click();
    await page.getByText(/Dues paid - thank you/).waitFor();
    const capture = calls.find((c) => c.path.endsWith("/dues/capture"));
    assert.deepEqual(capture.body, { payToken: "tok", orderId: "ORDER1" });
    assert.ok(!JSON.stringify(calls.find((c) => c.path.endsWith("/create-order")).body).includes("amount"), "client must not send an amount");
    await page.screenshot({ path: path.join(shots, `apply-paid-dues-on-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    await page.getByRole("button", { name: "Continue to log in" }).click();
    await page.getByText("Application sent. After an admin approves you, log in with this PIN.").waitFor();
  }
  await context.close();
}

async function payAnotherWay() {
  const { page, context } = await newPage({ width: 390, dark: false });
  const calls = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push(url.pathname);
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname === "/membership/apply") return route.fulfill(json({ application: { id: "app1" }, payToken: "tok", duesOnline: true, duesCents: 1500, paypalClientId: "cid", pushPublicKey: null }, 201));
    if (url.pathname.endsWith("/dues/other")) return route.fulfill(json({ payment: {} }));
    return route.fulfill(json({}, 404));
  });
  await page.addInitScript(paypalStub);
  await page.goto(`${origin}/gvdg-members.html#apply`);
  await page.locator("#applyNameInput").fill("Pat Cash");
  await page.locator("#applyUdiscInput").fill("patcash");
  await page.locator("#applyPinInput").fill("1357");
  await page.locator("#applyConfirmPinInput").fill("1357");
  await page.getByRole("button", { name: "Submit application" }).click();
  await page.getByRole("button", { name: "I already paid / paying another way" }).click();
  await page.getByText(/An admin will confirm your payment/).waitFor();
  assert.ok(calls.some((p) => p.endsWith("/dues/other")));
  await context.close();
}

for (const dark of [true, false]) {
  await applyFlow({ on: false, width: 390, dark });
  await applyFlow({ on: true, width: 390, dark });
}
await payAnotherWay();

// ---------- homepage membership block ----------
for (const on of [false, true]) {
  const { page, context } = await newPage({ width: 390, dark: false });
  await page.route(`${apiBase}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/membership/config") return route.fulfill(json({ duesOnline: on, duesCents: 1500 }));
    return route.fulfill(json({}, 404));
  });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  const block = page.locator("[data-react-home-membership]");
  await block.waitFor();
  if (on) {
    await page.locator("[data-dues-online='true']").waitFor();
    assert.equal(await block.locator("a[href*='paypal.me']").count(), 0);
    await page.getByRole("link", { name: "Apply & pay dues" }).waitFor();
  } else {
    await page.waitForTimeout(400);
    assert.equal(await page.locator("a[href='https://paypal.me/greenvillediscgolf/15']").count(), 1);
    await page.getByRole("link", { name: "Pay with PayPal" }).waitFor();
    assert.equal(await page.locator("[data-dues-online]").count(), 0);
  }
  await block.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await block.screenshot({ path: path.join(shots, `home-membership-${on ? "dues-on" : "dues-off"}-390.png`) });
  await context.close();
}

// ---------- admin Applications payment chips ----------
const iso = new Date().toISOString();
const applications = (duesOnline) => ({
  duesOnline,
  applications: [
    { id: "a1", name: "Paige Paypal", pdgaNo: "111111", createdAt: iso, hasEmail: true, payment: { status: "paid", method: "paypal", amountCents: 1500, paidAt: iso, captureId: "5O190127TN364715T", claimedOther: false } },
    { id: "a2", name: "Cash Carter", udisc: "cashcarter", createdAt: iso, hasEmail: false, payment: { status: "manual", method: "manual", amountCents: 1500, paidAt: iso, markedBy: "Taylor Morgan", note: "cash at league night", claimedOther: false } },
    { id: "a3", name: "Una Unpaid", pdgaNo: "333333", createdAt: iso, hasEmail: true, payment: { status: "unpaid", method: "none", amountCents: 0, claimedOther: false } },
    { id: "a4", name: "Olly Other", pdgaNo: "444444", createdAt: iso, hasEmail: true, payment: { status: "unpaid", method: "none", amountCents: 0, claimedOther: true } },
  ],
});

async function adminApplications({ width, duesOnline, markPaid }) {
  const { page, context } = await newPage({ width, dark: width < 500, token: "qa-admin" });
  const calls = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ path: url.pathname, method: request.method(), body });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname === "/me") return route.fulfill(json({ sub: "m_taylor", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: true }));
    if (url.pathname === "/admin/members/applications") return route.fulfill(json(applications(duesOnline)));
    if (url.pathname === "/admin/members") return route.fulfill(json({ members: [] }));
    if (url.pathname.endsWith("/mark-paid")) return route.fulfill(json({ payment: { status: "manual" } }));
    if (url.pathname === "/events") return route.fulfill(json({ events: [] }));
    return route.fulfill(json({}));
  });
  await page.goto(`${origin}/admin.html${appHref("admin", "applications")}`, { waitUntil: "domcontentloaded" });
  const list = page.locator("[data-react-admin-membership-applications='ready']");
  await list.waitFor({ timeout: 20_000 });
  const chips = await page.locator("[data-admin-payment-chip]").allInnerTexts();
  assert.equal(chips.length, 4);
  if (duesOnline) {
    assert.match(chips[0], /^Paid \$15 · PayPal · .+ · receipt 5O190127TN364715T$/);
    assert.match(chips[1], /^Marked paid \(cash\/other\) by Taylor Morgan · cash at league night/);
    assert.equal(chips[2], "Not paid yet");
    assert.match(chips[3], /^Not paid yet · applicant says/);
  } else {
    assert.equal(chips[2], "Online dues off — confirm payment in PayPal or mark paid manually");
  }
  // Approve stays available for every row regardless of payment.
  assert.equal(await page.locator("[data-admin-application-id] button", { hasText: "Approve" }).count(), 4);
  assert.equal(await page.getByRole("button", { name: "Mark paid (cash/other)" }).count(), 2);
  await noOverflow(page, `admin applications ${width}`);
  await list.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, `admin-applications-${duesOnline ? "dues-on" : "dues-off"}-${width}.png`), fullPage: true });
  if (markPaid) {
    await page.getByRole("button", { name: "Mark paid (cash/other)" }).first().click();
    await page.getByLabel("Payment note for Una Unpaid").fill("check #204");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(400);
    const post = calls.find((c) => c.path === "/admin/members/applications/a3/mark-paid");
    assert.ok(post, "mark-paid posted for the unpaid application");
    assert.deepEqual(post.body, { note: "check #204" });
  }
  await context.close();
}
await adminApplications({ width: 390, duesOnline: true, markPaid: true });
await adminApplications({ width: 1280, duesOnline: true });
await adminApplications({ width: 390, duesOnline: false });
await adminApplications({ width: 1280, duesOnline: false });

// ---------- guest accounts: apply (email + phone required, promo spots), and the admin's view ----------
async function guestApply({ width, dark, left }) {
  const { page, context } = await newPage({ width, dark });
  const calls = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ path: url.pathname, method: request.method(), body });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname === "/membership/guest-spots") return route.fulfill(json({ limit: 100, left }));
    if (url.pathname === "/membership/apply") {
      return route.fulfill(json({ application: { id: "g1", name: body.name, kind: "guest" }, payToken: "tok", duesOnline: false, pushPublicKey: null, guestSpots: { limit: 100, left } }, 201));
    }
    return route.fulfill(json({}, 404));
  });
  await page.goto(`${origin}/gvdg-members.html#apply`, { waitUntil: "domcontentloaded" });
  await page.locator("#applyNameInput").waitFor();
  await page.getByRole("radio", { name: "Guest account" }).click();
  await page.getByText(left ? `${left} of 100 guest spots left` : "All 100 promotional guest spots are taken", { exact: false }).waitFor();
  await page.locator("label[for='applyPdgaInput']", { hasText: "PDGA # (optional)" }).waitFor();
  await page.locator("#applyNameInput").fill("Drew Visitor");
  await page.locator("#applyEmailInput").fill("drew@example.com");
  await page.locator("#applyPinInput").fill("2468");
  await page.locator("#applyConfirmPinInput").fill("2468");
  // The phone is required (the browser's own check is bypassed so ours shows).
  await page.locator("#applyForm").evaluate((form) => { form.noValidate = true; });
  await page.getByRole("button", { name: "Submit application" }).click();
  await page.locator('[data-react-auth-error="apply"]').getByText("Enter a valid phone number.").waitFor();
  await page.locator("#applyPhoneInput").fill("(864) 555-0123");
  await noOverflow(page, `guest apply form ${width}`);
  await page.screenshot({ path: path.join(shots, `apply-guest-${left ? "spots" : "full"}-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
  await page.getByRole("button", { name: "Submit application" }).click();
  await page.getByText("Application sent. After an admin approves you, log in with this PIN.").waitFor();
  const posted = calls.find((c) => c.path === "/membership/apply")?.body;
  assert.deepEqual({ kind: posted.kind, email: posted.email, phone: posted.phone, pdgaNo: posted.pdgaNo, udisc: posted.udisc },
    { kind: "guest", email: "drew@example.com", phone: "(864) 555-0123", pdgaNo: "", udisc: "" });
  // They sign in with the email.
  assert.equal(await page.getByLabel("PDGA #, UDisc username or email").inputValue(), "drew@example.com");
  await context.close();
}
await guestApply({ width: 390, dark: true, left: 37 });
await guestApply({ width: 1280, dark: false, left: 0 });

async function adminGuestApplication() {
  const { page, context } = await newPage({ width: 390, dark: false, token: "qa-admin" });
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (url.pathname === "/me") return route.fulfill(json({ sub: "m_taylor", name: "Taylor Morgan", pdgaNo: "123456", isAdmin: true }));
    if (url.pathname === "/admin/members/applications") {
      return route.fulfill(json({ duesOnline: true, applications: [{ id: "g1", name: "Drew Visitor", pdgaNo: null, udisc: null, createdAt: new Date().toISOString(), kind: "guest",
        contact: { email: "drew@example.com", phone: "+18645550123" }, payment: { status: "unpaid" } }] }));
    }
    if (url.pathname === "/admin/members") return route.fulfill(json({ members: [] }));
    if (url.pathname === "/events") return route.fulfill(json({ events: [] }));
    return route.fulfill(json({}));
  });
  await page.goto(`${origin}/admin.html${appHref("admin", "applications")}`, { waitUntil: "domcontentloaded" });
  const row = page.locator("[data-admin-application-kind='guest']");
  await row.getByText("Drew Visitor - Guest account - drew@example.com - +18645550123").waitFor({ timeout: 20_000 });
  assert.equal(await row.locator("[data-admin-payment-chip]").count(), 0, "guests pay no dues");
  assert.equal(await row.getByRole("button", { name: "Mark paid (cash/other)" }).count(), 0);
  await row.getByRole("button", { name: "Approve" }).waitFor();
  await noOverflow(page, "admin guest application 390");
  await page.screenshot({ path: path.join(shots, "admin-guest-application-390.png"), fullPage: true });
  await context.close();
}
await adminGuestApplication();
console.log("guest accounts: apply with email + phone (spots / full), admin sees a guest application");

// ---------- welcome card ----------
for (const dark of [true, false]) {
  const { page, context } = await newPage({ width: 390, dark, token: "qa-member" });
  await installMemberDashboardApiRoutes(page, apiBase);
  const seen = [];
  await page.route(`${apiBase}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/me") return route.fulfill(json({ sub: "m_new", name: "Nina Newbie", pdgaNo: "123456", isAdmin: false, welcome: true, mustChangePin: false }));
    if (url.pathname === "/me/welcome-seen") { seen.push(route.request().method()); return route.fulfill(json({ ok: true })); }
    return route.fallback();
  });
  await page.goto(`${origin}/gvdg-members.html`, { waitUntil: "domcontentloaded" });
  const card = page.locator("[data-react-welcome-card='ready']");
  await card.waitFor({ timeout: 20_000 });
  await page.getByText("Welcome to the club, Nina!").waitFor();
  await noOverflow(page, "welcome card");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(shots, `welcome-card-390-${dark ? "dark" : "light"}.png`) });
  if (!dark) {
    await page.getByRole("button", { name: "Dismiss welcome" }).click();
    await card.waitFor({ state: "detached" });
    await page.waitForTimeout(200);
    assert.deepEqual(seen, ["POST"]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-react-overview-dashboard]").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("[data-react-welcome-card]").count(), 0, "stays dismissed after reload");
  }
  await context.close();
}

// ---------- rendered welcome email ----------
if (emailPreview) {
  for (const file of ["welcome-email.html", "received-email.html"]) {
    const { page, context } = await newPage({ width: 640, dark: false });
    await page.goto("file://" + path.join(emailPreview, file));
    await page.screenshot({ path: path.join(shots, file.replace(".html", "") + ".png"), fullPage: true });
    const html = await readFile(path.join(emailPreview, file), "utf8");
    assert.ok(!html.includes("2468"), "email must never contain the PIN");
    await context.close();
  }
}

await browser.close();
await new Promise((resolve) => server.close(resolve));
assert.deepEqual(errors, [], "page errors: " + errors.join("\n"));
console.log("dues-welcome browser QA passed; screenshots in " + shots);
