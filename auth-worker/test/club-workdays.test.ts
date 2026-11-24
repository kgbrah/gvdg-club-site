import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { easternTodayIso } from "../src/club-workdays.js";
import { signSession } from "../src/jwt.js";
import { karmaKey } from "../src/karma-directory.js";
import { karmaOf } from "../src/lf-store.js";

const SECRET = "w".repeat(40);
const ORIGIN = "https://gvdgclub.com";
const MIGRATIONS = new URL("../migrations/", import.meta.url);

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...rows.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    raw.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
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
  return {
    raw,
    prepare,
    async batch(list: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  };
}

const member = (memberId: string, name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ memberId, name, pinHash: "x", mustChangePin: false, ...extra });

let env: Env;
let db: Awaited<ReturnType<typeof sqliteDb>>;

beforeEach(async () => {
  db = await sqliteDb();
  const roster: Record<string, string> = {
    "member:m_admin": member("m_admin", "Club Admin", { isAdmin: true }),
    "member:m_ada": member("m_ada", "Ada Lovelace"),
    "member:m_grace": member("m_grace", "Grace Hopper"),
    "member:m_linus": member("m_linus", "Linus Torvalds"),
    "member:m_held1": member("m_held1", "Held Member", { held: true }),
  };
  for (let i = 0; i < 26; i += 1) {
    const id = `m_extra_${String(i).padStart(2, "0")}`;
    roster["member:" + id] = member(id, `Volunteer ${i}`);
  }
  db.raw.prepare("INSERT INTO courses (id, name, lat, lng, is_default) VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lng = excluded.lng")
    .run(1, "Meadowbrook Park", 35.6127, -77.3664);

  env = {
    DB: db,
    RATELIMIT: kv(),
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    ROSTER: kv(roster),
  } as unknown as Env;
});

async function call(path: string, options: { sub?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
  if (options.sub) headers.Authorization = "Bearer " + await signSession({ sub: options.sub, mustChangePin: false }, SECRET, 900);
  const response = await worker.fetch(new Request("https://worker" + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body == null ? undefined : JSON.stringify(options.body),
  }), env, { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: response.status, data: await response.json() as Record<string, any> };
}

describe("club workday organizer: announce, notify, home roster, GPS check-in, and admin karma verification", () => {
  it("announces a workday to >25 active members (skipping held), lists all signups privately on Member Home, verifies GPS + admin, and awards karma", async () => {
    expect((await call("/workdays")).status).toBe(401);
    expect((await call("/admin/workdays", { sub: "m_ada" })).status).toBe(403);

    // Admin announces a future workday tied to course #1 with +35 karma reward.
    const created = await call("/admin/workdays", {
      sub: "m_admin",
      method: "POST",
      body: {
        title: "Spring Mulch & Tee Pad Clean-up",
        courseId: 1,
        workdayDate: "2099-05-16",
        startTime: "9:00 AM",
        karmaReward: 35,
        radiusFt: 1500,
        description: "Bring gloves and rakes.",
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.workday).toMatchObject({
      title: "Spring Mulch & Tee Pad Clean-up",
      locationName: "Meadowbrook Park",
      karmaReward: 35,
      radiusFt: 1500,
      hasGps: true,
      checkinOpen: false,
    });
    // 1 admin + 3 core members + 26 extra active members = 30 active members notified; held account skipped.
    expect(created.data.notifiedCount).toBe(30);
    const notices = db.raw.prepare("SELECT member_id, kind, title, body, href FROM member_notices WHERE ref_key = ?")
      .all(`workday-announce-${created.data.workday.id}`) as { member_id: string; kind: string; title: string; body: string; href: string }[];
    expect(notices).toHaveLength(30);
    expect(notices.some((n) => n.member_id === "m_held1")).toBe(false);
    expect(notices[0]).toMatchObject({
      kind: "workday",
      title: "Workday: Spring Mulch & Tee Pad Clean-up",
      href: "/gvdg-members.html#home",
    });
    expect(notices[0]!.body).toContain("+35 karma");

    const id = created.data.workday.id as number;

    // Two members sign up; Member Home GET /workdays shows everyone signed up without leaking memberId/GPS.
    const adaSignup = await call(`/workdays/${id}/signup`, { sub: "m_ada", method: "POST" });
    expect(adaSignup.status).toBe(201);
    expect((await call(`/workdays/${id}/signup`, { sub: "m_grace", method: "POST" })).status).toBe(201);
    // Repeat signup is idempotent.
    expect((await call(`/workdays/${id}/signup`, { sub: "m_ada", method: "POST" })).status).toBe(200);

    const homeFeed = await call("/workdays", { sub: "m_grace" });
    expect(homeFeed.status).toBe(200);
    expect(homeFeed.data.workdays).toHaveLength(1);
    const roster = homeFeed.data.workdays[0].signups;
    expect(roster).toEqual([
      expect.objectContaining({ name: "Ada Lovelace", karmaKey: karmaKey("m_ada"), status: "signed_up", isMe: false }),
      expect.objectContaining({ name: "Grace Hopper", karmaKey: karmaKey("m_grace"), status: "signed_up", isMe: true }),
    ]);
    for (const entry of roster) {
      expect(entry.memberId).toBeUndefined();
      expect(entry.gpsLat).toBeUndefined();
    }

    // Check-in blocked while future workday is not open for check-in yet.
    expect((await call(`/workdays/${id}/check-in`, { sub: "m_ada", method: "POST", body: { lat: 35.6127, lng: -77.3664 } })).data.error)
      .toBe("checkin_not_open");

    // Admin activates check-in; unsigned member still rejected, out-of-range GPS returns 422 too_far.
    expect((await call(`/admin/workdays/${id}`, { sub: "m_admin", method: "PATCH", body: { status: "active" } })).data.workday.checkinOpen)
      .toBe(true);
    expect((await call(`/workdays/${id}/check-in`, { sub: "m_linus", method: "POST", body: { lat: 35.6127, lng: -77.3664 } })).data.error)
      .toBe("not_signed_up");
    const far = await call(`/workdays/${id}/check-in`, { sub: "m_ada", method: "POST", body: { lat: 35.65, lng: -77.4 } });
    expect(far.status).toBe(422);
    expect(far.data.error).toBe("too_far");
    expect(far.data.distanceFt).toBeGreaterThan(1500);

    // Valid on-site GPS check-in succeeds and surfaces pendingCheckins to admin.
    const checkedIn = await call(`/workdays/${id}/check-in`, {
      sub: "m_ada",
      method: "POST",
      body: { lat: 35.6128, lng: -77.3665, accuracyM: 12 },
    });
    expect(checkedIn.status).toBe(200);
    expect(checkedIn.data.distanceFt).toBeLessThan(1500);
    expect(checkedIn.data.workday.me).toMatchObject({ status: "checked_in", gpsVerified: true });

    const adminQueue = await call("/admin/workdays", { sub: "m_admin" });
    expect(adminQueue.data.pendingCheckins).toBe(1);

    // Admin verification requires GPS unless allowWithoutGps override is used.
    expect((await call(`/admin/workdays/${id}/participants/m_grace/verify`, { sub: "m_admin", method: "POST", body: {} })).data.error)
      .toBe("gps_required");

    const verifiedAda = await call(`/admin/workdays/${id}/participants/m_ada/verify`, {
      sub: "m_admin",
      method: "POST",
      body: {},
    });
    expect(verifiedAda.status).toBe(200);
    expect(verifiedAda.data.participant).toMatchObject({ memberId: "m_ada", status: "verified", karmaAwarded: 35 });

    // Verified participant gets karma notice, cannot duplicate verify or delete signup, and karma counts in /karma & karmaOf.
    expect(db.raw.prepare("SELECT title, body FROM member_notices WHERE member_id = 'm_ada' AND ref_key = ?").get(`workday-karma-${id}`))
      .toEqual({ title: "Workday karma earned!", body: "+35 karma for Spring Mulch & Tee Pad Clean-up. Thanks for helping the club!" });
    expect((await call(`/admin/workdays/${id}/participants/m_ada/verify`, { sub: "m_admin", method: "POST", body: {} })).status).toBe(409);
    expect((await call(`/workdays/${id}/signup`, { sub: "m_ada", method: "DELETE" })).status).toBe(409);

    const directory = await call("/karma");
    expect(directory.data.players[karmaKey("m_ada")]).toBe(35);
    expect((await karmaOf(env, ["m_ada"])).get("m_ada")?.karma).toBe(35);

    // Admin can override GPS with explicit allowWithoutGps or mark no_show / restore, and verify-all-gps approves remaining GPS check-ins.
    await call(`/admin/workdays/${id}/participants/m_grace/status`, { sub: "m_admin", method: "POST", body: { status: "no_show" } });
    expect((await call("/workdays", { sub: "m_linus" })).data.workdays[0].signups).toHaveLength(1);

    await call(`/workdays/${id}/signup`, { sub: "m_linus", method: "POST" });
    await call(`/workdays/${id}/check-in`, { sub: "m_linus", method: "POST", body: { lat: 35.6127, lng: -77.3664 } });
    const bulk = await call(`/admin/workdays/${id}/verify-all-gps`, { sub: "m_admin", method: "POST" });
    expect(bulk.status).toBe(200);
    expect(bulk.data.verifiedCount).toBe(1);
    expect((await call("/karma")).data.players[karmaKey("m_linus")]).toBe(35);
  });

  it("auto-opens GPS check-in on the workday date (Eastern) and notifies participants when cancelled", async () => {
    const today = easternTodayIso();
    const created = await call("/admin/workdays", {
      sub: "m_admin",
      method: "POST",
      body: { title: "Today's Basket Reset", locationName: "Covenant Park", lat: 35.6, lng: -77.35, workdayDate: today, karmaReward: 40 },
    });
    expect(created.data.workday.checkinOpen).toBe(true);
    const id = created.data.workday.id as number;
    await call(`/workdays/${id}/signup`, { sub: "m_ada", method: "POST" });
    expect((await call(`/workdays/${id}/check-in`, { sub: "m_ada", method: "POST", body: { lat: 35.6, lng: -77.35 } })).status).toBe(200);

    await call(`/admin/workdays/${id}`, { sub: "m_admin", method: "PATCH", body: { status: "cancelled" } });
    expect(db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_ada' AND ref_key = ?").get(`workday-cancelled-${id}`))
      .toEqual({ title: "Workday cancelled: Today's Basket Reset" });
    expect((await call("/workdays", { sub: "m_ada" })).data.workdays).toEqual([]);
  });
});
