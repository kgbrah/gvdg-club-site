import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", pdgaNo: "111", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_bob": JSON.stringify({ memberId: "m_bob", name: "Bob", pdgaNo: "222", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_tj": JSON.stringify({ memberId: "m_tj", name: "TJ Braley", pdgaNo: "333", isAdmin: false, pinHash: "x", mustChangePin: false }),
};

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...rows.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

type RegRow = {
  id: number;
  event_id: number;
  member_id: string;
  name: string;
  division: string | null;
  team: string | null;
  addons: string | null;
  email: string | null;
  paid_entry: number;
  checked_in: number;
  starting_hole?: number | null;
};

function makeDb(state: { status?: string | null; regs?: RegRow[] } = {}) {
  const regs = state.regs ?? [];
  let nextId = regs.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  const db = {
    prepare: (sql: string) => {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        all: async () => {
          if (/SELECT \* FROM registrations WHERE event_id = \?/i.test(sql)) {
            return { results: regs.filter((row) => row.event_id === binds[0]), success: true };
          }
          return { results: [], success: true };
        },
        first: async () => {
          if (/SELECT status FROM events WHERE id = \?/i.test(sql)) {
            return state.status == null ? null : { status: state.status };
          }
          if (/DELETE FROM registrations WHERE id = \? AND event_id = \?/i.test(sql)) {
            const idx = regs.findIndex((row) => row.id === binds[0] && row.event_id === binds[1]);
            if (idx < 0) return null;
            const [removed] = regs.splice(idx, 1);
            return removed;
          }
          return insertRegistration() ?? null;
        },
        run: async () => {
          insertRegistration();
          return { results: [], success: true };
        },
      };
      function insertRegistration(): RegRow | null {
        if (!/INSERT INTO registrations/i.test(sql)) return null;
        const eventId = binds[0] as number;
        const memberId = binds[1] as string;
        const existing = regs.find((row) => row.event_id === eventId && row.member_id === memberId);
        if (existing) return existing;
        const row: RegRow = {
          id: nextId++,
          event_id: eventId,
          member_id: memberId,
          name: binds[2] as string,
          division: (binds[3] as string | null) ?? null,
          team: (binds[4] as string | null) ?? null,
          addons: (binds[5] as string | null) ?? null,
          email: (binds[6] as string | null) ?? null,
          paid_entry: binds[7] ? 1 : 0,
          checked_in: 0,
        };
        regs.push(row);
        return row;
      }
      return stmt;
    },
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
  return db;
}

function env(db: ReturnType<typeof makeDb> = makeDb({ status: "scheduled" })) {
  return {
    ROSTER: kv(MEMBERS),
    RATELIMIT: kv(),
    DB: db,
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function tok(sub: string) {
  return signSession({ sub, mustChangePin: false }, SECRET, 900);
}

async function call(path: string, method: string, token?: string, body?: unknown, db?: ReturnType<typeof makeDb>) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.authorization = "Bearer " + token;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(
    new Request("https://w" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env(db),
  );
}

describe("admin cash registration of club members", () => {
  it("401 without a token, 403 for a non-admin", async () => {
    expect((await call("/admin/events/5/registrations", "POST", undefined, { member_ids: ["m_jane"] })).status).toBe(401);
    expect((await call("/admin/events/5/registrations", "POST", await tok("m_jane"), { member_ids: ["m_bob"] })).status).toBe(403);
  });

  it("400 when member_ids is missing, empty, or not an array", async () => {
    const admin = await tok("m_admin");
    expect((await call("/admin/events/5/registrations", "POST", admin, {})).status).toBe(400);
    expect((await call("/admin/events/5/registrations", "POST", admin, { member_ids: [] })).status).toBe(400);
    expect((await call("/admin/events/5/registrations", "POST", admin, { member_ids: "m_jane" })).status).toBe(400);
    const empty = await call("/admin/events/5/registrations", "POST", admin, { member_ids: ["", "   "] });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ error: "invalid_members" });
  });

  it("400 when more than 40 unique member ids are sent", async () => {
    const ids = Array.from({ length: 41 }, (_, i) => `m_${i + 1}`);
    const res = await call("/admin/events/5/registrations", "POST", await tok("m_admin"), { member_ids: ids });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "too_many_members" });
  });

  it("404 when the event is missing, 403 when it is closed", async () => {
    const admin = await tok("m_admin");
    expect((await call("/admin/events/5/registrations", "POST", admin, { member_ids: ["m_jane"] }, makeDb({ status: null }))).status).toBe(404);
    expect((await call("/admin/events/5/registrations", "POST", admin, { member_ids: ["m_jane"] }, makeDb({ status: "cancelled" }))).status).toBe(403);
    expect((await call("/admin/events/5/registrations", "POST", admin, { member_ids: ["m_jane"] }, makeDb({ status: "final" }))).status).toBe(403);
  });

  it("still allows cash signup after the event is marked live if scoring has not started", async () => {
    const db = makeDb({ status: "live" });
    const res = await call("/admin/events/5/registrations", "POST", await tok("m_admin"), { member_ids: ["m_jane"] }, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: Array<{ member_id: string }> };
    expect(body.added.map((row) => row.member_id)).toEqual(["m_jane"]);
  });

  it("adds club members as true registrations even when public registration is closed", async () => {
    const db = makeDb({ status: "scheduled" });
    const res = await call("/admin/events/5/registrations", "POST", await tok("m_admin"), {
      member_ids: ["m_jane", "m_bob", "m_jane"],
      division: "MA1",
      addons: { ctp: true, ace: false },
    }, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: Array<{ member_id: string; name: string }>;
      skipped: unknown[];
      registrations: Array<{ member_id: string; division: string; addons: string; paid_entry: number }>;
    };
    expect(body.added.map((row) => row.member_id).sort()).toEqual(["m_bob", "m_jane"]);
    expect(body.skipped).toEqual([]);
    expect(body.registrations).toHaveLength(2);
    expect(body.registrations.find((row) => row.member_id === "m_jane")).toMatchObject({
      division: "MA1",
      addons: '{"ctp":true,"ace":false}',
      paid_entry: 0,
    });
  });

  it("can mark the batch as paid cash on a scheduled event", async () => {
    const db = makeDb({ status: "scheduled" });
    const res = await call("/admin/events/5/registrations", "POST", await tok("m_admin"), {
      member_ids: ["m_jane"],
      paid_entry: true,
      addons: { ctp: false, ace: true },
    }, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registrations: Array<{ member_id: string; paid_entry: number; addons: string }> };
    expect(body.registrations[0]).toMatchObject({
      member_id: "m_jane",
      paid_entry: 1,
      addons: '{"ctp":false,"ace":true}',
    });
  });

  it("skips already-registered and unknown members instead of failing the batch", async () => {
    const db = makeDb({
      status: "scheduled",
      regs: [{
        id: 9,
        event_id: 5,
        member_id: "m_jane",
        name: "Jane",
        division: "MA1",
        team: null,
        addons: null,
        email: null,
        paid_entry: 0,
        checked_in: 0,
      }],
    });
    const res = await call("/admin/events/5/registrations", "POST", await tok("m_admin"), {
      member_ids: ["m_jane", "m_bob", "m_nobody"],
    }, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: Array<{ member_id: string }>;
      skipped: Array<{ member_id: string; reason: string }>;
      registrations: Array<{ member_id: string }>;
    };
    expect(body.added.map((row) => row.member_id)).toEqual(["m_bob"]);
    expect(body.skipped).toEqual([
      { member_id: "m_jane", reason: "already_registered" },
      { member_id: "m_nobody", reason: "not_found" },
    ]);
    expect(body.registrations.map((row) => row.member_id).sort()).toEqual(["m_bob", "m_jane"]);
  });

  it("skips a club member whose name already matches a guest registration", async () => {
    const db = makeDb({
      status: "scheduled",
      regs: [{
        id: 4,
        event_id: 5,
        member_id: "g_abc",
        name: "T.J. Braley",
        division: null,
        team: null,
        addons: null,
        email: null,
        paid_entry: 0,
        checked_in: 0,
      }],
    });
    const res = await call("/admin/events/5/registrations", "POST", await tok("m_admin"), {
      member_ids: ["m_tj"],
    }, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: Array<{ member_id: string }>;
      skipped: Array<{ member_id: string; reason: string }>;
      registrations: Array<{ member_id: string }>;
    };
    expect(body.added).toEqual([]);
    expect(body.skipped).toEqual([{ member_id: "m_tj", reason: "already_registered" }]);
    expect(body.registrations.map((row) => row.member_id)).toEqual(["g_abc"]);
  });

  it("lets an admin remove a registered player before scoring starts", async () => {
    const db = makeDb({
      status: "scheduled",
      regs: [{
        id: 9,
        event_id: 5,
        member_id: "m_jane",
        name: "Jane",
        division: "MA1",
        team: null,
        addons: null,
        email: null,
        paid_entry: 1,
        checked_in: 0,
      }],
    });
    const admin = await tok("m_admin");
    expect((await call("/admin/events/5/registrations/9", "DELETE", await tok("m_jane"))).status).toBe(403);
    const res = await call("/admin/events/5/registrations/9", "DELETE", admin, undefined, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; registration: { member_id: string } };
    expect(body.ok).toBe(true);
    expect(body.registration.member_id).toBe("m_jane");
    const missing = await call("/admin/events/5/registrations/9", "DELETE", admin, undefined, db);
    expect(missing.status).toBe(404);
  });

  it("refuses to delete a registration after the event is final", async () => {
    const db = makeDb({
      status: "final",
      regs: [{
        id: 9,
        event_id: 5,
        member_id: "m_jane",
        name: "Jane",
        division: null,
        team: null,
        addons: null,
        email: null,
        paid_entry: 0,
        checked_in: 0,
      }],
    });
    const res = await call("/admin/events/5/registrations/9", "DELETE", await tok("m_admin"), undefined, db);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "event_started" });
  });
});
