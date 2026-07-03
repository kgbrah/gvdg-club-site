import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { jsonObject, objectField } from "./json.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

const SECRET = "x".repeat(40);
const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};
const db = d1Database((sql) =>
  d1Statement({
    all: () => {
      if (/FROM registrations/i.test(sql)) return [{ id: 1, name: "A" }, { id: 2, name: "B" }];
      if (/FROM ctps/i.test(sql)) return [{ id: 1, hole: 7, prize: "disc" }];
      if (/FROM wallet_transactions WHERE event_id/i.test(sql)) return [{ id: 2, event_id: 5, source: "event_payout", amount_cents: 1200 }];
      return [];
    },
    first: () => {
    if (/COUNT\(\*\) AS n/i.test(sql)) return { n: 2 };
    if (/SELECT COALESCE\(SUM\(amount_cents\)/i.test(sql)) return { balance_cents: 1200 };
    if (/SELECT \* FROM wallet_transactions WHERE idempotency_key/i.test(sql)) return null;
    if (/INSERT INTO ctps/i.test(sql)) return { id: 1, hole: 7 };
    if (/UPDATE ctps/i.test(sql)) return { id: 1, hole: 7, winner_member_id: "m_jane", winner_name: "Jane" };
    if (/INSERT INTO wallet_transactions/i.test(sql)) return { id: 2, member_id: "m_jane", amount_cents: 1200, source: "event_payout", event_id: 5 };
    if (/ace_pots/i.test(sql)) return { event_id: 5, carryover_in_cents: 1000, status: "active" };
    if (/FROM event_config/i.test(sql)) return { ace_fee_cents: 300 };
    if (/FROM events(?:\s+e)?/i.test(sql) && /WHERE\s+(?:e\.)?id = \?/i.test(sql)) return { id: 5, layout_id: null };
    if (/UPDATE events/i.test(sql)) return { id: 5, type: "fundraiser", name: "Edited event", status: "scheduled", format: null, date: null, course_id: null, league_id: null, notes: null };
    if (/UPDATE registrations/i.test(sql)) return { id: 1 };
    return null;
  },
  }),
);
const env = (database = db) => workerEnv({ roster: memoryKv(members), db: database, secret: SECRET, origin: "http://localhost:8080" });
const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
async function call(path: string, method = "GET", token?: string, body?: unknown, database = db) {
  const h: Record<string, string> = { Origin: "http://localhost:8080" };
  if (token) h.authorization = "Bearer " + token;
  if (body) h["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env(database));
}

function ctpDeleteDb(ctp: Record<string, unknown> | null, deleteChanges = 1) {
  let deleted = false;
  const database = d1Database((sql) =>
    d1Statement({
      first: () => {
      if (/SELECT \* FROM ctps WHERE id = \? AND event_id = \?/i.test(sql)) return ctp;
      return null;
    },
      run: () => {
      if (/DELETE FROM ctps/i.test(sql)) deleted = true;
      return { changes: deleteChanges };
    },
    }),
  );
  return { database, deleted: () => deleted };
}

describe("Track G G3 — CTPs, ace pots, assignment", () => {
  it("admin adds a CTP (needs a hole); non-admin is blocked", async () => {
    expect((await call("/admin/events/5/ctps", "POST", await tok("m_jane"), { hole: 7 })).status).toBe(403);
    const unconfirmed = await call("/admin/events/5/ctps", "POST", await tok("m_admin"), { hole: 7, prize: "Disc", division: "MA1" });
    expect(unconfirmed.status).toBe(409);
    expect(await jsonObject(unconfirmed)).toMatchObject({ error: "ctp_create_confirmation_required" });

    expect((await call("/admin/events/5/ctps", "POST", await tok("m_admin"), { hole: 7, prize: "Disc", division: "MA1", confirm_ctp_create: true })).status).toBe(201);
    expect((await call("/admin/events/5/ctps", "POST", await tok("m_admin"), { hole: 0, confirm_ctp_create: true })).status).toBe(400);
    expect((await call("/admin/events/5/ctps", "POST", await tok("m_admin"), { prize: "no hole" })).status).toBe(400);
  });
  it("CTPs are public; admin sets a winner", async () => {
    expect((await call("/events/5/ctps")).status).toBe(200);
    const unconfirmed = await call("/admin/events/5/ctps/1", "PATCH", await tok("m_admin"), { winner_name: "A", winner_member_id: "m_a" });
    expect(unconfirmed.status).toBe(409);
    expect(await jsonObject(unconfirmed)).toMatchObject({ error: "ctp_winner_confirmation_required" });

    expect((await call("/admin/events/5/ctps/1", "PATCH", await tok("m_admin"), { winner_name: "A", winner_member_id: "m_a", confirm_ctp_winner_change: true })).status).toBe(200);
  });
  it("admin awards store credit for a CTP without hitting a not-found route", async () => {
    const res = await call("/admin/events/5/ctps/1/store-credit", "POST", await tok("m_admin"), { member_id: "m_jane", amount_cents: 1200, winner_name: "Jane", idempotency_key: "ctp:5:1:m_jane:test", confirm_ctp_store_credit_award: true });
    expect(res.status).toBe(201);
    const body = await jsonObject(res);
    expect(objectField(body, "ctp").winner_member_id).toBe("m_jane");
    expect(objectField(body, "transaction").source).toBe("event_payout");
    expect(body.balance_cents).toBe(1200);
  });
  it("admin must confirm CTP store credit awards", async () => {
    const res = await call("/admin/events/5/ctps/1/store-credit", "POST", await tok("m_admin"), { member_id: "m_jane", amount_cents: 1200, winner_name: "Jane", idempotency_key: "ctp:5:1:m_jane:unconfirmed" });

    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "ctp_store_credit_confirmation_required" });
  });
  it("admin cannot delete a missing CTP", async () => {
    const fixture = ctpDeleteDb(null);
    const res = await call("/admin/events/5/ctps/99", "DELETE", await tok("m_admin"), { confirm_ctp_delete: true }, fixture.database);

    expect(res.status).toBe(404);
    expect(fixture.deleted()).toBe(false);
  });
  it("admin cannot delete a CTP after a winner is recorded", async () => {
    const fixture = ctpDeleteDb({ id: 1, event_id: 5, hole: 7, winner_member_id: "m_jane", winner_name: "Jane" });
    const res = await call("/admin/events/5/ctps/1", "DELETE", await tok("m_admin"), { confirm_ctp_delete: true }, fixture.database);

    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "ctp_delete_blocked", blockers: ["winner"] });
    expect(fixture.deleted()).toBe(false);
  });
  it("admin must confirm CTP delete before a winner is recorded", async () => {
    const fixture = ctpDeleteDb({ id: 1, event_id: 5, hole: 7, winner_member_id: null, winner_name: null });
    const res = await call("/admin/events/5/ctps/1", "DELETE", await tok("m_admin"), undefined, fixture.database);

    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "ctp_delete_confirmation_required" });
    expect(fixture.deleted()).toBe(false);
  });

  it("admin can delete a CTP before a winner is recorded after confirmation", async () => {
    const fixture = ctpDeleteDb({ id: 1, event_id: 5, hole: 7, winner_member_id: null, winner_name: null });
    const res = await call("/admin/events/5/ctps/1", "DELETE", await tok("m_admin"), { confirm_ctp_delete: true }, fixture.database);

    expect(res.status).toBe(200);
    expect(fixture.deleted()).toBe(true);
  });
  it("admin CTP delete is blocked if the row becomes awarded during delete", async () => {
    const fixture = ctpDeleteDb({ id: 1, event_id: 5, hole: 7, winner_member_id: null, winner_name: null }, 0);
    const res = await call("/admin/events/5/ctps/1", "DELETE", await tok("m_admin"), { confirm_ctp_delete: true }, fixture.database);

    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "ctp_delete_blocked", blockers: ["winner"] });
    expect(fixture.deleted()).toBe(true);
  });
  it("ace pot: admin sets carryover; public total = carryover + paid contributors * fee", async () => {
    expect((await call("/admin/events/5/ace-pot", "PUT", await tok("m_admin"), { carryover_in_cents: 1000 })).status).toBe(200);
    const pot = objectField(await jsonObject(await call("/events/5/ace-pot")), "ace_pot");
    expect(pot.total_cents).toBe(1600); // 1000 + 2 contributors * 300
    expect(pot.contributors).toBe(2);
  });
  it("admin assigns shotgun starting holes + teams", async () => {
    expect((await call("/admin/events/5/assign-starting-holes", "POST", await tok("m_admin"), { groupSize: 4, holeCount: 18 })).status).toBe(409);
    expect((await call("/admin/events/5/assign-starting-holes", "POST", await tok("m_admin"), { groupSize: 4, holeCount: 18, confirm_assignment_overwrite: true })).status).toBe(200);
    expect((await call("/admin/events/5/assign-teams", "POST", await tok("m_admin"), { size: 2, confirm_assignment_overwrite: true })).status).toBe(200);
    expect((await call("/admin/events/5/assign-teams", "POST", await tok("m_jane"), { size: 2, confirm_assignment_overwrite: true })).status).toBe(403);
  });
  it("admin assignment rejects invalid sizing", async () => {
    expect((await call("/admin/events/5/assign-starting-holes", "POST", await tok("m_admin"), { groupSize: 0, confirm_assignment_overwrite: true })).status).toBe(400);
    expect((await call("/admin/events/5/assign-starting-holes", "POST", await tok("m_admin"), { groupSize: 13, confirm_assignment_overwrite: true })).status).toBe(400);
    expect((await call("/admin/events/5/assign-starting-holes", "POST", await tok("m_admin"), { holeCount: 99, confirm_assignment_overwrite: true })).status).toBe(400);
    expect((await call("/admin/events/5/assign-teams", "POST", await tok("m_admin"), { size: 0, confirm_assignment_overwrite: true })).status).toBe(400);
    expect((await call("/admin/events/5/assign-teams", "POST", await tok("m_admin"), { size: 13, confirm_assignment_overwrite: true })).status).toBe(400);
    expect((await call("/admin/events/5/assign-teams", "POST", await tok("m_admin"), { count: 1, confirm_assignment_overwrite: true })).status).toBe(400);
  });
  it("admin edits an event type and can clear optional fields", async () => {
    const edited = await call("/admin/events/5", "PATCH", await tok("m_admin"), { type: "fundraiser", name: "Edited event", format: null, date: null, course_id: null, league_id: null, notes: null, confirm_event_details_update: true });
    expect(edited.status).toBe(200);
    const event = objectField(await jsonObject(edited), "event");
    expect(event.type).toBe("fundraiser");
    expect((await call("/admin/events/5", "PATCH", await tok("m_admin"), { type: "side_quest" })).status).toBe(400);
  });
});
