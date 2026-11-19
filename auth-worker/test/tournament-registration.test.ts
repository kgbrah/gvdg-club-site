import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";

// Club-run PDGA events registered on the club site, end to end through the routes: PDGA number checks with the
// official API, the event's rules, the field in order of payment with a published cap and waitlist (PDGA
// Competition Manual 1.02), PayPal with the player covering its fee, Zelle confirmed by an admin, and the donation.

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";
const PDGA = "https://api.test.pdga";
const PAYPAL = "https://paypal.test";

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...rows.keys()].filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) raw.exec(readFileSync(new URL(file, dir), "utf8"));
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: raw.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return raw.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = raw.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return stmt;
  };
  return { raw, prepare, async batch(list: { run(): Promise<unknown> }[]) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

const pdgaPlayers: Record<string, Record<string, unknown>> = {
  "80024": { first_name: "Ada", last_name: "Lovelace", pdga_number: "80024", membership_status: "current", rating: "905", rating_effective_date: "2026-11-11" },
  "90001": { first_name: "Bo", last_name: "Burnham", pdga_number: "90001", membership_status: "current", rating: "880", rating_effective_date: "2026-11-11" },
  "70007": { first_name: "Cy", last_name: "Young", pdga_number: "70007", membership_status: "expired" },
};

let captures: string[] = [];
function fakeServices(options: { pdgaDown?: boolean } = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === PDGA) {
      if (options.pdgaDown) return new Response("down", { status: 500 });
      if (url.pathname.endsWith("/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
      if (url.pathname.endsWith("/players")) {
        const numbers = (url.searchParams.get("pdga_number") ?? "").split(",");
        return Response.json({ status: 0, players: numbers.flatMap((n) => pdgaPlayers[n] ? [pdgaPlayers[n]] : []) });
      }
      if (url.pathname.endsWith("/event")) {
        return Response.json({ status: 0, events: [{ tournament_id: "104547", tournament_name: "Greenville Fall Classic", tier: "C", status: "sanctioned",
          start_date: "2026-12-12", end_date: "2026-12-13", city: "Greenville", state_prov: "NC", tournament_director: "Pat TD" }] });
      }
    }
    if (url.origin === PAYPAL) {
      if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "tok" });
      if (url.pathname === "/v2/checkout/orders") {
        const body = JSON.parse(String(init?.body));
        return Response.json({ id: "ORDER-" + body.purchase_units[0].amount.value });
      }
      const capture = url.pathname.match(/^\/v2\/checkout\/orders\/ORDER-([\d.]+)\/capture$/);
      if (capture) {
        captures.push(capture[1]!);
        return Response.json({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP", status: "COMPLETED", amount: { value: capture[1], currency_code: "USD" } }] } }] });
      }
    }
    return new Response("unexpected " + url.href, { status: 599 });
  });
}

let db: Awaited<ReturnType<typeof sqliteDb>>;
let env: Env;
let adminToken: string;

beforeEach(async () => {
  db = await sqliteDb();
  resetPdgaApiSession();
  captures = [];
  const roster = kv({
    "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false, pdgaNo: "" }),
    "member:m_ada": JSON.stringify({ memberId: "m_ada", name: "Ada Lovelace", pinHash: "x", mustChangePin: false, pdgaNo: "80024" }),
  });
  env = {
    DB: db, ROSTER: roster, RATELIMIT: kv(), JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN,
    PDGA_API_USERNAME: "club", PDGA_API_PASSWORD: "pw", PDGA_API_BASE: PDGA,
    PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", PAYPAL_API_BASE: PAYPAL, PAYPAL_FEE_PERCENT: "3.49", PAYPAL_FEE_FIXED_CENTS: "49",
  } as unknown as Env;
  adminToken = await signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
  db.raw.exec(`INSERT INTO events (id, name, type, status, date) VALUES (7, 'Greenville Fall Classic', 'tournament', 'scheduled', '2099-12-12')`);
  db.raw.exec(`INSERT INTO event_config (event_id, registration_open, entry_fee_cents, divisions) VALUES (7, 1, 5000, '["MPO","MA3"]')`);
  fakeServices();
});
afterEach(() => vi.unstubAllGlobals());

async function call(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
  if (options.token) headers.Authorization = "Bearer " + options.token;
  const response = await worker.fetch(new Request("https://worker" + path, {
    method: options.method ?? "GET", headers, body: options.body == null ? undefined : JSON.stringify(options.body),
  }), env);
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function setup(settings: Record<string, unknown> = {}) {
  const saved = await call("/admin/events/7/tournament", { method: "PUT", token: adminToken, body: {
    pdgaEventId: 104547, rules: { nonMemberFeeCents: 1000, divisionLimits: { MA3: 899 } }, paypalFeePassthrough: true,
    zelleTo: "pay@gvdgclub.test", zelleName: "GVDG Club", tdEmail: "td@gvdgclub.test", ...settings,
  } });
  expect(saved.status).toBe(200);
  return saved.data.settings;
}

async function payByPaypal(guestToken: string, donate = false) {
  const order = await call("/events/7/pay/create-order", { method: "POST", body: { guestToken, donate } });
  if (order.status !== 200) return order;
  return call("/events/7/pay/capture", { method: "POST", body: { guestToken, orderId: order.data.orderId } });
}

describe("PDGA event registration on the club site", () => {
  it("links the PDGA event and shows its rules, cap and payment options", async () => {
    const settings = await setup({ playerCap: 72 });
    expect(settings).toMatchObject({ pdgaEventId: 104547, pdgaEvent: { name: "Greenville Fall Classic", tier: "C" }, playerCap: 72,
      paypalFeePassthrough: true, zelleTo: "pay@gvdgclub.test", tdEmail: "td@gvdgclub.test", rules: { nonMemberFeeCents: 1000, divisionLimits: { MA3: 899 } } });
    const page = await call("/events/7/registration");
    expect(page.data.tournament).toMatchObject({
      pdgaEventId: 104547, pdgaEventUrl: "https://www.pdga.com/tour/event/104547", cap: 72, spotsLeft: 72, field: [], waitlist: [],
      payments: { paypalFeeCovered: true, zelle: { to: "pay@gvdgclub.test", name: "GVDG Club" } }, tdEmail: "td@gvdgclub.test",
      attribution: "Player, event, and course data provided by PDGA",
    });
  });

  it("checks PDGA numbers: rating limits per division, the non-member fee, and members-only events", async () => {
    await setup();
    const lookup = await call("/pdga/player?number=80024");
    expect(lookup.data.player).toMatchObject({ name: "Ada Lovelace", rating: 905, membershipStatus: "current", url: "https://www.pdga.com/player/80024" });
    expect((await call("/pdga/player?number=12345")).data.player).toBeNull();

    const tooHigh = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "80024", division: "MA3" } });
    expect(tooHigh).toMatchObject({ status: 403, data: { error: "division_rating_limit", limit: 899, rating: 905 } });
    const guest = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "80024", division: "MPO" } });
    expect(guest.status).toBe(201);
    expect(guest.data.registration).toMatchObject({ name: "Ada Lovelace", pdga_number: "80024", pdga_status: "current", pdga_rating: 905, waitlisted: 0 });
    expect(guest.data.player).toMatchObject({ url: "https://www.pdga.com/player/80024" });
    expect((await call(`/events/7/pay/quote?method=paypal&gt=${guest.data.guestToken}`)).data.quote).toMatchObject({ owedCents: 5000, feeCents: 232, totalCents: 5232 });

    const expired = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "70007", division: "MPO" } });
    expect(expired.data.registration).toMatchObject({ pdga_status: "expired" });
    expect((await call(`/events/7/pay/quote?method=zelle&gt=${expired.data.guestToken}`)).data.quote).toMatchObject({ owedCents: 6000, feeCents: 0, totalCents: 6000 });
    expect((await call("/events/7/register", { method: "POST", body: { pdgaNumber: "12345", division: "MPO", name: "Nobody" } })).data.error).toBe("pdga_not_found");

    await setup({ rules: { membersOnly: true } });
    expect((await call("/events/7/register", { method: "POST", body: { pdgaNumber: "70007", division: "MPO" } })).data.error).toBe("pdga_membership_required");
    expect((await call("/events/7/register", { method: "POST", body: { name: "No Number", division: "MPO" } })).data.error).toBe("pdga_check_required");
  });

  it("fills the field in order of payment, holds the last spot during PayPal checkout, and waitlists the rest", async () => {
    await setup({ playerCap: 1 });
    const ada = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "80024", division: "MPO" } });
    const bo = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "90001", division: "MA3" } });
    expect([ada.data.registration.waitlisted, bo.data.registration.waitlisted]).toEqual([0, 0]); // nobody has paid yet

    // Both reach PayPal; Ada's payment completes first, so Bo's is never charged and Bo goes to the waitlist.
    const adaOrder = await call("/events/7/pay/create-order", { method: "POST", body: { guestToken: ada.data.guestToken } });
    const boOrder = await call("/events/7/pay/create-order", { method: "POST", body: { guestToken: bo.data.guestToken } });
    expect(adaOrder.data.quote.totalCents).toBe(5232);
    const adaPaid = await call("/events/7/pay/capture", { method: "POST", body: { guestToken: ada.data.guestToken, orderId: adaOrder.data.orderId } });
    expect(adaPaid.data.registration).toMatchObject({ paid_entry: 1, payment_method: "paypal", amount_paid_cents: 5232, fee_cents: 232 });
    expect(adaPaid.data.registration.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const boLate = await call("/events/7/pay/capture", { method: "POST", body: { guestToken: bo.data.guestToken, orderId: boOrder.data.orderId } });
    expect(boLate).toMatchObject({ status: 409, data: { error: "field_full" } });
    expect(captures).toEqual(["52.32"]);

    const cy = await call("/events/7/register", { method: "POST", body: { name: "Cy Young", division: "MPO" } });
    expect(cy.data.registration.waitlisted).toBe(1);
    const page = await call("/events/7/registration");
    expect(page.data.tournament).toMatchObject({ spotsLeft: 0, field: [{ name: "Ada Lovelace", division: "MPO" }],
      waitlist: [{ position: 1, name: "Bo Burnham", division: "MA3" }, { position: 2, name: "Cy Young", division: "MPO" }] });
    expect((await call("/events/7/pay/create-order", { method: "POST", body: { guestToken: cy.data.guestToken } })).data.error).toBe("waitlisted");
    expect((await call(`/events/7/registration?gt=${cy.data.guestToken}`)).data.tournament.myWaitlistPosition).toBe(2);

    // A spot opens (an admin removes Ada after her refund): the admin offers it to the first on the waitlist.
    const adaId = adaPaid.data.registration.id;
    expect((await call(`/admin/events/7/registrations/${adaId}`, { method: "DELETE", token: adminToken })).status).toBe(200);
    const boId = bo.data.registration.id;
    expect((await call(`/admin/events/7/registrations/${boId}/offer`, { method: "POST", token: adminToken })).data.registration).toMatchObject({ waitlisted: 0 });
    expect((await call("/events/7/pay/create-order", { method: "POST", body: { guestToken: cy.data.guestToken } })).data.error).toBe("waitlisted");
    const boPaid = await payByPaypal(bo.data.guestToken);
    expect(boPaid.data.registration).toMatchObject({ paid_entry: 1 });
  });

  it("takes Zelle with a memo code and a donation, entered when an admin confirms it arrived", async () => {
    await setup({ playerCap: 2 });
    const ada = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "80024", division: "MPO" } });
    const zelle = await call("/events/7/pay/zelle", { method: "POST", body: { guestToken: ada.data.guestToken, donate: true } });
    expect(zelle.data.zelle).toMatchObject({ to: "pay@gvdgclub.test", name: "GVDG Club", amountCents: 5000 + 184 + 175 });
    expect(zelle.data.zelle.memo).toMatch(/^GV7-\d+[A-Z2-9]{3}$/);
    expect((await call("/events/7/pay/zelle/sent", { method: "POST", body: { guestToken: ada.data.guestToken } })).data.registration.zelle_sent_at).toBeTruthy();
    expect((await call("/events/7/registration")).data.tournament.field).toEqual([]); // not entered until received

    const bo = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "90001", division: "MPO" } });
    expect((await payByPaypal(bo.data.guestToken, true)).data.registration).toMatchObject({ paid_entry: 1, donation_cents: 127 });
    // Ada's Zelle arrived before Bo paid: the admin records when, and the field follows payment order.
    const received = await call(`/admin/events/7/registrations/${ada.data.registration.id}/zelle-received`, {
      method: "POST", token: adminToken, body: { receivedAt: "2026-11-19T08:00:00.000Z" },
    });
    expect(received.data.registration).toMatchObject({ paid_entry: 1, payment_method: "zelle", amount_paid_cents: 5359, paid_at: "2026-11-19T08:00:00.000Z" });
    expect((await call("/events/7/registration")).data.tournament.field.map((row: { name: string }) => row.name)).toEqual(["Ada Lovelace", "Bo Burnham"]);
  });

  it("says when PDGA can't be checked rather than guessing, and lets a signed-in member use their PDGA number", async () => {
    await setup();
    fakeServices({ pdgaDown: true });
    resetPdgaApiSession();
    expect((await call("/events/7/register", { method: "POST", body: { pdgaNumber: "80024", division: "MA3" } })).data.error).toBe("pdga_unavailable");
    fakeServices();
    const member = await signSession({ sub: "m_ada", mustChangePin: false }, SECRET, 900);
    const signedIn = await call("/events/7/register", { method: "POST", token: member, body: { division: "MPO" } });
    expect(signedIn.status).toBe(201);
    expect(signedIn.data.registration).toMatchObject({ member_id: "m_ada", pdga_number: "80024", pdga_status: "current" });
    expect(signedIn.data.guestToken).toBeUndefined();
  });
});

describe("marking an event as a PDGA event from the event form", () => {
  it("links (and unlinks) the PDGA event without touching the other tournament settings, and lists show it", async () => {
    await setup({ playerCap: 50 });
    const unlinked = await call("/admin/events/7/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: null } });
    expect(unlinked.data).toEqual({ pdgaEventId: null, pdgaEvent: null });
    expect((await call("/events/7/registration")).data.tournament).toBeUndefined();
    const linked = await call("/admin/events/7/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: 104547 } });
    expect(linked.data).toMatchObject({ pdgaEventId: 104547, pdgaEvent: { name: "Greenville Fall Classic", tier: "C" } });
    expect((await call("/admin/events/7/tournament", { token: adminToken })).data.settings).toMatchObject({ playerCap: 50, zelleTo: "pay@gvdgclub.test" });
    expect((await call("/events/7")).data.event).toMatchObject({ pdga_event_id: 104547 });
    expect(((await call("/events")).data.events as { id: number; pdga_event_id: number | null }[]).find((event) => event.id === 7)).toMatchObject({ pdga_event_id: 104547 });
    expect((await call("/admin/events/7/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: "abc" } })).data.error).toBe("invalid_pdga_event");
    expect((await call("/admin/events/99/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: 1 } })).status).toBe(404);
  });
});
