// Browser QA for the self-service way back in (the owner: "require an email so users have a self recovery path"):
//   - a member with no email is asked for one after signing in, confirms it with an emailed code, then reaches Home
//   - later (a renewed session) changing it asks for the PIN first
//   - "Forgot PIN?" on the sign-in screen (and the scoring app) emails a code, sets a new PIN and signs them in
//   - an admin with no email isn't stopped: Home shows a reminder, and the email screen can be cancelled
//   - Edit profile shows the email with "Change email"
//   - an app opened with a day-old session stores the fresh one /me hands back (members and scoring apps)
//   - the member application needs an email
// Serves the built site and mocks the Worker at the local API base.
//   npm run build && GVDG_QA_NO_SANDBOX=1 node scripts/qa/account-recovery-browser-qa.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { installMemberDashboardApiRoutes } from "./members-dashboard-api-routes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiBase = "http://127.0.0.1:8788";
const shots = process.env.GVDG_RECOVERY_SHOTS || path.join(os.tmpdir(), "gvdg-recovery-shots-" + process.pid);
await mkdir(shots, { recursive: true });

const mime = new Map([[".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"], [".webmanifest", "application/manifest+json"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"], [".avif", "image/avif"], [".webp", "image/webp"], [".jpg", "image/jpeg"]]);
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
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (iat, sub = "m_80024") => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, iat })}.sig`;
const nowSec = () => Math.floor(Date.now() / 1000);

const member = { name: "Jordan Parker", pdgaNo: "80024", udisc: null, photo: null, isAdmin: false, mustChangePin: false, welcome: false, membership: null };

async function newPage({ width = 390, dark = false, token = "" } = {}) {
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
    if (token && !sessionStorage.getItem("qa-seeded")) {
      localStorage.setItem("gvdg_member_token", token);
      sessionStorage.setItem("qa-seeded", "1");
    }
  }, { dark, token });
  await installMemberDashboardApiRoutes(page, apiBase);
  return { page, context };
}

/** Override auth routes on top of the dashboard mocks (later routes win). */
async function authRoutes(page, handlers) {
  const calls = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const handler = handlers[`${request.method()} ${pathname}`];
    if (!handler) return route.fallback();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    calls.push({ path: pathname, body, auth: request.headers().authorization || "" });
    const [data, status] = await handler(body, request);
    return route.fulfill(json(data, status));
  });
  return calls;
}

async function noOverflow(page, label) {
  const m = await page.evaluate(() => ({ w: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
  assert.ok(m.s <= m.w + 1, `${label} overflows: ${JSON.stringify(m)}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(shots, name + ".png"), fullPage: false });
}

async function signIn(page, identifier = "80024", pin = "4821") {
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator("#identifierInput").fill(identifier);
  await page.locator("#pinInput").fill(pin);
  await page.locator('[data-react-auth-action="login"]').click();
}

const gate = (page) => page.locator("[data-react-auth-gate]");
const shellIs = (page, view) => page.waitForFunction((v) => document.body.dataset.memberShell === v, view);

// 1. A member with no email: asked right after signing in, confirms with a code, then Home.
for (const dark of [false, true]) {
  const { page, context } = await newPage({ width: 360, dark });
  let saved = false;
  const calls = await authRoutes(page, {
    "POST /login": () => [{ token: jwt(nowSec()), ...member, email: null, needsEmail: true }],
    "GET /me": () => [{ sub: "m_80024", ...member, email: saved ? "jordan@example.com" : null, needsEmail: !saved }],
    "POST /me/email/start": (body) => body.email === "taken@example.com" ? [{ error: "email_in_use" }, 409] : [{ ok: true, expiresInSec: 900 }],
    "POST /me/email/verify": (body) => {
      if (body.code !== "246810") return [{ error: "invalid_code" }, 400];
      saved = true;
      return [{ email: "jordan@example.com", needsEmail: false }];
    },
  });
  await signIn(page);
  await gate(page).and(page.locator('[data-react-auth-gate="email"]')).waitFor();
  assert.equal(await page.locator(".login-title").textContent(), "Add your email");
  assert.ok(await page.locator('[data-react-auth-action="email-signout"]').isVisible(), "the required step offers Sign out");
  assert.equal(await page.locator('[data-react-auth-action="email-cancel"]').count(), 0, "the required step can't be cancelled");
  await noOverflow(page, "email step");
  await shot(page, `email-step-${dark ? "dark" : "light"}`);
  await page.locator("#memberEmailInput").fill("taken@example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('[data-react-auth-error="email"]').filter({ hasText: "another account" }).waitFor();
  await page.locator("#memberEmailInput").fill("Jordan@Example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('#emailForm[data-email-step="code"]').waitFor();
  assert.match(await page.locator("#emailForm .login-subtitle").textContent(), /jordan@example\.com/);
  await page.locator("#memberEmailCodeInput").fill("111111");
  await page.locator('[data-react-auth-action="email-verify"]').click();
  await page.locator('[data-react-auth-error="email"]').filter({ hasText: "didn't match" }).waitFor();
  await noOverflow(page, "email code step");
  await shot(page, `email-code-${dark ? "dark" : "light"}`);
  await page.locator("#memberEmailCodeInput").fill("246810");
  await page.locator('[data-react-auth-action="email-verify"]').click();
  await shellIs(page, "members");
  assert.deepEqual(calls.filter((c) => c.path === "/me/email/start").map((c) => c.body.email), ["taken@example.com", "jordan@example.com"]);
  // Reloading doesn't ask again.
  await page.reload();
  await shellIs(page, "members");
  assert.equal(await page.locator('[data-react-email-reminder]').count(), 0);
  await context.close();
}

// 2. Adding a first email weeks after signing in: no PIN. Changing an existing one: the PIN, or "Use my passkey
//    instead" (a passkey check for this same account), and a wrong PIN doesn't sign them out.
{
  const { page, context } = await newPage({ width: 390, token: jwt(nowSec() - 20 * 86400) });
  const calls = await authRoutes(page, {
    "GET /me": () => [{ sub: "m_80024", ...member, email: null, needsEmail: true }],
    "POST /me/email/start": () => [{ ok: true, expiresInSec: 900 }],
  });
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await page.locator("#memberEmailInput").fill("jordan@example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator('#emailForm[data-email-step="code"]').waitFor();
  assert.equal(await page.locator("#memberEmailPinInput").count(), 0, "no PIN to add a first email");
  assert.equal(calls.filter((c) => c.path === "/me/email/start").length, 1);
  await context.close();
}
for (const passkeyAccount of ["m_80024", "m_someone_else"]) {
  const { page, context } = await newPage({ width: 390, token: jwt(nowSec() - 3600) });
  await page.addInitScript(() => {
    const buf = (n) => new Uint8Array([n, n + 1, n + 2]).buffer;
    navigator.credentials.get = async () => ({
      id: "cred-1", rawId: buf(1), type: "public-key", getClientExtensionResults: () => ({}),
      response: { authenticatorData: buf(2), clientDataJSON: buf(3), signature: buf(4), userHandle: buf(5) },
    });
  });
  const fresh = jwt(nowSec(), passkeyAccount);
  const calls = await authRoutes(page, {
    "GET /me": () => [{ sub: "m_80024", ...member, email: "old@example.com", needsEmail: false }],
    "POST /me/email/start": (body, request) => {
      const signedInJustNow = (request.headers().authorization || "") === "Bearer " + fresh;
      if (!body.pin && !signedInJustNow) return [{ error: "pin_required" }, 403];
      if (body.pin && body.pin !== "4821") return [{ error: "wrong_pin" }, 403];
      return [{ ok: true, expiresInSec: 900 }];
    },
    "POST /webauthn/auth/options": () => [{ options: { challenge: "Y2hhbGxlbmdl", rpId: "127.0.0.1" }, flowId: "flow-1" }],
    "POST /webauthn/auth/verify": () => [{ token: fresh, ...member, email: "old@example.com", needsEmail: false }],
  });
  await page.goto(`${origin}/gvdg-members.html`);
  await shellIs(page, "members");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:member-email-change-requested")));
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await page.locator("#memberEmailInput").fill("new@example.com");
  await page.locator('[data-react-auth-action="email-start"]').click();
  await page.locator("#memberEmailPinInput").waitFor();
  await page.locator('[data-react-auth-error="email"]').filter({ hasText: "use your passkey" }).waitFor();
  const passkeyButton = page.locator('[data-react-auth-action="email-passkey"]');
  await passkeyButton.waitFor();
  if (passkeyAccount === "m_80024") {
    await page.locator("#memberEmailPinInput").fill("0000");
    await page.locator('[data-react-auth-action="email-start"]').click();
    await page.locator('[data-react-auth-error="email"]').filter({ hasText: "didn't match" }).waitFor();
    assert.ok(await page.evaluate(() => localStorage.getItem("gvdg_member_token")), "a wrong PIN keeps them signed in");
    await noOverflow(page, "email change with passkey option");
    await shot(page, "email-change-passkey-option");
    await passkeyButton.click();
    await page.locator('#emailForm[data-email-step="code"]').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("gvdg_member_token")), fresh, "the passkey check's fresh session is kept");
    assert.deepEqual(calls.filter((c) => c.path === "/me/email/start").at(-1).body, { email: "new@example.com" });
  } else {
    await passkeyButton.click();
    await page.locator('[data-react-auth-error="email"]').filter({ hasText: "different account" }).waitFor();
    assert.notEqual(await page.evaluate(() => localStorage.getItem("gvdg_member_token")), fresh, "another account's passkey doesn't switch accounts");
  }
  await context.close();
}

// 3. Forgot PIN from the sign-in screen: code + new PIN, signed straight in.
for (const width of [360, 1280]) {
  const { page, context } = await newPage({ width });
  const fresh = jwt(nowSec(), "m_80024");
  const calls = await authRoutes(page, {
    "POST /pin-reset/start": () => [{ ok: true, expiresInSec: 900 }],
    "POST /pin-reset/verify": (body) => body.code !== "135790" ? [{ error: "invalid_code" }, 400] : [{ token: fresh, ...member, email: "jordan@example.com", needsEmail: false }],
    "GET /me": () => [{ sub: "m_80024", ...member, email: "jordan@example.com", needsEmail: false }],
  });
  await page.goto(`${origin}/gvdg-members.html`);
  await page.locator("#identifierInput").fill("80024");
  await page.locator('[data-react-auth-action="reset-open"]').click();
  await page.locator('[data-react-auth-gate="reset"]').waitFor();
  // Back from Forgot PIN returns to the sign-in screen, still on the member page.
  await page.goBack();
  await page.locator('[data-react-auth-gate="login"]').waitFor();
  assert.match(page.url(), /gvdg-members\.html/);
  await page.locator('[data-react-auth-action="reset-open"]').click();
  await page.locator('[data-react-auth-gate="reset"]').waitFor();
  assert.equal(await page.locator(".login-title").textContent(), "Reset your PIN");
  assert.equal(await page.locator("#resetIdentifierInput").inputValue(), "80024", "the sign-in name carries over");
  await noOverflow(page, `reset start ${width}`);
  await shot(page, `reset-start-${width}`);
  await page.locator('[data-react-auth-action="reset-start"]').click();
  await page.locator('#resetPinForm[data-reset-step="code"]').waitFor();
  await page.locator("#resetCodeInput").fill("000000");
  await page.locator("#resetNewPinInput").fill("2580");
  await page.locator("#resetConfirmPinInput").fill("2581");
  await page.locator('[data-react-auth-action="reset-verify"]').click();
  await page.locator('[data-react-auth-error="reset"]').filter({ hasText: "do not match" }).waitFor();
  await page.locator("#resetConfirmPinInput").fill("2580");
  await page.locator('[data-react-auth-action="reset-verify"]').click();
  await page.locator('[data-react-auth-error="reset"]').filter({ hasText: "didn't match" }).waitFor();
  await noOverflow(page, `reset code ${width}`);
  await shot(page, `reset-code-${width}`);
  await page.locator("#resetCodeInput").fill("135790");
  await page.locator('[data-react-auth-action="reset-verify"]').click();
  await shellIs(page, "members");
  assert.equal(await page.evaluate(() => localStorage.getItem("gvdg_member_token")), fresh);
  assert.deepEqual(calls.filter((c) => c.path === "/pin-reset/verify").at(-1).body, { identifier: "80024", code: "135790", newPin: "2580" });
  await context.close();
}

// 4. The scoring app's sign-in links to Forgot PIN, and the link opens the reset screen.
{
  const { page, context } = await newPage({ width: 390 });
  await page.goto(`${origin}/score.html?event=1`);
  const link = page.getByRole("link", { name: "Forgot PIN?" });
  await link.waitFor();
  assert.match(await link.getAttribute("href"), /gvdg-members\.html#forgot-pin$/);
  await shot(page, "score-signin-forgot");
  await link.click();
  await page.locator('[data-react-auth-gate="reset"]').waitFor();
  await context.close();
}

// 5. An admin with no email isn't stopped: a reminder on Home; the email screen can be cancelled.
{
  const { page, context } = await newPage({ width: 390 });
  await authRoutes(page, {
    "POST /login": () => [{ token: jwt(nowSec(), "m_1"), ...member, name: "Avery Admin", isAdmin: true, email: null, needsEmail: true }],
    "GET /me": () => [{ sub: "m_1", ...member, name: "Avery Admin", isAdmin: true, email: null, needsEmail: true }],
  });
  await signIn(page, "1");
  await shellIs(page, "members");
  const reminder = page.locator("[data-react-email-reminder]");
  await reminder.waitFor();
  await noOverflow(page, "admin home with reminder");
  await shot(page, "admin-email-reminder");
  assert.match(await reminder.textContent(), /Add your email/);
  await reminder.click();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  assert.equal(await page.locator(".login-title").textContent(), "Your email");
  await page.locator('[data-react-auth-action="email-cancel"]').click();
  await shellIs(page, "members");
  // A back swipe on "Your email" (or Edit profile) returns to the app, not out of it.
  const appUrl = page.url();
  await reminder.click();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await page.goBack();
  await shellIs(page, "members");
  assert.equal(page.url(), appUrl, "still in the member app");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:member-edit-profile-requested")));
  await page.locator('[data-react-auth-gate="profile"]').waitFor();
  await page.locator('[data-react-auth-action="email-change"]').click();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await page.goBack();
  await shellIs(page, "members");
  assert.equal(page.url(), appUrl, "one back from two screens deep returns to the app");
  // Closing the screen normally leaves no extra back step behind.
  await reminder.click();
  await page.locator('[data-react-auth-action="email-cancel"]').click();
  await shellIs(page, "members");
  assert.equal(await page.evaluate(() => Boolean(history.state?.gvdgAuthOverlay)), false);
  await context.close();
}

// 6. Edit profile shows the email with "Change email".
{
  const { page, context } = await newPage({ width: 390, token: jwt(nowSec()) });
  await authRoutes(page, { "GET /me": () => [{ sub: "m_80024", ...member, email: "jordan@example.com", needsEmail: false }] });
  await page.goto(`${origin}/gvdg-members.html`);
  await shellIs(page, "members");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gvdg:member-edit-profile-requested")));
  const row = page.locator('[data-profile-email="set"]');
  await row.waitFor();
  assert.match(await row.textContent(), /jordan@example\.com/);
  await shot(page, "profile-email-row");
  await row.getByRole("button", { name: "Change email" }).click();
  await page.locator('[data-react-auth-gate="email"]').waitFor();
  await context.close();
}

// 7. A day-old session is swapped for the fresh one /me hands back (members app, scoring app).
for (const pagePath of ["gvdg-members.html", "score.html"]) {
  const old = jwt(nowSec() - 2 * 86400);
  const renewed = jwt(nowSec());
  const { page, context } = await newPage({ width: 390, token: old });
  await authRoutes(page, { "GET /me": () => [{ sub: "m_80024", ...member, email: "jordan@example.com", needsEmail: false, token: renewed }] });
  await page.goto(`${origin}/${pagePath}`);
  await page.waitForFunction((t) => localStorage.getItem("gvdg_member_token") === t, renewed);
  await context.close();
}

// 8. The member application needs an email.
{
  const { page, context } = await newPage({ width: 360 });
  let applied = 0;
  await authRoutes(page, { "POST /membership/apply": () => { applied += 1; return [{ application: { id: "a1" } }, 201]; } });
  await page.goto(`${origin}/gvdg-members.html#apply`);
  await page.locator("#applyNameInput").fill("Casey Jones");
  await page.locator("#applyPdgaInput, input[name='pdga']").first().fill("4242").catch(() => {});
  const label = page.locator('label[for="applyEmailInput"]');
  assert.equal((await label.textContent()).trim(), "Email");
  assert.equal(await page.locator("#applyEmailInput").getAttribute("required"), "");
  await noOverflow(page, "apply form");
  await shot(page, "apply-email-required");
  assert.equal(applied, 0);
  await context.close();
}

await browser.close();
server.close();
assert.deepEqual(errors, [], "page errors: " + errors.join(" | "));
console.log("PASS account-recovery-browser-qa (" + shots + ")");
