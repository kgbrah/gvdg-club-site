import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
};

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

type DbState = {
  layoutBinds?: unknown[];
  eventBinds?: unknown[];
  updateEventBinds?: unknown[];
  registrationUpdateBinds?: unknown[];
  playerBinds?: unknown[];
  acePotBinds?: unknown[];
  removedPlayer?: number;
  deleteEventId?: number;
  eventStatus?: string;
  eventDeleteBlockers?: Partial<Record<"event_config" | "registrations" | "event_players" | "results" | "ctps" | "wallet_transactions" | "ace_pots", number>>;
};

function db(state: DbState = {}) {
  return {
    prepare: (sql: string) => {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        all: async () => {
          if (/FROM events e JOIN event_config c/i.test(sql)) {
            return {
              results: [{
                id: 5,
                name: "Summer Flex",
                date: "2026-07-12",
                type: "tournament",
                event_format: "stroke",
                course_id: 7,
                layout_id: 44,
                course_name: "West Meadowbrook",
                layout_name: "Gold",
                total_par: 54,
                entry_fee_cents: 1000,
                ctp_fee_cents: null,
                ace_fee_cents: null,
                divisions: "[]",
                play_format: "singles",
              }],
              success: true,
            };
          }
          return { results: [], success: true };
        },
        first: async () => {
          if (/SELECT status FROM events WHERE id = \?/i.test(sql)) {
            return { status: state.eventStatus ?? "scheduled" };
          }
          if (/SELECT COUNT\(\*\) AS n FROM event_config WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.event_config ?? 0 };
          }
          if (/SELECT COUNT\(\*\) AS n FROM registrations WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.registrations ?? 0 };
          }
          if (/SELECT COUNT\(\*\) AS n FROM event_players WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.event_players ?? 0 };
          }
          if (/SELECT COUNT\(\*\) AS n FROM results WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.results ?? 0 };
          }
          if (/SELECT COUNT\(\*\) AS n FROM ctps WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.ctps ?? 0 };
          }
          if (/SELECT COUNT\(\*\) AS n FROM wallet_transactions WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.wallet_transactions ?? 0 };
          }
          if (/SELECT COUNT\(\*\) AS n FROM ace_pots WHERE event_id = \?/i.test(sql)) {
            return { n: state.eventDeleteBlockers?.ace_pots ?? 0 };
          }
          if (/INSERT INTO course_layouts/i.test(sql)) {
            state.layoutBinds = binds;
            return { id: 44, course_id: binds[0], name: binds[1], holes: binds[2], total_par: binds[3] };
          }
          if (/INSERT INTO events/i.test(sql)) {
            state.eventBinds = binds;
            return { id: 12, type: binds[0], name: binds[1], course_id: binds[5], layout_id: binds[6], created_by: binds[11] };
          }
          if (/INSERT INTO event_players/i.test(sql)) {
            state.playerBinds = binds;
            return { id: 88, event_id: binds[0], member_id: binds[1], name: binds[2], pdga_no: binds[3], division: binds[4], team: binds[5] };
          }
          if (/INSERT INTO ace_pots/i.test(sql)) {
            state.acePotBinds = binds;
            return {
              event_id: binds[0],
              carryover_in_cents: binds[1],
              status: binds[2],
              winner_member_id: binds[3],
              winner_name: binds[4],
              payout_cents: binds[5],
              resolved_at: binds[6],
            };
          }
          if (/UPDATE events/i.test(sql)) {
            state.updateEventBinds = binds;
            return { id: binds.at(-1), status: state.eventStatus ?? "scheduled" };
          }
          if (/UPDATE registrations SET/i.test(sql)) {
            state.registrationUpdateBinds = binds;
            return { id: binds.at(-2), event_id: binds.at(-1), starting_hole: binds[0], checked_in: binds[1] };
          }
          if (/SELECT \* FROM registrations WHERE id = \? AND event_id = \?/i.test(sql)) {
            state.registrationUpdateBinds = binds;
            return { id: binds[0], event_id: binds[1] };
          }
          return null;
        },
        run: async () => {
          if (/DELETE FROM event_players/i.test(sql)) state.removedPlayer = Number(binds[0]);
          if (/DELETE FROM events/i.test(sql)) state.deleteEventId = Number(binds[0]);
          return { results: [], success: true };
        },
      };
    },
  };
}

function env(state: DbState = {}) {
  return {
    ROSTER: kv(MEMBERS),
    RATELIMIT: kv(),
    DB: db(state),
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function token(sub: string) {
  return signSession({ sub, mustChangePin: false }, SECRET, 900);
}

async function call(path: string, method = "GET", body?: unknown, jwt?: string, state: DbState = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (jwt) headers.authorization = "Bearer " + jwt;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env(state));
}

describe("admin event management", () => {
  it("creates an event and a basic layout in the same request", async () => {
    const state: Parameters<typeof db>[0] = {};
    const res = await call("/admin/events", "POST", {
      type: "tournament",
      name: "Summer Flex",
      course_id: 7,
      layout: { name: "Gold", hole_count: 18, default_par: 3 },
    }, await token("m_admin"), state);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { layout_id: number; created_by: string }; layout: { id: number } };
    expect(body.layout.id).toBe(44);
    expect(body.event).toMatchObject({ layout_id: 44, created_by: "m_admin" });
    expect(state.eventBinds?.[6]).toBe(44);
    expect(state.layoutBinds?.[0]).toBe(7);
    expect(state.layoutBinds?.[1]).toBe("Gold");
    expect(state.layoutBinds?.[3]).toBe(54);
    const holes = JSON.parse(String(state.layoutBinds?.[2])) as { hole: number; par: number }[];
    expect(holes).toHaveLength(18);
    expect(holes.every((h) => h.par === 3)).toBe(true);
  });

  it("lets admins add and remove manual event players", async () => {
    const state: Parameters<typeof db>[0] = {};
    const jwt = await token("m_admin");
    const add = await call("/admin/events/9/players", "POST", { name: "Walk On", pdga_no: "12345", division: "MA1", team: "A" }, jwt, state);
    expect(add.status).toBe(201);
    expect(state.playerBinds).toEqual([9, null, "Walk On", "12345", "MA1", "A"]);

    const remove = await call("/admin/events/9/players/88", "DELETE", undefined, jwt, state);
    expect(remove.status).toBe(200);
    expect(state.removedPlayer).toBe(88);
  });

  it("includes course and layout details for open registration events", async () => {
    const res = await call("/registration/open", "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { course_name?: string; layout_name?: string; total_par?: number }[] };
    expect(body.events[0]).toMatchObject({ course_name: "West Meadowbrook", layout_name: "Gold", total_par: 54 });
  });

  it("scopes admin registration updates to the selected event", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9/registrations/44", "PATCH", { starting_hole: 7, checked_in: true }, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.registrationUpdateBinds).toEqual([7, 1, 44, 9]);
  });

  it("clears nullable admin registration fields when explicitly sent as null", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9/registrations/44", "PATCH", { starting_hole: null }, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.registrationUpdateBinds).toEqual([null, 44, 9]);
  });

  it("requires confirmation and a winner before resolving ace pot payout", async () => {
    const jwt = await token("m_admin");
    const unconfirmedState: DbState = {};
    const unconfirmed = await call("/admin/events/9/ace-pot", "PUT", { status: "paid_out", winner_name: "Ace Winner", carryover_in_cents: 2500 }, jwt, unconfirmedState);

    expect(unconfirmed.status).toBe(409);
    expect(unconfirmedState.acePotBinds).toBeUndefined();

    const missingWinnerState: DbState = {};
    const missingWinner = await call("/admin/events/9/ace-pot", "PUT", { status: "paid_out", carryover_in_cents: 2500, confirm_ace_pot_resolution: true }, jwt, missingWinnerState);

    expect(missingWinner.status).toBe(400);
    expect(missingWinnerState.acePotBinds).toBeUndefined();

    const confirmedState: DbState = {};
    const confirmed = await call(
      "/admin/events/9/ace-pot",
      "PUT",
      { status: "paid_out", winner_name: "Ace Winner", carryover_in_cents: 2500, confirm_ace_pot_resolution: true },
      jwt,
      confirmedState,
    );

    expect(confirmed.status).toBe(200);
    expect(confirmedState.acePotBinds?.slice(0, 6)).toEqual([9, 2500, "paid_out", null, "Ace Winner", null]);
    expect(typeof confirmedState.acePotBinds?.[6]).toBe("string");
  });

  it("rejects direct lifecycle status writes that must go through live scoring", async () => {
    const jwt = await token("m_admin");

    const patchLive = await call("/admin/events/9", "PATCH", { status: "live" }, jwt);
    expect(patchLive.status).toBe(409);

    const patchFinal = await call("/admin/events/9", "PATCH", { status: "final" }, jwt);
    expect(patchFinal.status).toBe(409);

    const cancelLive = await call("/admin/events/9", "PATCH", { status: "cancelled" }, jwt, { eventStatus: "live" });
    expect(cancelLive.status).toBe(409);

    const createFinal = await call("/admin/events", "POST", { type: "tournament", name: "Bad final", status: "final" }, jwt);
    expect(createFinal.status).toBe(409);
  });

  it("blocks deleting events that already have operational records", async () => {
    const state: DbState = { eventDeleteBlockers: { registrations: 1 } };
    const res = await call("/admin/events/9", "DELETE", undefined, await token("m_admin"), state);

    expect(res.status).toBe(409);
    expect(state.deleteEventId).toBeUndefined();
  });

  it("still deletes empty scheduled events", async () => {
    const state: DbState = {};
    const res = await call("/admin/events/9", "DELETE", undefined, await token("m_admin"), state);

    expect(res.status).toBe(200);
    expect(state.deleteEventId).toBe(9);
  });
});
