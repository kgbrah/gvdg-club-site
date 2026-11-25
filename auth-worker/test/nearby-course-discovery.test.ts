import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { D1Like } from "../src/db-types.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";

const SECRET = "z".repeat(40);
const ORIGIN = "https://gvdgclub.com";

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

function liveStub() {
  const starts: unknown[] = [];
  return {
    starts,
    LIVE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url;
          const path = new URL(url).pathname;
          if (path.endsWith("/start")) {
            const raw = typeof init?.body === "string" ? init.body : "";
            starts.push(raw ? JSON.parse(raw) : {});
            return new Response(JSON.stringify({ status: "live" }), { status: 200 });
          }
          if (path.endsWith("/snapshot")) {
            return new Response(JSON.stringify({ status: "none" }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        },
      }),
    },
  };
}

async function setup() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "0001_init.sql",
    "0003_course_positions.sql",
    "0005_registration.sql",
    "0010_kv_store.sql",
    "0015_udisc_export.sql",
    "0016_casual_rounds.sql",
    "0018_live_scoring_metadata.sql",
    "0028_course_map_marks.sql",
    "0034_hole_shot_marks.sql",
    "0039_throw_clips.sql",
    "0040_round_messages.sql",
    "0046_throw_clip_recovery.sql",
    "0048_course_discovery.sql",
    "0049_private_shot_ledgers.sql",
    "0055_spectator_privacy.sql",
  ]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO courses (id, name, location, lat, lng, is_default)
    VALUES
      (1, 'ECU North Rec Complex', 'Greenville, NC', 35.631092, -77.319923, 1),
      (2, 'Already Listed PA', 'Mechanicsburg, PA', 40.2810, -76.9500, 1);
  `);
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          values = bound;
          return stmt;
        },
        async all() {
          return { results: sqlite.prepare(query).all(...(values as never[])), success: true };
        },
        async first() {
          return sqlite.prepare(query).get(...(values as never[])) ?? null;
        },
        async run() {
          const result = sqlite.prepare(query).run(...(values as never[]));
          return { results: [], success: true, meta: { changes: result.changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Like;

  const live = liveStub();
  const env = {
    ROSTER: kv({
      "member:m_alice": JSON.stringify({
        memberId: "m_alice",
        name: "Alice",
        pinHash: "x",
        mustChangePin: false,
      }),
    }),
    RATELIMIT: kv(),
    DB: db,
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: live.LIVE,
  } as unknown as Parameters<typeof worker.fetch>[1];

  return { sqlite, env, live };
}

function mockDiscGolfApiPa() {
  const payload = {
    total: 4,
    courses: [
      {
        id: "crs_adv_low",
        name: "Adventure Park Disc Golf Course",
        lat: 40.2766,
        lon: -77.0089,
        locality: "Mechanicsburg",
        region_code: "PA",
        holes: 9,
        confidence_score: 0.55,
        existence_status: "existing",
        operational_status: "open",
      },
      {
        id: "crs_adv_high",
        name: "Adventure Park Disc Golf Course",
        lat: 40.2767,
        lon: -77.009,
        locality: "Mechanicsburg",
        region_code: "PA",
        holes: 18,
        confidence_score: 0.85,
        existence_status: "existing",
        operational_status: "open",
      },
      {
        id: "crs_existing_pa",
        name: "Already Listed PA",
        lat: 40.281,
        lon: -76.95,
        locality: "Mechanicsburg",
        region_code: "PA",
        holes: 18,
        confidence_score: 0.85,
        existence_status: "existing",
        operational_status: "open",
      },
      {
        id: "crs_boulder_woods",
        name: "Boulder Woods Disc Golf",
        lat: 40.0725,
        lon: -76.8935,
        locality: "Lewisberry",
        region_code: "PA",
        holes: 18,
        confidence_score: 0.75,
        existence_status: "existing",
        operational_status: "open",
      },
    ],
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://io.discgolfapi.com/v1/courses?region=PA")) {
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ total: 0, courses: [] }), { status: 200 });
  });
}

describe("on-demand nearby course discovery routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns sorted, deduped PA courses near Harrisburg and caches the region", async () => {
    const { env } = await setup();
    const fetchSpy = mockDiscGolfApiPa();

    const missing = await worker.fetch(new Request("https://w/courses/nearby", { headers: { Origin: ORIGIN } }), env);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "location_required" });

    const zero = await worker.fetch(
      new Request("https://w/courses/nearby?lat=0&lng=0", { headers: { Origin: ORIGIN } }),
      env,
    );
    expect(zero.status).toBe(400);

    const first = await worker.fetch(
      new Request("https://w/courses/nearby?lat=40.2732&lng=-76.8867&miles=25", { headers: { Origin: ORIGIN } }),
      env,
    );
    expect(first.status).toBe(200);
    const body1 = (await first.json()) as {
      attribution: string;
      courses: { id: string; source_id: string; name: string; location: string; region: string; miles: number; external: boolean; coverage: string }[];
    };
    expect(body1.attribution).toBe("Course data supplied by DiscGolfAPI.");
    expect(body1.courses.map((c) => c.source_id)).toEqual(["crs_adv_high", "crs_boulder_woods"]);
    expect(body1.courses[0]).toMatchObject({
      external: true,
      name: "Adventure Park Disc Golf Course",
      location: "Mechanicsburg, PA",
      region: "PA",
      coverage: "scorable",
    });
    const fetchCountAfterFirst = fetchSpy.mock.calls.length;
    expect(fetchCountAfterFirst).toBeGreaterThan(0);

    // Second request uses cached D1KV region data without calling DiscGolfAPI again.
    const second = await worker.fetch(
      new Request("https://w/courses/nearby?lat=40.2732&lng=-76.8867&miles=25", { headers: { Origin: ORIGIN } }),
      env,
    );
    expect(second.status).toBe(200);
    expect(fetchSpy.mock.calls.length).toBe(fetchCountAfterFirst);
  });

  it("materializes an external PA course idempotently, ignores client spoofing, and starts a casual round", async () => {
    const { sqlite, env } = await setup();
    mockDiscGolfApiPa();
    const openToken = await signOpenPlaySession({ sub: "op_1234567890abcdef12345678", name: "Traveler" }, SECRET, 900);
    const memberToken = await signSession({ sub: "m_alice", mustChangePin: false }, SECRET, 900);

    const unauth = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_adv_high", region: "PA" }),
      }),
      env,
    );
    expect(unauth.status).toBe(401);

    const badReq = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "evil", source_id: "crs_adv_high", region: "PA" }),
      }),
      env,
    );
    expect(badReq.status).toBe(400);

    const unknown = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_does_not_exist", region: "PA" }),
      }),
      env,
    );
    expect(unknown.status).toBe(404);

    // Send spoofed name/lat/lng alongside valid source_id/region; server must use DiscGolfAPI record.
    const createRes = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "discgolfapi",
          source_id: "crs_adv_high",
          region: "PA",
          name: "Spoofed Course",
          lat: 0,
          lng: 0,
        }),
      }),
      env,
    );
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as {
      created: boolean;
      course: { id: number; name: string; location: string; lat: number; lng: number; is_default: number; created_by: string; coverage: string };
      layouts: { id: number; name: string; expected_holes: number; total_par: number }[];
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.course).toMatchObject({
      name: "Adventure Park Disc Golf Course",
      location: "Mechanicsburg, PA",
      lat: 40.2767,
      lng: -77.009,
      is_default: 0,
      created_by: "nearby-discover",
      coverage: "scorable",
    });
    expect(createdBody.layouts).toHaveLength(1);
    expect(createdBody.layouts[0]).toMatchObject({
      name: "Default (par 3s)",
      expected_holes: 18,
      total_par: 54,
    });

    // Calling discover a second time as a member is idempotent and returns the same course row.
    const repeatRes = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + memberToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_adv_high", region: "PA" }),
      }),
      env,
    );
    expect(repeatRes.status).toBe(200);
    const repeatBody = (await repeatRes.json()) as { created: boolean; course: { id: number } };
    expect(repeatBody.created).toBe(false);
    expect(repeatBody.course.id).toBe(createdBody.course.id);

    const countRow = sqlite.prepare("SELECT count(*) AS n FROM courses WHERE name = ?").get("Adventure Park Disc Golf Course") as { n: number };
    expect(countRow.n).toBe(1);

    // Start a casual round immediately on the materialized layout.
    const roundRes = await worker.fetch(
      new Request("https://w/rounds", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          course_id: createdBody.course.id,
          layout_id: createdBody.layouts[0]!.id,
          liveScoringConfig: { groupFormat: "singles", scoringStyle: "stroke" },
        }),
      }),
      env,
    );
    expect(roundRes.status).toBe(201);
    const roundBody = (await roundRes.json()) as { code: string };
    expect(roundBody.code).toMatch(/^[A-Z0-9]{6}$/);
  });
});
