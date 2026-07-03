import { describe, expect, it } from "vitest";
import { handleClubLive } from "../src/club-live-routes.js";
import { signSession } from "../src/jwt.js";
import type { ClubLiveEnv } from "../src/club-live-routes.js";
import type { D1Like } from "../src/db.js";

type DbState = {
  weatherLocation?: unknown;
  eventStatus?: string | null;
  scorecardCancelled?: boolean;
  eventStatusUpdated?: boolean;
  eventRow?: Record<string, unknown> | null;
  eventConfig?: Record<string, unknown> | null;
  registrations?: Record<string, unknown>[];
  startBody?: Record<string, unknown>;
  liveSnapshot?: Record<string, unknown>;
};

const SECRET = "x".repeat(40);
const MEMBERS = {
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

function emptyRows<T>(): T[] {
  return [];
}

function db(state: DbState): D1Like {
  return {
    prepare: (sql: string) => {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        all: async <T = Record<string, unknown>>() => {
          if (/SELECT \* FROM registrations WHERE event_id = \?/i.test(sql)) return { results: (state.registrations ?? []) as T[], success: true };
          return { results: emptyRows<T>(), success: true };
        },
        first: async <T = Record<string, unknown>>() => {
          let row: Record<string, unknown> | null = null;
          if (/SELECT status FROM events WHERE id = \?/i.test(sql)) {
            row = state.eventStatus == null ? null : { status: state.eventStatus };
          }
          else if (/FROM events(?:\s+e)?/i.test(sql) && /WHERE\s+(?:e\.)?id = \?/i.test(sql)) {
            row = state.eventRow ?? null;
          }
          else if (/SELECT \* FROM event_config WHERE event_id = \?/i.test(sql)) row = state.eventConfig ?? null;
          else if (/SELECT \* FROM course_layouts WHERE id = \?/i.test(sql)) row = { id: 1, course_id: 2, name: "Yard Gnome Layout", holes: JSON.stringify([{ hole: 1, par: 3 }, { hole: 2, par: 4 }]) };
          else if (/SELECT \* FROM courses WHERE id = \?/i.test(sql)) row = { id: 2, name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.6264, lng: -77.375 };
          if (/SELECT \* FROM courses WHERE lower\(name\) = lower\(\?\)/i.test(sql)) {
            expect(binds).toEqual(["West Meadowbrook Park"]);
            row = { id: 2, name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.6264, lng: -77.375 };
          }
          else if (/SELECT \* FROM course_layouts WHERE course_id = \? AND lower\(name\) = lower\(\?\)/i.test(sql)) {
            expect(binds).toEqual([2, "Yard Gnome Layout"]);
            row = { id: 1, course_id: 2, name: "Yard Gnome Layout", holes: "[]" };
          }
          else if (/UPDATE events SET/i.test(sql)) {
            state.eventStatus = "scheduled";
            state.eventStatusUpdated = true;
            row = { id: binds.at(-1), status: "scheduled" };
          }
          return row as T | null;
        },
        run: async () => ({ results: [], success: true }),
      };
    },
  };
}

function env(state: DbState): ClubLiveEnv {
  const snapshot = state.liveSnapshot ?? {
    status: "live",
    eventId: 2,
    courseName: "West Meadowbrook Park",
    layoutName: "Yard Gnome Layout",
    holes: [],
    players: [],
    standings: [],
  };
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/snapshot")) return new Response(JSON.stringify(snapshot));
      if (url.endsWith("/weather")) {
        state.weatherLocation = JSON.parse(String(init?.body ?? "{}")).weatherLocation;
        return new Response(JSON.stringify({ ...snapshot, weather: { location: state.weatherLocation, current: null, history: [], error: null } }));
      }
      if (url.endsWith("/cancel")) {
        state.scorecardCancelled = true;
        return new Response(JSON.stringify({ status: "none", rev: 3, players: [] }));
      }
      if (url.endsWith("/start")) {
        state.startBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ status: "live", standings: [] }));
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    },
  };
  const bindings: ClubLiveEnv = {
    DB: db(state),
    ROSTER: kv(MEMBERS),
    RATELIMIT: kv(),
    JWT_SECRET: SECRET,
    LIVE: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  };
  return bindings;
}

async function adminHeader(): Promise<HeadersInit> {
  const token = await signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900);
  return { Authorization: "Bearer " + token };
}

describe("club live weather backfill", () => {
  it("resolves weather from live snapshot names when the event row is gone", async () => {
    const state: DbState = {};
    const res = await handleClubLive(new Request("https://w/events/2/live"), env(state), null, "GET", ["events", "2", "live"]);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { weather?: { location?: unknown } };
    expect(state.weatherLocation).toEqual({ lat: 35.6264, lng: -77.375, label: "West Meadowbrook Park - Greenville, NC" });
    expect(body.weather?.location).toEqual(state.weatherLocation);
  });
});

describe("club live scorecard cancellation", () => {
  it("requires explicit confirmation before resetting live scoring", async () => {
    const state: DbState = { eventStatus: "live" };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/cancel", { method: "POST", headers: await adminHeader() }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "cancel"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "live_scorecard_cancel_confirmation_required" });
    expect(state.scorecardCancelled).toBeUndefined();
    expect(state.eventStatusUpdated).toBeUndefined();
  });

  it("resets the live Durable Object and returns the event to scheduled", async () => {
    const state: DbState = { eventStatus: "live" };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/cancel", {
        method: "POST",
        headers: await adminHeader(),
        body: JSON.stringify({ confirm_live_scorecard_cancel: true }),
      }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "cancel"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "none" });
    expect(state.scorecardCancelled).toBe(true);
    expect(state.eventStatus).toBe("scheduled");
    expect(state.eventStatusUpdated).toBe(true);
  });

  it("returns not found without touching live state when the event is missing", async () => {
    const state: DbState = { eventStatus: null };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/cancel", {
        method: "POST",
        headers: await adminHeader(),
        body: JSON.stringify({ confirm_live_scorecard_cancel: true }),
      }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "cancel"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
    expect(state.scorecardCancelled).toBeUndefined();
    expect(state.eventStatusUpdated).toBeUndefined();
  });

  it("rejects final events without touching live state", async () => {
    const state: DbState = { eventStatus: "final" };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/cancel", {
        method: "POST",
        headers: await adminHeader(),
        body: JSON.stringify({ confirm_live_scorecard_cancel: true }),
      }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "cancel"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "round_already_final" });
    expect(state.scorecardCancelled).toBeUndefined();
    expect(state.eventStatus).toBe("final");
    expect(state.eventStatusUpdated).toBeUndefined();
  });
});

describe("club live competition formats", () => {
  it("keeps the live snapshot format when event settings are edited after start", async () => {
    const state: DbState = {
      eventRow: { id: 2, type: "tournament", name: "Edited Event", status: "live", format: "stroke", course_id: 2, layout_id: 1 },
      eventConfig: { play_format: "singles" },
      liveSnapshot: {
        status: "live",
        eventId: 2,
        format: "matchplay",
        playFormat: "doubles",
        teamRequired: true,
        weather: { location: null, current: null, history: [], error: null },
        holes: [],
        players: [],
        standings: [],
      },
    };
    const res = await handleClubLive(new Request("https://w/events/2/live"), env(state), null, "GET", ["events", "2", "live"]);

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "matchplay", playFormat: "doubles", teamRequired: true });
  });

  it("starts live scoring with independent matchplay and doubles metadata", async () => {
    const state: DbState = {
      eventRow: { id: 2, type: "tournament", name: "Doubles Match", status: "scheduled", format: "matchplay", course_id: 2, layout_id: 1 },
      eventConfig: { play_format: "doubles" },
      registrations: [
        { member_id: "r1", name: "Red 1", team: "Red", division: "MA1", starting_hole: null },
        { member_id: "r2", name: "Red 2", team: "Red", division: "MA1", starting_hole: null },
        { member_id: "b1", name: "Blue 1", team: "Blue", division: "MA1", starting_hole: null },
        { member_id: "b2", name: "Blue 2", team: "Blue", division: "MA1", starting_hole: null },
      ],
    };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/start", { method: "POST", headers: await adminHeader(), body: JSON.stringify({}) }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "start"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(200);
    expect(state.startBody).toMatchObject({ eventId: 2, format: "matchplay", playFormat: "doubles", teamRequired: true });
    expect(state.startBody?.players).toEqual([
      { memberId: "r1", name: "Red 1", team: "Red", division: "MA1", startingHole: null, ratingAnchor: null },
      { memberId: "r2", name: "Red 2", team: "Red", division: "MA1", startingHole: null, ratingAnchor: null },
      { memberId: "b1", name: "Blue 1", team: "Blue", division: "MA1", startingHole: null, ratingAnchor: null },
      { memberId: "b2", name: "Blue 2", team: "Blue", division: "MA1", startingHole: null, ratingAnchor: null },
    ]);
  });

  it("starts from checked-in registrations only after the check-in deadline", async () => {
    const state: DbState = {
      eventRow: {
        id: 2,
        type: "tournament",
        name: "Morning Flex",
        status: "scheduled",
        format: "stroke",
        course_id: 2,
        layout_id: 1,
        checkin_deadline: new Date(Date.now() - 60_000).toISOString(),
      },
      eventConfig: { play_format: "singles" },
      registrations: [
        { member_id: "in", name: "Checked In", team: null, division: "MA1", starting_hole: 1, checked_in: 1 },
        { member_id: "out", name: "No Show", team: null, division: "MA1", starting_hole: 1, checked_in: 0 },
      ],
    };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/start", { method: "POST", headers: await adminHeader(), body: JSON.stringify({}) }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "start"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(200);
    expect(state.startBody?.players).toEqual([
      { memberId: "in", name: "Checked In", team: null, division: "MA1", startingHole: 1, ratingAnchor: null },
    ]);
  });

  it("falls back to the full roster when the check-in deadline passed but nobody used in-app check-in", async () => {
    const state: DbState = {
      eventRow: {
        id: 2,
        type: "tournament",
        name: "Morning Flex",
        status: "scheduled",
        format: "stroke",
        course_id: 2,
        layout_id: 1,
        checkin_deadline: new Date(Date.now() - 60_000).toISOString(),
      },
      eventConfig: { play_format: "singles" },
      registrations: [
        { member_id: "a", name: "Ada", team: null, division: "MA1", starting_hole: 1, checked_in: 0 },
        { member_id: "b", name: "Ben", team: null, division: "MA1", starting_hole: 1, checked_in: 0 },
      ],
    };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/start", { method: "POST", headers: await adminHeader(), body: JSON.stringify({}) }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "start"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(200); // NOT no_checked_in_players — paper-tracked clubs can still start
    expect(state.startBody?.players).toEqual([
      { memberId: "a", name: "Ada", team: null, division: "MA1", startingHole: 1, ratingAnchor: null },
      { memberId: "b", name: "Ben", team: null, division: "MA1", startingHole: 1, ratingAnchor: null },
    ]);
  });

  it("rejects doubles live scoring start when teams are missing", async () => {
    const state: DbState = {
      eventRow: { id: 2, type: "tournament", name: "Doubles Match", status: "scheduled", format: "matchplay", course_id: 2, layout_id: 1 },
      eventConfig: { play_format: "doubles" },
      registrations: [
        { member_id: "r1", name: "Red 1", team: "Red", division: "MA1", starting_hole: null },
        { member_id: "b1", name: "Blue 1", team: null, division: "MA1", starting_hole: null },
      ],
    };
    const res = await handleClubLive(
      new Request("https://w/events/2/live/start", { method: "POST", headers: await adminHeader(), body: JSON.stringify({}) }),
      env(state),
      null,
      "POST",
      ["events", "2", "live", "start"],
    );

    if (!res) throw new Error("missing_response");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "team_required", player: "Blue 1" });
    expect(state.startBody).toBeUndefined();
  });
});
