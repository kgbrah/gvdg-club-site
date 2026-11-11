import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { jsonObject } from "./json.js";

const ORIGIN = "http://localhost:8080";
const LAYOUT_HOLES = JSON.stringify([
  { hole: 1, par: 3, tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.61, lng: -77.36 } },
]);

function kv() {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  };
}

function database(round: Record<string, unknown> | null, options: { throwConsensus?: boolean } = {}) {
  const results = round
    ? [{
      name: "Kevin",
      total: 55,
      to_par: -1,
      scorecard: JSON.stringify([{ hole: 1, par: 3, strokes: 2, throws: [{ lat: 35.601, lng: -77.369 }] }]),
    }]
    : [];
  return {
    prepare: (sql: string) => ({
      bind() { return this; },
      first: async () => {
        if (/FROM casual_rounds/i.test(sql)) return round;
        if (/FROM course_layouts/i.test(sql)) return round ? { id: 3, course_id: 2, holes: LAYOUT_HOLES } : null;
        if (/FROM courses/i.test(sql)) return round ? { id: 2, name: "West Meadowbrook Park", udisc_course_id: "WMP" } : null;
        return null;
      },
      all: async () => {
        if (/course_map_consensus/i.test(sql)) {
          if (options.throwConsensus) throw new Error("consensus_down");
          return { results: [], success: true };
        }
        if (/casual_results/i.test(sql)) return { results, success: true };
        return { results: [], success: true };
      },
      run: async () => ({ results: [], success: true }),
    }),
  };
}

function envFor(snapshot: unknown, round: Record<string, unknown> | null, options: { throwSnapshot?: boolean; throwConsensus?: boolean; doStatus?: number } = {}) {
  return {
    ROSTER: kv(),
    RATELIMIT: kv(),
    DB: database(round, options),
    JWT_SECRET: "x".repeat(40),
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string | Request) => {
          const url = typeof input === "string" ? input : input.url;
          if (!new URL(url).pathname.endsWith("/snapshot")) return new Response("{}", { status: 404 });
          if (options.throwSnapshot) throw new Error("do_down");
          return new Response(JSON.stringify(snapshot), { status: options.doStatus ?? 200 });
        },
      }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function watch(snapshot: unknown, round: Record<string, unknown> | null, options?: { throwSnapshot?: boolean; throwConsensus?: boolean; doStatus?: number }) {
  return worker.fetch(new Request("https://w/rounds/AB23CD/live", { headers: { Origin: ORIGIN } }), envFor(snapshot, round, options));
}

const ROUND = {
  id: 7,
  round_code: "AB23CD",
  course_id: 2,
  layout_id: 3,
  course_name: "West Meadowbrook Park",
  layout_name: "White Pads to B-Pins",
  holes: JSON.stringify([{ hole: 1, par: 3 }]),
  scoring_config: JSON.stringify({ groupFormat: "singles", scoringStyle: "stroke" }),
  finalized_at: "2026-11-05T18:00:00Z",
};

describe("casual replay live route", () => {
  it("rebuilds a hollow final snapshot from durable results", async () => {
    const res = await watch({ status: "final", holes: [] }, ROUND);
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.status).toBe("final");
    expect(body.courseName).toBe("West Meadowbrook Park");
    expect(body.archived).toBe(true);
    const players = body.players as { name: string; scores: Record<string, number> }[];
    expect(players[0]?.name).toBe("Kevin");
    expect(players[0]?.scores["1"]).toBe(2);
    const holes = body.holes as { tee?: { lat?: number } }[];
    expect(holes[0]?.tee?.lat).toBe(35.6);
  });

  it("rebuilds when the durable object is gone", async () => {
    const res = await watch({}, ROUND, { throwSnapshot: true });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.status).toBe("final");
    expect(body.archived).toBe(true);
  });

  it("keeps an in-progress live card ahead of any saved results", async () => {
    const res = await watch({ status: "live", holes: [{ hole: 1, par: 3 }], courseName: "Live card" }, ROUND);
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.courseName).toBe("Live card");
    expect(body.archived).toBeUndefined();
  });

  it("returns a usable final card even when the object responded 500", async () => {
    const res = await watch(
      { status: "final", holes: [{ hole: 1, par: 3 }], courseName: "Saved card", layoutId: null, courseId: null },
      ROUND,
      { doStatus: 500 },
    );
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.courseName).toBe("Saved card");
    expect(body.archived).toBeUndefined();
  });

  it("still returns the saved card when the map overlay throws", async () => {
    const res = await watch(
      { status: "final", holes: [{ hole: 1, par: 4 }], courseName: "Pinned card", layoutId: 3, courseId: 2 },
      ROUND,
      { throwConsensus: true },
    );
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.courseName).toBe("Pinned card");
    expect(body.status).toBe("final");
  });
});
