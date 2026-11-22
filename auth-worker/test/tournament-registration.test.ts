import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";
import { startLiveEvent } from "../src/club-live-routes.js";

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
    expect((await call("/events/7")).data.event).toMatchObject({ pdga_event_id: 104547, entry_fee_cents: 5000, divisions: ["MPO", "MA3"] });
    expect(((await call("/events")).data.events as { id: number; pdga_event_id: number | null }[]).find((event) => event.id === 7)).toMatchObject({ pdga_event_id: 104547 });
    expect((await call("/admin/events/7/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: "abc" } })).data.error).toBe("invalid_pdga_event");
    expect((await call("/admin/events/99/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: 1 } })).status).toBe(404);

    // GET /events/:id/registration strips raw pdga_event from config; switching pdgaEventId while PDGA is down clears old pdga_event.
    expect((await call("/events/7/registration")).data.config.pdga_event).toBeUndefined();
    fakeServices({ pdgaDown: true });
    resetPdgaApiSession();
    const switched = await call("/admin/events/7/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: 204547 } });
    expect(switched.data).toEqual({ pdgaEventId: 204547, pdgaEvent: null });
    fakeServices();
    resetPdgaApiSession();
  });
});

describe("results for PDGA Tournament Manager", () => {
  it("builds PDGA's upload rows from every club event linked to the PDGA event, a round each", async () => {
    await setup();
    db.raw.exec(`INSERT INTO events (id, name, type, status, date) VALUES (8, 'Greenville Fall Classic R2', 'tournament', 'final', '2099-12-13')`);
    expect((await call("/admin/events/8/pdga", { method: "PATCH", token: adminToken, body: { pdgaEventId: 104547 } })).status).toBe(200);
    db.raw.exec(`INSERT INTO registrations (event_id, member_id, name, division, pdga_number, paid_entry) VALUES
      (7, 'm_ada', 'Ada Lovelace', 'MA3', '80024', 1), (7, 'g_cy', 'Cy Young', 'MPO', '70007', 1), (7, 'g_al', 'Al Tie', 'MA3', NULL, 1),
      (7, 'g_dan', 'Dan Dnf', 'MPO', '60006', 1)`);
    db.raw.exec(`INSERT INTO results (event_id, member_id, name, place, total) VALUES
      (7, 'm_ada', 'Ada Lovelace', 1, 54), (8, 'm_ada', 'Ada Lovelace', 1, 52),
      (7, NULL, 'Al  Tie', 2, 55), (8, NULL, 'al tie', 2, 51),
      (7, NULL, 'Cy Young', 1, 50),
      (7, NULL, 'Dan Dnf', 2, 55), (8, NULL, 'Dan Dnf', NULL, 28)`);
    const upload = await call("/admin/events/8/pdga-results", { token: adminToken });
    expect(upload.status).toBe(200);
    expect(upload.data.rounds.map((round: { eventId: number }) => round.eventId)).toEqual([7, 8]);
    expect(upload.data.header).toEqual(["DivCode", "T.O.", "Place", "First Name", "Last Name", "PDGA", "Rd1", "Rd2"]);
    expect(upload.data.rows).toEqual([
      ["MA3", "", "1", "Ada", "Lovelace", "80024", "54", "52"],
      ["MA3", "", "1", "Al", "Tie", "", "55", "51"],
      ["MPO", "", "", "Cy", "Young", "70007", "50", ""],
      ["MPO", "", "", "Dan", "Dnf", "60006", "55", ""],
    ]);
    expect(upload.data).toMatchObject({ players: 4, missingScores: 2, noDivision: 0, noPdga: 1, extraRounds: 0 });
    expect(upload.data.text.split("\n")[0]).toBe("DivCode\tT.O.\tPlace\tFirst Name\tLast Name\tPDGA\tRd1\tRd2");
    expect((await call("/admin/events/8/pdga-results")).status).toBe(401);
    db.raw.exec(`INSERT INTO events (id, name, type, status, date) VALUES (9, 'League night', 'league', 'final', '2099-12-14')`);
    db.raw.exec(`INSERT INTO event_config (event_id) VALUES (9)`);
    expect((await call("/admin/events/9/pdga-results", { token: adminToken })).data.error).toBe("not_pdga_event");

    // Expired cached PDGA player records (>6h) are ignored when building results.
    db.raw.prepare("UPDATE pdga_api_players SET fetched_at = ? WHERE pdga_number = ?").run(Date.now() - 7 * 3_600_000, "80024");
    db.raw.prepare("UPDATE registrations SET name = ? WHERE event_id = 7 AND member_id = ?").run("A. Lovelace", "m_ada");
    const staleIgnored = await call("/admin/events/8/pdga-results", { token: adminToken });
    expect(staleIgnored.data.rows.find((r: string[]) => r[5] === "80024")?.slice(3, 5)).toEqual(["A.", "Lovelace"]);
  });
});

describe("the player list for PDGA Tournament Manager", () => {
  it("paid players in field order, then the waitlist; admin only; only for PDGA events", async () => {
    await setup();
    db.raw.exec(`INSERT INTO registrations (event_id, member_id, name, division, pdga_number, paid_entry, paid_at, waitlisted, waitlisted_at) VALUES
      (7, 'g_b', 'Bo Second', 'MPO', '300', 1, '2026-11-12T10:00:00Z', 0, NULL),
      (7, 'g_a', 'Ada Lovelace', 'MA3', '80024', 1, '2026-11-11T10:00:00Z', 0, NULL),
      (7, 'g_w', 'Wes Wait', 'MPO', NULL, 0, NULL, 1, '2026-11-13T10:00:00Z'),
      (7, 'g_u', 'Una Unpaid', 'MPO', '400', 0, NULL, 0, NULL)`);
    const list = await call("/admin/events/7/pdga-players", { token: adminToken });
    expect(list.status).toBe(200);
    expect(list.data.header).toEqual(["DivCode", "First Name", "Last Name", "PDGA", "Start"]);
    expect(list.data.rows).toEqual([["MA3", "Ada", "Lovelace", "80024", ""], ["MPO", "Bo", "Second", "300", ""], ["MPO", "Wes", "Wait", "", "Waitlist #1"]]);
    expect(list.data).toMatchObject({ registered: 2, waitlisted: 1, unpaid: 1 });
    expect((await call("/admin/events/7/pdga-players")).status).toBe(401);
    db.raw.exec(`INSERT INTO events (id, name, type, status, date) VALUES (9, 'League night', 'league', 'scheduled', '2099-12-14')`);
    db.raw.exec(`INSERT INTO event_config (event_id) VALUES (9)`);
    expect((await call("/admin/events/9/pdga-players", { token: adminToken })).data.error).toBe("not_pdga_event");
  });

  it("strips pdga_event from admin snapshot exports and rejects removed /admin/import/dgs", async () => {
    await setup();
    const exp = await call("/admin/export", { method: "POST", token: adminToken, body: { dry_run: true, includeEventConfig: true } });
    expect(exp.status).toBe(200);
    const configs = exp.data.exportData.tables.event_config as Record<string, unknown>[];
    expect(configs.length).toBeGreaterThan(0);
    expect(configs.every((row) => !("pdga_event" in row))).toBe(true);
    expect((await call("/admin/import/dgs", { method: "POST", token: adminToken, body: {} })).status).toBe(404);
  });
});

describe("PDGA Competition Manual & payment safety (Batch 2)", () => {
  it("prevents waitlist line-jumping, enforces waitlist order & cap in offerSpot, and expires 48h offers", async () => {
    await setup({ playerCap: 1 });
    const paid = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "80024", division: "MPO" } });
    const unoffered = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "90001", division: "MA3" } });
    expect((await payByPaypal(paid.data.guestToken)).status).toBe(200);

    // Next signups enter waitlisted when cap is full.
    const w1 = await call("/events/7/register", { method: "POST", body: { name: "Wait One", division: "MPO" } });
    const w2 = await call("/events/7/register", { method: "POST", body: { name: "Wait Two", division: "MPO" } });
    expect(w1.data.registration.waitlisted).toBe(1);
    expect(w2.data.registration.waitlisted).toBe(1);

    // While the field is full, offerSpot must refuse.
    expect((await call(`/admin/events/7/registrations/${w1.data.registration.id}/offer`, { method: "POST", token: adminToken }))).toMatchObject({ status: 409, data: { error: "field_full" } });

    // Remove the paid player so 1 spot opens; Waitlist #1 (w1) must go first.
    await call(`/admin/events/7/registrations/${paid.data.registration.id}`, { method: "DELETE", token: adminToken });

    // New signup still joins waitlist behind w1/w2; unoffered unpaid player cannot jump the waitlist via PayPal or Zelle.
    const newcomer = await call("/events/7/register", { method: "POST", body: { name: "Line Jumper", division: "MPO" } });
    expect(newcomer.data.registration.waitlisted).toBe(1);
    expect((await call("/events/7/pay/create-order", { method: "POST", body: { guestToken: unoffered.data.guestToken } })).data.error).toBe("field_full");
    const lateSign = await call("/events/7/register", { method: "POST", body: { name: "Zelle Jumper", division: "MPO" } });
    expect(lateSign.data.registration.waitlisted).toBe(1);

    // Offering out-of-order (#2 before #1) is blocked.
    expect((await call(`/admin/events/7/registrations/${w2.data.registration.id}/offer`, { method: "POST", token: adminToken }))).toMatchObject({ status: 409, data: { error: "waitlist_order" } });

    // Offer #1 cleanly.
    const offered = await call(`/admin/events/7/registrations/${w1.data.registration.id}/offer`, { method: "POST", token: adminToken });
    expect(offered.status).toBe(200);
    expect(offered.data.registration.waitlisted).toBe(0);

    // Backdate offered_at > 48h ago: paying is rejected with offer_expired and moves w1 back to waitlist.
    const expiredAt = new Date(Date.now() - 49 * 3_600_000).toISOString();
    db.raw.prepare("UPDATE registrations SET offered_at = ? WHERE id = ?").run(expiredAt, w1.data.registration.id);
    expect((await call(`/events/7/registration?gt=${w1.data.guestToken}`)).data.tournament.offerExpired).toBe(true);
    expect((await call("/events/7/pay/create-order", { method: "POST", body: { guestToken: w1.data.guestToken } }))).toMatchObject({ status: 409, data: { error: "offer_expired" } });
    expect((await call(`/events/7/registration?gt=${w1.data.guestToken}`)).data.registration.waitlisted).toBe(1);

    // Waitlist #2 is now #1 and can be offered the open spot and paid.
    const offer2 = await call(`/admin/events/7/registrations/${w2.data.registration.id}/offer`, { method: "POST", token: adminToken });
    expect(offer2.status).toBe(200);
    expect((await payByPaypal(w2.data.guestToken)).data.registration.paid_entry).toBe(1);
  });

  it("rejects store credit, requires TD email, blocks PayPal fee bypass, and fixes paid add-on check", async () => {
    const missingTd = await call("/admin/events/7/tournament", { method: "PUT", token: adminToken, body: { pdgaEventId: 104547 } });
    expect(missingTd).toMatchObject({ status: 400, data: { error: "td_email_required" } });

    db.raw.exec("UPDATE event_config SET ctp_fee_cents = 300 WHERE event_id = 7");
    await setup({ playerCap: 2 });
    const member = await signSession({ sub: "m_ada", mustChangePin: false }, SECRET, 900);
    await call("/events/7/register", { method: "POST", token: member, body: { division: "MPO" } });

    // Wallet / store credit is rejected for PDGA tournaments.
    const wallet = await call("/events/7/pay/wallet", { method: "POST", token: member, body: {} });
    expect(wallet).toMatchObject({ status: 409, data: { error: "wallet_not_allowed_for_tournament" } });

    // PayPal fee-passthrough bypass prevented: switching to /pay/zelle does not allow capturing a zero-fee $50 order.
    await call("/events/7/pay/zelle", { method: "POST", token: member, body: { donate: false } });
    const partialCapture = await call("/events/7/pay/capture", { method: "POST", token: member, body: { orderId: "ORDER-50.00" } });
    expect(partialCapture).toMatchObject({ status: 402, data: { error: "payment_incomplete" } });

    // Paying full entry + PayPal fee + donation succeeds, then trying to add a $3 CTP pot must fail (fee/donation excluded).
    const order = await call("/events/7/pay/create-order", { method: "POST", token: member, body: { donate: true } });
    const captured = await call("/events/7/pay/capture", { method: "POST", token: member, body: { orderId: order.data.orderId } });
    expect(captured.data.registration).toMatchObject({ paid_entry: 1, fee_cents: 236, donation_cents: 127 });
    const addCtp = await call("/events/7/register", { method: "POST", token: member, body: { division: "MPO", addons: { ctp: true } } });
    expect(addCtp).toMatchObject({ status: 409, data: { error: "paid_addons_locked" } });
  });

  it("limits public field, live scoring, and shotgun holes to paid PDGA registrants, and sets paid_at/pdga_event_id", async () => {
    await setup({ playerCap: 1 });
    const course = db.raw.prepare("INSERT INTO courses (name) VALUES (?) RETURNING id").get("QA Test Course") as { id: number };
    const layout = db.raw.prepare(`INSERT INTO course_layouts (course_id, name, holes, total_par) VALUES (?, 'Main', '[{"hole":1,"par":3},{"hole":2,"par":3}]', 6) RETURNING id`).get(course.id) as { id: number };
    db.raw.prepare("UPDATE events SET course_id = ?, layout_id = ? WHERE id = 7").run(course.id, layout.id);

    const member = await signSession({ sub: "m_ada", mustChangePin: false }, SECRET, 900);
    const ada = await call("/events/7/register", { method: "POST", token: member, body: { division: "MPO" } });
    const unpaid = await call("/events/7/register", { method: "POST", body: { pdgaNumber: "90001", division: "MA3" } });
    expect((await payByPaypal(ada.data.guestToken || "")).status).toBe(401);
    const adaOrder = await call("/events/7/pay/create-order", { method: "POST", token: member, body: {} });
    await call("/events/7/pay/capture", { method: "POST", token: member, body: { orderId: adaOrder.data.orderId } });
    const waitlistGuest = await call("/events/7/register", { method: "POST", body: { name: "Wait Guest", division: "MPO" } });
    expect(waitlistGuest.data.registration.waitlisted).toBe(1);

    // Public field only exposes paid Ada Lovelace (excludes unpaid Bo Burnham and waitlisted Wait Guest).
    const pub = await call("/events/7");
    expect(pub.data.event.field.map((p: { name: string }) => p.name)).toEqual(["Ada Lovelace"]);

    // Shotgun starting holes skip unpaid/waitlisted players on tournaments.
    const holes = await call("/admin/events/7/assign-starting-holes", { method: "POST", token: adminToken, body: { shuffle: false } });
    expect(holes.status).toBe(200);
    const byName = new Map((holes.data.registrations as { name: string; starting_hole: number | null }[]).map((r) => [r.name, r.starting_hole]));
    expect(byName.get("Ada Lovelace")).toBe(1);
    expect(byName.get("Bo Burnham")).toBeNull();
    expect(byName.get("Wait Guest")).toBeNull();

    // Live scoring start seeds only paid players.
    const starts: Record<string, unknown>[] = [];
    const liveEnv = {
      ...env,
      LIVE: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async (_u: string, init?: RequestInit) => {
            starts.push(JSON.parse(String(init?.body || "{}")));
            return Response.json({ status: "live" });
          },
        }),
      },
    } as unknown as Env;
    const started = await startLiveEvent(liveEnv, ORIGIN, 7, {});
    expect(started.status).toBe(200);
    expect((starts[0]?.players as { name: string }[]).map((p) => p.name)).toEqual(["Ada Lovelace"]);

    // /my-registrations includes pdga_event_id; registerMemberStmt sets paid_at; admin PATCH paid clears waitlisted.
    const mine = await call("/my-registrations", { token: member });
    expect(mine.data.registrations[0]).toMatchObject({ event_id: 7, pdga_event_id: 104547 });

    await db.raw.prepare("INSERT INTO events (id, name, type, status, date) VALUES (10, 'Admin Batch', 'tournament', 'scheduled', '2099-12-20')").run();
    const adminAdd = await call("/admin/events/10/registrations", { method: "POST", token: adminToken, body: { member_ids: ["m_ada"], paid_entry: true } });
    expect(adminAdd.status).toBe(200);
    expect(adminAdd.data.registrations[0].paid_at).toBeTruthy();

    const patched = await call(`/admin/events/7/registrations/${waitlistGuest.data.registration.id}`, {
      method: "PATCH", token: adminToken, body: { paid_entry: true },
    });
    expect(patched.data.registration).toMatchObject({ paid_entry: 1, waitlisted: 0 });
    expect(patched.data.registration.paid_at).toBeTruthy();
  });
});
