import { describe, expect, it } from "vitest";
import { handleClubLive } from "../src/club-live-routes.js";
import type { Env } from "../src/env.js";

type DbState = {
  weatherLocation?: unknown;
};

function db(state: DbState) {
  return {
    prepare: (sql: string) => {
      let binds: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          binds = values;
          return this;
        },
        all: async () => ({ results: [], success: true }),
        first: async () => {
          if (/SELECT \* FROM events WHERE id = \?/i.test(sql)) return null;
          if (/SELECT \* FROM courses WHERE lower\(name\) = lower\(\?\)/i.test(sql)) {
            expect(binds).toEqual(["West Meadowbrook Park"]);
            return { id: 2, name: "West Meadowbrook Park", location: "Greenville, NC", lat: 35.6264, lng: -77.375 };
          }
          if (/SELECT \* FROM course_layouts WHERE course_id = \? AND lower\(name\) = lower\(\?\)/i.test(sql)) {
            expect(binds).toEqual([2, "Yard Gnome Layout"]);
            return { id: 1, course_id: 2, name: "Yard Gnome Layout", holes: "[]" };
          }
          return null;
        },
        run: async () => ({ results: [], success: true }),
      };
    },
  };
}

function env(state: DbState): Env {
  const snapshot = {
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
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    },
  };
  return {
    DB: db(state),
    LIVE: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Env;
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
