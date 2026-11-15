import { describe, expect, it } from "vitest";
import { courseTrafficPayload, trafficFromLiveRounds, type LiveTrafficRound } from "../src/course-traffic.js";
import type { Env } from "../src/env.js";

const holes = [
  { hole: 1, par: 3, tee: { lat: 35.60, lng: -77.37 }, target: { lat: 35.601, lng: -77.37 } },
  { hole: 2, par: 3, tee: { lat: 35.61, lng: -77.38 }, target: { lat: 35.611, lng: -77.38 } },
];

describe("trafficFromLiveRounds", () => {
  it("puts a card on the hole its fresh GPS is nearest, and keeps names off the board", () => {
    const rounds: LiveTrafficRound[] = [{
      courseId: 4,
      name: "Farmville DGC",
      lat: 35.6,
      lng: -77.37,
      holes,
      players: [
        { index: 0, cardId: "c0", scores: {} },
        { index: 1, cardId: "c0", scores: { 1: 3 } },
        { index: 2, cardId: "c1", scores: {} },
      ],
      locations: [
        { index: 0, lat: 35.611, lng: -77.38, fresh: true },
        { index: 1, lat: 35.611, lng: -77.38, fresh: true },
      ],
    }];
    const courses = trafficFromLiveRounds(rounds);
    expect(courses).toEqual([{
      courseId: 4,
      name: "Farmville DGC",
      lat: 35.6,
      lng: -77.37,
      groups: 2,
      players: 3,
      holes: [
        { hole: 1, groups: 1, players: 1 },
        { hole: 2, groups: 1, players: 2 },
      ],
    }]);
    expect(JSON.stringify(courses)).not.toMatch(/Kevin|member|initials/);
  });

  it("falls back to the unscored hole when GPS is stale", () => {
    const courses = trafficFromLiveRounds([{
      courseId: 1,
      name: "Crotts",
      holes,
      players: [{ index: 0, cardId: "c0", scores: { 1: 3 } }],
      locations: [{ index: 0, lat: 35.60, lng: -77.37, fresh: false }],
    }]);
    expect(courses[0]?.holes).toEqual([{ hole: 2, groups: 1, players: 1 }]);
  });

  it("merges two live cards on the same course", () => {
    const one: LiveTrafficRound = {
      courseId: 4,
      name: "Farmville DGC",
      holes,
      players: [{ index: 0, cardId: "c0", scores: {} }],
      locations: [],
    };
    const two: LiveTrafficRound = {
      courseId: 4,
      name: "Farmville DGC",
      holes,
      players: [{ index: 0, cardId: "c0", scores: { 1: 2 } }],
      locations: [],
    };
    const courses = trafficFromLiveRounds([one, two]);
    expect(courses).toHaveLength(1);
    expect(courses[0]?.groups).toBe(2);
    expect(courses[0]?.holes.map((hole) => hole.hole).sort()).toEqual([1, 2]);
  });
});

describe("courseTrafficPayload", () => {
  it("reads live snapshots and drops a round that is no longer live", async () => {
    const forgotten: string[] = [];
    const snaps: Record<string, unknown> = {
      "round:ABC123": {
        status: "live",
        courseId: 4,
        courseName: "Farmville DGC",
        holes,
        players: [{ index: 0, cardId: "c0", name: "Kevin Gray", scores: {} }],
        playerLocations: [{ index: 0, lat: 35.601, lng: -77.37, fresh: true }],
      },
      "event:9": { status: "final", courseName: "Gone" },
    };
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() { return this; },
            async all() {
              if (sql.includes("live_round_index")) {
                return {
                  results: [
                    { key: "round:ABC123", course_id: 4, course_name: "Farmville DGC", lat: 35.6, lng: -77.37, started_at: new Date().toISOString() },
                    { key: "event:9", course_id: 9, course_name: "Old", started_at: new Date().toISOString() },
                  ],
                  success: true,
                };
              }
              if (sql.includes("status = 'live'")) return { results: [], success: true };
              return { results: [], success: true };
            },
            async first() { return null; },
            async run() {
              if (sql.startsWith("DELETE")) forgotten.push("deleted");
              return { results: [], success: true };
            },
          };
        },
      },
      LIVE: {
        idFromName(name: string) { return name; },
        get(id: string) {
          return { fetch: async () => Response.json(snaps[id] || { status: "none" }) };
        },
      },
    } as unknown as Env;
    const payload = await courseTrafficPayload(env);
    expect(payload.courses.map((course) => course.name)).toEqual(["Farmville DGC"]);
    expect(payload.courses[0]?.groups).toBe(1);
    expect(JSON.stringify(payload)).not.toMatch(/Kevin Gray/);
    expect(forgotten.length).toBe(1);
  });
});
