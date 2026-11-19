// Every way into the app, end to end (the owner: "Let's test every authentication route… The easiest way to lose
// users is to make the app hard for them to use"). Each sign-in path's session must work everywhere a member goes
// (/me, member routes, the marketplace, notifications, Lost & Found, casual-round scoring), and a revoked session must
// be signed out everywhere — never "signed in" on /me but turned away by the routes (the passkey bug, #146).
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  // The authenticator's signature is the library's job (and its tests); here a registered passkey says yes.
  return {
    ...actual,
    verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 9 } }),
    verifyRegistrationResponse: async () => ({
      verified: true,
      registrationInfo: { credential: { id: "cred-new", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } },
    }),
  };
});

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { hashPin } from "../src/crypto.js";
import { signGuestLink, signSession } from "../src/jwt.js";
import { putMember, type Member } from "../src/roster.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

function memoryKv() {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({ keys: [...rows.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const statement = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get bound() { return bound; },
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number((info as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) } }; },
    };
    return stmt;
  };
  return { raw: db, prepare: statement, async batch(list: Array<ReturnType<typeof statement>>) { return Promise.all(list.map((stmt) => stmt.run())); } };
}

let roster: ReturnType<typeof memoryKv>;
let env: Env;
let mail: Array<{ to: string; subject: string; text: string }>;
let ip = 0;

const PIN = "4821";
async function member(record: Partial<Member> & { memberId: string; name: string }, pin = PIN) {
  await putMember(roster as never, { pinHash: await hashPin(pin), mustChangePin: false, ...record });
}

beforeEach(async () => {
  roster = memoryKv();
  mail = [];
  env = {
    ROSTER: roster, RATELIMIT: memoryKv(), DB: await sqliteDb(), JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN, SESSION_TTL_SEC: "2592000",
    RP_ID: "gvdgclub.com", EXPECTED_ORIGIN: ORIGIN, RESEND_API_KEY: "re_test",
    LIVE: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(JSON.stringify({ status: "none" }), { headers: { "Content-Type": "application/json" } }) }) },
  } as unknown as Env;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      mail.push({ to: body.to?.[0], subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: "m" + mail.length }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  await member({ memberId: "m_1", name: "Avery Admin", pdgaNo: "1", isAdmin: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Move the clock (Date only, so awaits keep running) — token expiry reads `new Date()`, lockouts `Date.now()`. */
function clockAt(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

async function call(path: string, { method = "GET", token, body }: { method?: string; token?: string; body?: unknown } = {}) {
  ip += 1;
  const headers: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "198.51.100." + (ip % 250) };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await worker.fetch(new Request("https://w" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const raw = await response.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data };
}
const login = (identifier: string, pin = PIN) => call("/login", { method: "POST", body: { identifier, pin } });
const admin = () => signSession({ sub: "m_1", mustChangePin: false, pinVer: 0 }, SECRET, 900);

/** The session works everywhere a member goes. */
async function worksEverywhere(token: string, label: string) {
  const me = await call("/me", { token });
  expect(me.status, label + ": /me").toBe(200);
  expect(me.data.mustChangePin, label + ": no PIN change pending").toBe(false);
  expect((await call("/my-registrations", { token })).status, label + ": member routes").toBe(200);
  expect((await call("/me/push-subscription", { token })).status, label + ": notifications").not.toBe(401);
  expect((await call("/market/config", { token })).data.viewer.kind, label + ": marketplace").toBe("member");
  expect((await call("/lost-found/config", { token })).data.viewer.kind, label + ": Lost & Found").toBe("member");
  expect((await call("/rounds/ABCD12/live/mine", { token })).status, label + ": casual-round scoring").not.toBe(401);
}

/** The session is signed out everywhere (the app sees /me 401 and shows sign-in). */
async function signedOutEverywhere(token: string, label: string) {
  expect((await call("/me", { token })).status, label + ": /me").toBe(401);
  expect((await call("/my-registrations", { token })).status, label + ": member routes").toBe(401);
  expect((await call("/market/config", { token })).data.viewer.kind, label + ": marketplace").toBe("public");
  expect((await call("/rounds/ABCD12/live/mine", { token })).status, label + ": scoring").toBe(401);
}

describe("signing in with a PIN", () => {
  it("works with a PDGA # (any formatting), a UDisc name (any case) or an email (any case), everywhere", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", udisc: "JParker" });
    await member({ memberId: "m_e_abc", name: "Drew Guest", email: "drew@example.com", guest: true });
    for (const identifier of ["80024", "#80024", " 80024 ", "jparker", "JPARKER"]) {
      const res = await login(identifier);
      expect(res.status, identifier).toBe(200);
      await worksEverywhere(res.data.token, "PIN sign-in as " + identifier);
    }
    for (const identifier of ["drew@example.com", "DREW@Example.com", " drew@example.com "]) {
      const res = await login(identifier);
      expect(res.status, identifier).toBe(200);
      await worksEverywhere(res.data.token, "email sign-in as " + identifier);
    }
  });

  it("a UDisc name works with or without the @ UDisc shows, and one with digits is never read as someone's PDGA #", async () => {
    await member({ memberId: "m_2019", name: "Old Timer", pdgaNo: "2019" }, "1111");
    await member({ memberId: "m_u_discgolfer2019", name: "Sam Newer", udisc: "discgolfer2019" });
    for (const identifier of ["@jparker", "discgolfer2019", "@DiscGolfer2019"]) {
      if (identifier === "@jparker") continue;
      const res = await login(identifier);
      expect(res.status, identifier).toBe(200);
      expect((await call("/me", { token: res.data.token })).data.name).toBe("Sam Newer");
    }
    await member({ memberId: "m_u_jparker", name: "Jordan Parker", udisc: "JParker" });
    expect((await login("@jparker")).status).toBe(200);
    // Sam's typos don't lock out PDGA #2019, and PDGA #2019 still signs in by number (with or without "PDGA").
    for (let i = 0; i < 5; i++) await login("discgolfer2019", "0000");
    expect((await login("discgolfer2019")).status).toBe(423);
    expect((await login("2019", "1111")).status).toBe(200);
    expect((await login("PDGA #2019", "1111")).status).toBe(200);
    // And someone else with digits in their UDisc name can still apply.
    const applied = await call("/membership/apply", { method: "POST", body: { name: "Rae Third", udisc: "rae2019", pin: "1593", email: "rae@example.com" } });
    expect(applied.status, JSON.stringify(applied.data)).toBe(201);
  });

  it("refuses a wrong PIN or an unknown name the same way (no hint which), and locks after 5 misses for 15 minutes", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const unknown = await login("99999");
    const wrong = await login("80024", "0000");
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.data).toEqual(wrong.data);
    for (let i = 0; i < 4; i++) expect((await login("80024", "0000")).status).toBe(401);
    const locked = await login("80024");
    expect(locked.status).toBe(423);
    expect(locked.data.retryAfterSec).toBeGreaterThan(800);
    // 15 minutes later the right PIN works, and the count starts over.
    clockAt(Date.now() + 901_000);
    const back = await login("80024");
    expect(back.status).toBe(200);
    expect((await login("80024", "0000")).status).toBe(401);
    expect((await login("80024")).status).toBe(200);
  });

  it("every deployed environment keeps sessions 30 days (renewed while the app is used)", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const values = [...toml.matchAll(/^SESSION_TTL_SEC\s*=\s*"(\d+)"/gm)].map((m) => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(new Set(values)).toEqual(new Set(["2592000"]));
  });

  it("stays signed in while the app is used: renewed daily, signed out only after 30 days away", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", email: "jordan@example.com" });
    const start = Date.now();
    const token = (await login("80024")).data.token as string;
    // Same day: no renewal needed.
    expect((await call("/me", { token })).data.token).toBeUndefined();
    // Two weeks of opening the app every few days: each check-in hands back a fresh session.
    let current = token;
    for (const day of [3, 7, 11, 15, 25, 40, 55]) {
      clockAt(start + day * 86400_000);
      const me = await call("/me", { token: current });
      expect(me.status, "day " + day).toBe(200);
      expect(typeof me.data.token, "day " + day).toBe("string");
      current = me.data.token;
    }
    await worksEverywhere(current, "renewed session on day 55");
    // A 12-hour session from before the change is upgraded on its first check-in.
    const legacy = await signSession({ sub: "m_80024", mustChangePin: false, pinVer: 0 }, SECRET, 43200);
    expect(typeof (await call("/me", { token: legacy })).data.token).toBe("string");
    // The original token ended 30 days after sign-in.
    await signedOutEverywhere(token, "the day-0 token on day 55");
    // 30 days without opening the app: signed out.
    clockAt(start + (55 + 31) * 86400_000);
    await signedOutEverywhere(current, "31 days away");
  });
});

describe("PINs", () => {
  it("a new login from an admin: temp PIN -> must choose a PIN (nothing else works yet) -> works everywhere", async () => {
    const created = await call("/admin/members", { method: "POST", token: await admin(), body: { name: "New Player", pdgaNo: "31337" } });
    expect(created.status).toBe(201);
    const first = await login("31337", created.data.tempPin);
    expect(first.status).toBe(200);
    expect(first.data.mustChangePin).toBe(true);
    // Before choosing a PIN, /me answers (so the app can ask for one) and nothing else lets them in.
    expect((await call("/me", { token: first.data.token })).data.mustChangePin).toBe(true);
    expect((await call("/my-registrations", { token: first.data.token })).status).toBe(401);
    // Choosing it doesn't need the temp PIN again.
    const set = await call("/set-pin", { method: "POST", token: first.data.token, body: { newPin: "2468" } });
    expect(set.status).toBe(200);
    await worksEverywhere(set.data.token, "after the first PIN");
    expect((await login("31337", created.data.tempPin)).status).toBe(401);
    expect((await login("31337", "2468")).status).toBe(200);
    // The temp-PIN session is done.
    await signedOutEverywhere(first.data.token, "temp-PIN session");
  });

  it("changing your PIN needs the current one, keeps you signed in, and signs your other phones out", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const phone = (await login("80024")).data.token as string;
    const laptop = (await login("80024")).data.token as string;
    expect((await call("/set-pin", { method: "POST", token: phone, body: { newPin: "1357", currentPin: "0000" } })).status).toBe(401);
    expect((await call("/set-pin", { method: "POST", token: phone, body: { newPin: "1357" } })).status).toBe(401);
    const changed = await call("/set-pin", { method: "POST", token: phone, body: { newPin: "1357", currentPin: PIN } });
    expect(changed.status).toBe(200);
    await worksEverywhere(changed.data.token, "after changing the PIN");
    await signedOutEverywhere(laptop, "the other device");
    await signedOutEverywhere(phone, "the session used to change it");
    expect((await login("80024", PIN)).status).toBe(401);
    expect((await login("80024", "1357")).status).toBe(200);
  });

  it("an admin PIN reset signs every session out and starts the temp-PIN flow", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const before = (await login("80024")).data.token as string;
    const reset = await call("/admin/members/reset-pin", { method: "POST", token: await admin(), body: { identifier: "80024" } });
    expect(reset.status).toBe(200);
    await signedOutEverywhere(before, "after a reset");
    const temp = await login("80024", reset.data.tempPin);
    expect(temp.data.mustChangePin).toBe(true);
    const set = await call("/set-pin", { method: "POST", token: temp.data.token, body: { newPin: "9753" } });
    await worksEverywhere(set.data.token, "after a reset and a new PIN");
  });
});

describe("passkeys", () => {
  it("adding one keeps you signed in; signing in with it works everywhere, before and after a PIN change", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    let token = (await login("80024")).data.token as string;
    const regOptions = await call("/webauthn/register/options", { method: "POST", token });
    expect(regOptions.status, JSON.stringify(regOptions.data)).toBe(200);
    const registered = await call("/webauthn/register/verify", { method: "POST", token, body: { id: "cred-new", rawId: "cred-new", type: "public-key", response: { clientDataJSON: "", attestationObject: "" }, clientExtensionResults: {} } });
    expect(registered.status, JSON.stringify(registered.data)).toBe(200);
    await worksEverywhere(token, "after adding a passkey");
    const passkey = async () => {
      const options = await call("/webauthn/auth/options", { method: "POST", body: {} });
      const verified = await call("/webauthn/auth/verify", {
        method: "POST",
        body: { flowId: options.data.flowId, response: { id: "cred-new", rawId: "cred-new", type: "public-key", response: { userHandle: btoa("m_80024").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), clientDataJSON: "", authenticatorData: "", signature: "" }, clientExtensionResults: {} } },
      });
      expect(verified.status, JSON.stringify(verified.data)).toBe(200);
      return verified.data.token as string;
    };
    await worksEverywhere(await passkey(), "passkey sign-in");
    token = (await call("/set-pin", { method: "POST", token, body: { newPin: "1357", currentPin: PIN } })).data.token;
    await worksEverywhere(await passkey(), "passkey sign-in after a PIN change");
  });
});

describe("joining", () => {
  it("a member application: sign in with the PIN you chose, straight in (no second PIN to choose)", async () => {
    const applied = await call("/membership/apply", { method: "POST", body: { name: "Casey Jones", pdgaNo: "4242", pin: "1593", email: "casey@example.com" } });
    expect(applied.status).toBe(201);
    const approved = await call(`/admin/members/applications/${applied.data.application.id}/approve`, { method: "POST", token: await admin(), body: {} });
    expect(approved.status).toBe(200);
    const res = await login("4242", "1593");
    expect(res.status).toBe(200);
    expect(res.data.mustChangePin).toBe(false);
    await worksEverywhere(res.data.token, "approved member");
  });

  it("a guest application: sign in with your email and the PIN you chose, everywhere a guest goes", async () => {
    const applied = await call("/membership/apply", { method: "POST", body: { kind: "guest", name: "Drew Visitor", email: "Drew@Example.com", phone: "(864) 555-0123", pin: "7531" } });
    expect(applied.status).toBe(201);
    expect((await call(`/admin/members/applications/${applied.data.application.id}/approve`, { method: "POST", token: await admin(), body: {} })).status).toBe(200);
    const res = await login("drew@example.com", "7531");
    expect(res.status).toBe(200);
    expect(res.data.mustChangePin).toBe(false);
    await worksEverywhere(res.data.token, "approved guest");
  });
});

describe("other doors", () => {
  it("a guest promoted to member keeps signing in with their email, and can list", async () => {
    await member({ memberId: "m_e_abc", name: "Drew Guest", email: "drew@example.com", guest: true });
    expect((await call("/admin/members/set-tier", { method: "POST", token: await admin(), body: { memberId: "m_e_abc", tier: "member" } })).status).toBe(200);
    const res = await login("drew@example.com");
    expect(res.status).toBe(200);
    await worksEverywhere(res.data.token, "promoted guest");
    expect((await call("/market/config", { token: res.data.token })).data.viewer.canList).toBe(true);
  });

  it("the sign-in link in a guest's email opens a guest session in a new browser (no second code)", async () => {
    const start = await call("/market/guest/start", { method: "POST", body: { name: "Gail Finder", email: "gail@example.com" } });
    expect(start.status).toBe(200);
    const code = /\b(\d{6})\b/.exec(mail.at(-1)!.text)![1];
    const first = await call("/market/guest/verify", { method: "POST", body: { email: "gail@example.com", code } });
    const guestId = (env.DB as unknown as { raw: { prepare(sql: string): { get(): { id: number } } } }).raw.prepare("SELECT id FROM market_guests").get().id;
    const link = await signGuestLink("mg_" + guestId, SECRET, 14 * 86400);
    const exchanged = await call("/market/guest/link", { method: "POST", body: { token: link } });
    expect(exchanged.status).toBe(200);
    expect((await call("/market/config", { token: exchanged.data.token })).data.viewer).toMatchObject({ kind: "guest", key: (await call("/market/config", { token: first.data.token })).data.viewer.key });
    // A plain guest session or a member session is not a sign-in link.
    expect((await call("/market/guest/link", { method: "POST", body: { token: first.data.token } })).data.error).toBe("link_expired");
    expect((await call("/market/guest/link", { method: "POST", body: { token: await admin() } })).data.error).toBe("link_expired");
  });

  it("a marketplace guest: one emailed code, then a guest session the marketplace and Lost & Found know (never a member session)", async () => {
    const start = await call("/market/guest/start", { method: "POST", body: { name: "Gail Finder", email: "gail@example.com" } });
    expect(start.status).toBe(200);
    const code = /\b(\d{6})\b/.exec(mail.at(-1)!.text)![1];
    const verified = await call("/market/guest/verify", { method: "POST", body: { email: "gail@example.com", code } });
    expect(verified.status).toBe(200);
    const guest = verified.data.token as string;
    expect((await call("/market/config", { token: guest })).data.viewer.kind).toBe("guest");
    expect((await call("/lost-found/config", { token: guest })).data.viewer.kind).toBe("guest");
    expect((await call("/me", { token: guest })).status).toBe(401);
    expect((await call("/my-registrations", { token: guest })).status).toBe(401);
  });

  it("park players scoring without a club login: an open-play session scores rounds and nothing else", async () => {
    const play = await call("/rounds/open-play", { method: "POST", body: { name: "Park Player" } });
    expect(play.status).toBe(200);
    const token = play.data.token as string;
    expect((await call("/rounds/ABCD12/live/mine", { token })).status).not.toBe(401);
    expect((await call("/me", { token })).status).toBe(401);
    expect((await call("/my-registrations", { token })).status).toBe(401);
    expect((await call("/market/config", { token })).data.viewer.kind).toBe("public");
  });

  it("admins: admin pages for an admin, a plain 403 for a member, and demotion takes effect at once", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", isAdmin: true });
    const token = (await login("80024")).data.token as string;
    expect((await call("/admin/members", { token })).status).toBe(200);
    expect((await call("/admin/members/set-tier", { method: "POST", token: await admin(), body: { memberId: "m_80024", tier: "member" } })).status).toBe(200);
    expect((await call("/admin/members", { token })).status).toBe(403);
    await worksEverywhere(token, "a demoted admin is still a member");
  });

  it("changing your PDGA # in your profile: the new one signs you in, the old one doesn't, and you stay signed in", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const token = (await login("80024")).data.token as string;
    expect((await call("/profile", { method: "POST", token, body: { pdgaNo: "80025" } })).status).toBe(200);
    await worksEverywhere(token, "after a profile change");
    expect((await login("80025")).status).toBe(200);
    expect((await login("80024")).status).toBe(401);
  });
});

async function codeFrom(to: string): Promise<string> {
  const message = [...mail].reverse().find((m) => m.to === to);
  expect(message, "an email to " + to).toBeTruthy();
  return /\b(\d{6})\b/.exec(message!.text)![1]!;
}

describe("email on every account (the self-service way back in)", () => {
  it("a member with no email is asked for one, confirms it with a code, and can then sign in with it", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const signedIn = await login("80024");
    expect(signedIn.data).toMatchObject({ needsEmail: true, email: null });
    const token = signedIn.data.token as string;
    // Just signed in: no PIN needed to add it.
    expect((await call("/me/email/start", { method: "POST", token, body: { email: "Jordan@Example.com" } })).status).toBe(200);
    const code = await codeFrom("jordan@example.com");
    expect((await call("/me/email/verify", { method: "POST", token, body: { code: code === "000000" ? "111111" : "000000" } })).data.error).toBe("invalid_code");
    expect((await call("/me/email/verify", { method: "POST", token, body: { code } })).data).toEqual({ email: "jordan@example.com", needsEmail: false });
    expect((await call("/me", { token })).data).toMatchObject({ email: "jordan@example.com", needsEmail: false });
    expect((await login("jordan@example.com")).status).toBe(200);
    // A code works once.
    expect((await call("/me/email/verify", { method: "POST", token, body: { code } })).data.error).toBe("code_expired");
  });

  it("adding the first email never asks for the PIN, even weeks after signing in", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const token = (await login("80024")).data.token as string;
    clockAt(Date.now() + 20 * 86400_000);
    const renewed = (await call("/me", { token })).data.token as string;
    expect((await call("/me/email/start", { method: "POST", token: renewed, body: { email: "jordan@example.com" } })).status).toBe(200);
    expect((await call("/me/email/verify", { method: "POST", token: renewed, body: { code: await codeFrom("jordan@example.com") } })).status).toBe(200);
  });

  it("changing it later needs the PIN or a fresh sign-in (a passkey); the old address is told and stops signing in", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", email: "old@example.com" });
    await putMember(roster as never, { ...(JSON.parse(roster.rows.get("member:m_80024")!) as Member) });
    roster.rows.set("idx:email:old@example.com", "m_80024");
    const token = (await login("80024")).data.token as string;
    clockAt(Date.now() + 2 * 86400_000);
    const renewed = (await call("/me", { token })).data.token as string;
    expect((await call("/me/email/start", { method: "POST", token: renewed, body: { email: "new@example.com" } })).data.error).toBe("pin_required");
    expect((await call("/me/email/start", { method: "POST", token: renewed, body: { email: "new@example.com", pin: "0000" } })).data.error).toBe("wrong_pin");
    expect((await call("/me/email/start", { method: "POST", token: renewed, body: { email: "new@example.com", pin: PIN } })).status).toBe(200);
    expect((await call("/me/email/verify", { method: "POST", token: renewed, body: { code: await codeFrom("new@example.com") } })).status).toBe(200);
    expect(mail.some((m) => m.to === "old@example.com" && /changed/.test(m.subject))).toBe(true);
    expect((await login("old@example.com")).status).toBe(401);
    expect((await login("new@example.com")).status).toBe(200);
    // A fresh sign-in (PIN or the passkey check the app offers) changes it without the PIN.
    const fresh = (await login("new@example.com")).data.token as string;
    expect((await call("/me/email/start", { method: "POST", token: fresh, body: { email: "newer@example.com" } })).status).toBe(200);
  });

  it("refuses an email another account uses, and five wrong codes use the code up", async () => {
    await member({ memberId: "m_e_taken", name: "Taken", email: "taken@example.com", guest: true });
    roster.rows.set("idx:email:taken@example.com", "m_e_taken");
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    const token = (await login("80024")).data.token as string;
    expect((await call("/me/email/start", { method: "POST", token, body: { email: "taken@example.com" } })).data.error).toBe("email_in_use");
    expect((await call("/me/email/start", { method: "POST", token, body: { email: "not an email" } })).data.error).toBe("invalid_email");
    expect((await call("/me/email/start", { method: "POST", token, body: { email: "jordan@example.com" } })).status).toBe(200);
    const code = await codeFrom("jordan@example.com");
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 4; i++) expect((await call("/me/email/verify", { method: "POST", token, body: { code: wrong } })).data.error).toBe("invalid_code");
    expect((await call("/me/email/verify", { method: "POST", token, body: { code: wrong } })).data.error).toBe("code_expired");
    expect((await call("/me/email/verify", { method: "POST", token, body: { code } })).data.error).toBe("code_expired");
  });

  it("an application needs an email (member or guest), and the approved member has it on file", async () => {
    expect((await call("/membership/apply", { method: "POST", body: { name: "Casey Jones", pdgaNo: "4242", pin: "1593" } })).data.error).toBe("email_required");
    const applied = await call("/membership/apply", { method: "POST", body: { name: "Casey Jones", pdgaNo: "4242", pin: "1593", email: "Casey@Example.com" } });
    expect((await call(`/admin/members/applications/${applied.data.application.id}/approve`, { method: "POST", token: await admin(), body: {} })).status).toBe(200);
    expect((await login("4242", "1593")).data).toMatchObject({ needsEmail: false, email: "casey@example.com" });
    expect((await login("casey@example.com", "1593")).status).toBe(200);
  });
});

describe("Forgot PIN", () => {
  it("emails a code, sets the new PIN, signs them in, signs out other phones and lifts a lockout", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", email: "jordan@example.com" });
    const otherPhone = (await login("80024")).data.token as string;
    for (let i = 0; i < 5; i++) await login("80024", "0000");
    expect((await login("80024")).status).toBe(423);
    expect((await call("/pin-reset/start", { method: "POST", body: { identifier: "#80024" } })).data).toMatchObject({ ok: true });
    const code = await codeFrom("jordan@example.com");
    expect(mail.at(-1)!.subject).toMatch(/PIN reset/);
    expect((await call("/pin-reset/verify", { method: "POST", body: { identifier: "80024", code, newPin: "12" } })).data.error).toBe("invalid_pin_format");
    expect((await call("/pin-reset/verify", { method: "POST", body: { identifier: "80024", code: code === "000000" ? "111111" : "000000", newPin: "2580" } })).data.error).toBe("invalid_code");
    const reset = await call("/pin-reset/verify", { method: "POST", body: { identifier: "80024", code, newPin: "2580" } });
    expect(reset.status).toBe(200);
    expect(reset.data).toMatchObject({ mustChangePin: false, name: "Jordan Parker", needsEmail: false });
    await worksEverywhere(reset.data.token, "after a PIN reset");
    await signedOutEverywhere(otherPhone, "the other phone");
    expect((await login("80024", PIN)).status).toBe(401);
    expect((await login("80024", "2580")).status).toBe(200);
    // The code is used up.
    expect((await call("/pin-reset/verify", { method: "POST", body: { identifier: "80024", code, newPin: "1111" } })).data.error).toBe("code_expired");
  });

  it("answers the same for an unknown name or an account with no email, and sends nothing", async () => {
    await member({ memberId: "m_77", name: "No Email", pdgaNo: "77" });
    const unknown = await call("/pin-reset/start", { method: "POST", body: { identifier: "99999" } });
    const noEmail = await call("/pin-reset/start", { method: "POST", body: { identifier: "77" } });
    expect(unknown.status).toBe(200);
    expect(noEmail.data).toEqual(unknown.data);
    expect(mail).toHaveLength(0);
    expect((await call("/pin-reset/verify", { method: "POST", body: { identifier: "99999", code: "123456", newPin: "2580" } })).data.error).toBe("code_expired");
  });

  it("works from an email sign-in name and from a UDisc name", async () => {
    await member({ memberId: "m_u_jparker", name: "Jordan Parker", udisc: "JParker", email: "jordan@example.com" });
    roster.rows.set("idx:email:jordan@example.com", "m_u_jparker");
    for (const identifier of ["@jparker", "Jordan@Example.com"]) {
      expect((await call("/pin-reset/start", { method: "POST", body: { identifier } })).status).toBe(200);
      const res = await call("/pin-reset/verify", { method: "POST", body: { identifier, code: await codeFrom("jordan@example.com"), newPin: "2580" } });
      expect(res.status, identifier).toBe(200);
    }
  });
});

describe("lockouts", () => {
  it("an admin's Clear lockouts lets a locked-out member straight back in (admins only)", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", email: "jordan@example.com" });
    roster.rows.set("idx:email:jordan@example.com", "m_80024");
    for (let i = 0; i < 5; i++) await login("80024", "0000");
    for (let i = 0; i < 5; i++) await login("jordan@example.com", "0000");
    expect((await login("80024")).status).toBe(423);
    expect((await login("jordan@example.com")).status).toBe(423);
    const memberToken = await signSession({ sub: "m_80024", mustChangePin: false, pinVer: 0 }, SECRET, 900);
    expect((await call("/admin/members/clear-locks", { method: "POST", token: memberToken, body: { memberId: "m_80024" } })).status).toBe(403);
    const cleared = await call("/admin/members/clear-locks", { method: "POST", token: await admin(), body: { memberId: "m_80024" } });
    expect(cleared.status).toBe(200);
    expect(cleared.data.cleared).toBeGreaterThanOrEqual(2);
    expect((await login("80024")).status).toBe(200);
    expect((await login("jordan@example.com")).status).toBe(200);
    expect((await call("/admin/members/clear-locks", { method: "POST", token: await admin(), body: { memberId: "m_nobody" } })).status).toBe(404);
  });

  it("PIN prompts don't use up the email step's sends; only codes actually sent count", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024", email: "old@example.com" });
    const old = await signSession({ sub: "m_80024", mustChangePin: false, pinVer: 0, at: Math.floor(Date.now() / 1000) - 86400 }, SECRET, 2592000);
    for (let i = 0; i < 10; i++) {
      expect((await call("/me/email/start", { method: "POST", token: old, body: { email: "new@example.com" } })).data.error).toBe("pin_required");
    }
    for (let i = 0; i < 6; i++) expect((await call("/me/email/start", { method: "POST", token: old, body: { email: "new@example.com", pin: PIN } })).status).toBe(200);
    expect((await call("/me/email/start", { method: "POST", token: old, body: { email: "new@example.com", pin: PIN } })).data.error).toBe("rate_limited");
    // Clear lockouts lifts that too.
    await call("/admin/members/clear-locks", { method: "POST", token: await admin(), body: { memberId: "m_80024" } });
    expect((await call("/me/email/start", { method: "POST", token: old, body: { email: "new@example.com", pin: PIN } })).status).toBe(200);
  });

  it("a correct PIN signs in even if the failed-attempt counter can't be cleared", async () => {
    await member({ memberId: "m_80024", name: "Jordan Parker", pdgaNo: "80024" });
    await login("80024", "0000");
    const limits = env.RATELIMIT as unknown as { delete: (key: string) => Promise<void> };
    const realDelete = limits.delete;
    limits.delete = async () => { throw new Error("KV delete limit reached"); };
    try {
      const res = await login("80024");
      expect(res.status).toBe(200);
      await worksEverywhere(res.data.token, "signed in while deletes fail");
    } finally {
      limits.delete = realDelete;
    }
  });
});

describe("admin lists", () => {
  it("Admin › Members reads member records side by side, a batch at a time (not one after another)", async () => {
    for (let i = 0; i < 60; i++) await putMember(roster as never, { memberId: "m_" + (5000 + i), name: "Player " + i, pdgaNo: String(5000 + i), pinHash: "h", mustChangePin: false });
    let inFlight = 0;
    let most = 0;
    const realGet = roster.get;
    roster.get = async (key: string) => {
      if (!key.startsWith("member:")) return realGet(key);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return realGet(key);
    };
    try {
      const res = await call("/admin/members", { token: await admin() });
      expect(res.status).toBe(200);
      expect(res.data.members).toHaveLength(61);
      expect(res.data.members.map((m: { name: string }) => m.name)).toEqual([...res.data.members.map((m: { name: string }) => m.name)].sort((a: string, b: string) => a.localeCompare(b)));
      expect(most).toBeGreaterThan(1);
      expect(most).toBeLessThanOrEqual(25);
    } finally {
      roster.get = realGet;
    }
  });
});
