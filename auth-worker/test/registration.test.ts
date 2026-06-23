import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};
function kv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
// SQL-aware mock parameterized by the event config it returns.
function mockDb(cfg: Record<string, unknown> | null) {
  return { prepare: (sql: string) => ({
    bind() { return this; },
    all: async () => ({ results: [], success: true }),
    first: async () => {
      if (/INSERT INTO event_config/i.test(sql) || /FROM event_config/i.test(sql)) return cfg;
      if (/FROM registrations WHERE id/i.test(sql)) return { id: 1, member_id: "m_jane" };
      if (/INSERT INTO registrations/i.test(sql)) return { id: 1, division: "MA1" };
      if (/UPDATE registrations SET checked_in/i.test(sql)) return { id: 1, checked_in: 1 };
      if (/UPDATE registrations/i.test(sql)) return { id: 1 };
      return null; // getMyRegistration -> not registered
    },
    run: async () => ({ results: [], success: true }),
  }) };
}
const env = (cfg: Record<string, unknown> | null) => ({ ROSTER: kv(members), RATELIMIT: kv(), DB: mockDb(cfg), JWT_SECRET: SECRET, ALLOWED_ORIGINS: "http://localhost:8080", LIVE: undefined } as unknown as Parameters<typeof worker.fetch>[1]);
const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
async function call(path: string, method: string, token: string | undefined, body: unknown, cfg: Record<string, unknown> | null) {
  const h: Record<string, string> = { Origin: "http://localhost:8080" };
  if (token) h.authorization = "Bearer " + token;
  if (body) h["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env(cfg));
}
const OPEN = { registration_open: 1, divisions: '["MA1","MA40"]' };
const CLOSED = { registration_open: 0, divisions: null };

describe("Track G — event registration", () => {
  it("registration requires auth", async () => {
    expect((await call("/events/5/register", "POST", undefined, { division: "MA1" }, OPEN)).status).toBe(401);
  });
  it("rejects registration when closed (403)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), {}, CLOSED)).status).toBe(403);
  });
  it("lets a member register when open (201)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), { division: "MA1" }, OPEN)).status).toBe(201);
  });
  it("rejects a division not in the event config (400)", async () => {
    expect((await call("/events/5/register", "POST", await tok("m_jane"), { division: "NOPE" }, OPEN)).status).toBe(400);
  });
  it("lets a member check in (200)", async () => {
    expect((await call("/events/5/checkin", "POST", await tok("m_jane"), {}, OPEN)).status).toBe(200);
  });
  it("GET /my-registrations is authed (401 without token, 200 with)", async () => {
    expect((await call("/my-registrations", "GET", undefined, undefined, OPEN)).status).toBe(401);
    expect((await call("/my-registrations", "GET", await tok("m_jane"), undefined, OPEN)).status).toBe(200);
  });
  it("admin can set event config + read the roster; non-admin cannot", async () => {
    expect((await call("/admin/events/5/config", "PUT", await tok("m_jane"), { registration_open: true }, OPEN)).status).toBe(403);
    expect((await call("/admin/events/5/config", "PUT", await tok("m_admin"), { registration_open: true, divisions: ["MA1"], entry_fee_cents: 1000 }, OPEN)).status).toBe(200);
    expect((await call("/admin/events/5/registrations", "GET", await tok("m_admin"), undefined, OPEN)).status).toBe(200);
    expect((await call("/admin/events/5/registrations/1", "PATCH", await tok("m_admin"), { checked_in: true, starting_hole: 7 }, OPEN)).status).toBe(200);
  });
});
