import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

const SECRET = "x".repeat(40);
const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};
function mockDb(cfg: Record<string, unknown> | null, status = "scheduled", schedule: Record<string, unknown> = {}): D1Database {
  const event = { status, ...schedule };
  const myRegistration = {
    id: 1,
    event_id: 5,
    member_id: "m_jane",
    name: "Jane",
    division: "MA1",
    checked_in: 0,
    addons: "{}",
    paid_entry: 0,
    event_name: "July Flex Doubles",
    date: "2026-07-04",
    starts_at: "2026-07-04T13:00:00.000Z",
    registration_deadline: schedule.registration_deadline ?? "2026-07-03T20:00:00.000Z",
    checkin_deadline: schedule.checkin_deadline ?? "2026-07-04T12:30:00.000Z",
    type: "tournament",
    status,
    event_format: "matchplay",
    course_id: 2,
    layout_id: 7,
    course_name: "West Meadowbrook",
    layout_name: "Gold",
    total_par: 54,
    entry_fee_cents: 1000,
    ctp_fee_cents: 200,
    ace_fee_cents: 300,
    divisions: '["MA1"]',
    play_format: "doubles",
  };
  return d1Database((sql) =>
    d1Statement({
      all: () => {
        if (/FROM registrations r\s+JOIN events e/i.test(sql)) return [myRegistration];
        return [];
      },
      first: () => {
      if (/SELECT status(?:, starts_at, registration_deadline, checkin_deadline)? FROM events/i.test(sql)) return event;
      if (/INSERT INTO event_config/i.test(sql) || /FROM event_config/i.test(sql)) return cfg;
      if (/FROM registrations WHERE id/i.test(sql)) return { id: 1, member_id: "m_jane" };
      // getMyRegistration (SELECT * FROM registrations WHERE event_id = ? AND member_id = ?): returns an
      // existing registration only when the test asks for one, so we can exercise the edit-vs-new paths.
      if (/SELECT \* FROM registrations WHERE event_id/i.test(sql)) return schedule.existingReg ? { id: 1, member_id: "m_jane", division: "MA1", paid_entry: 0, amount_paid_cents: 0, checked_in: 0, addons: "{}" } : null;
      if (/INSERT INTO registrations/i.test(sql)) return { id: 1, division: "MA1" };
      if (/UPDATE registrations SET checked_in/i.test(sql)) return { id: 1, checked_in: 1 };
      if (/UPDATE registrations/i.test(sql)) return { id: 1 };
      return null; // getMyRegistration -> not registered
      },
    }),
  );
}
const env = (cfg: Record<string, unknown> | null, status = "scheduled", schedule: Record<string, unknown> = {}) => workerEnv({ roster: memoryKv(members), db: mockDb(cfg, status, schedule), secret: SECRET, origin: "http://localhost:8080" });
const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
async function call(path: string, method: string, token: string | undefined, body: unknown, cfg: Record<string, unknown> | null, status = "scheduled", schedule: Record<string, unknown> = {}) {
  const h: Record<string, string> = { Origin: "http://localhost:8080" };
  if (token) h.authorization = "Bearer " + token;
  if (body) h["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env(cfg, status, schedule));
}
const OPEN = { registration_open: 1, divisions: '["MA1","MA40"]' };
const CLOSED = { registration_open: 0, divisions: null };
const pastIso = () => new Date(Date.now() - 60_000).toISOString();

describe("Track G — event registration", () => {
  it("a guest registration needs a name (400), then succeeds (201) with a returned guest token", async () => {
    expect((await call("/events/5/register", "POST", undefined, { division: "MA1" }, OPEN)).status).toBe(400); // no name
    const res = await call("/events/5/register", "POST", undefined, { division: "MA1", name: "Pat Guest", email: "pat@example.com" }, OPEN);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { guestToken?: string };
    expect(typeof body.guestToken).toBe("string");
    expect((body.guestToken || "").length).toBeGreaterThan(8);
  });
  it("a guest can check in and withdraw with their token; members do not need one", async () => {
    expect((await call("/events/5/checkin", "POST", undefined, { guestToken: "abc123" }, OPEN)).status).toBe(200);
    expect((await call("/events/5/register?gt=abc123", "DELETE", undefined, null, OPEN)).status).toBe(200);
    expect((await call("/events/5/checkin", "POST", undefined, {}, OPEN)).status).toBe(401); // no member, no token
  });
  it("paying entry online still requires a member (guests pay at the event)", async () => {
    expect((await call("/events/5/pay/create-order", "POST", undefined, {}, OPEN)).status).toBe(401);
  });
  it("rejects registration when closed (403)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), {}, CLOSED)).status).toBe(403);
  });
  it("rejects registration after the registration deadline even when open (403)", async () => {
    const res = await call("/events/5/register", "POST", await tok("m_jane"), {}, OPEN, "scheduled", { registration_deadline: pastIso() });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "registration_closed" });
  });
  it("lets a member register when open (201)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), { division: "MA1" }, OPEN)).status).toBe(201);
  });
  it("lets an EXISTING registrant edit their entry after the registration deadline (deadline closes only new sign-ups)", async () => {
    const res = await call("/events/5/register", "POST", await tok("m_jane"), { division: "MA1" }, OPEN, "scheduled", { registration_deadline: pastIso(), existingReg: true });
    expect(res.status).toBe(201); // edit allowed despite the passed deadline (new sign-ups would be 403)
  });
  it("rejects a division not in the event config (400)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), { division: "NOPE" }, OPEN)).status).toBe(400);
  });
  it("rejects registration for a cancelled/finalized event even if registration_open lingers (403)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), { division: "MA1" }, OPEN, "cancelled")).status).toBe(403);
    expect((await call("/events/5/register", "POST", await tok("m_jane"), { division: "MA1" }, OPEN, "final")).status).toBe(403);
  });
  it("lets a member check in (200)", async () => {
    expect((await call("/events/5/checkin", "POST", await tok("m_jane"), {}, OPEN)).status).toBe(200);
  });
  it("rejects player check-in after the check-in deadline (403)", async () => {
    const res = await call("/events/5/checkin", "POST", await tok("m_jane"), {}, OPEN, "scheduled", { checkin_deadline: pastIso() });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "checkin_closed" });
  });
  it("GET /my-registrations is authed (401 without token, 200 with)", async () => {
    expect((await call("/my-registrations", "GET", undefined, undefined, OPEN)).status).toBe(401);
    const res = await call("/my-registrations", "GET", await tok("m_jane"), undefined, OPEN);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      registrations: [
        {
          event_id: 5,
          event_name: "July Flex Doubles",
          date: "2026-07-04",
          starts_at: "2026-07-04T13:00:00.000Z",
          registration_deadline: "2026-07-03T20:00:00.000Z",
          checkin_deadline: "2026-07-04T12:30:00.000Z",
          status: "scheduled",
          event_format: "matchplay",
          play_format: "doubles",
          course_name: "West Meadowbrook",
          layout_name: "Gold",
        },
      ],
    });
  });
  it("admin can set event config + read the roster; non-admin cannot", async () => {
    expect((await call("/admin/events/5/config", "PUT", await tok("m_jane"), { registration_open: true }, OPEN)).status).toBe(403);
    expect((await call("/admin/events/5/config", "PUT", await tok("m_admin"), { registration_open: true, divisions: ["MA1"], entry_fee_cents: 1000, confirm_event_config_update: true }, OPEN)).status).toBe(200);
    expect((await call("/admin/events/5/registrations", "GET", await tok("m_admin"), undefined, OPEN)).status).toBe(200);
    expect((await call("/admin/events/5/registrations/1", "PATCH", await tok("m_admin"), { checked_in: true, starting_hole: 7 }, OPEN)).status).toBe(200);
  });
});
