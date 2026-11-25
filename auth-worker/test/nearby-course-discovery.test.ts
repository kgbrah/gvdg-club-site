import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { D1Like } from "../src/db-types.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { UDISC_LOCAL_MISS } from "../src/udisc-layout-import.js";

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

async function setup(extraMigrations: string[] = []) {
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
    ...extraMigrations,
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

  function udiscSampleHtml() {
    const pool = [
      /* 0*/ [15, 16],
      /* 1*/ "name",
      /* 2*/ "layoutId",
      /* 3*/ "holes",
      /* 4*/ "par",
      /* 5*/ "holeDistance",
      /* 6*/ "feet",
      /* 7*/ "White",
      /* 8*/ "Blue",
      /* 9*/ 3,
      /*10*/ 4,
      /*11*/ { _6: 12 }, // { feet: 234 }
      /*12*/ 234,
      /*13*/ { _6: 14 }, // { feet: 412 }
      /*14*/ 412,
      /*15*/ { _1: 7, _2: 21, _3: 19 },
      /*16*/ { _1: 8, _2: 22, _3: 20 },
      /*17*/ { _4: 9, _5: 11 }, // par 3, 234 ft
      /*18*/ { _4: 10, _5: 13 }, // par 4, 412 ft
      /*19*/ [17, 18],
      /*20*/ [18, 17],
      /*21*/ 101,
      /*22*/ 102,
    ];
    const encoded = JSON.stringify(JSON.stringify(pool));
    return `<!doctype html><html><head><title>Adventure Park DGC | UDisc</title></head><body>
      <a href="https://app.udisc.com/applink/create-scorecard/1956">Start</a>
      <script>window.__reactRouterContext.streamController.enqueue(${encoded})</script>
    </body></html>`;
  }

  function stubCloudflareCaches() {
    const buckets = new Map<string, Map<string, Response>>();
    vi.stubGlobal("caches", {
      open: async (name: string) => {
        let bucket = buckets.get(name);
        if (!bucket) {
          bucket = new Map();
          buckets.set(name, bucket);
        }
        return {
          match: async (req: Request) => bucket!.get(req.url)?.clone(),
          put: async (req: Request, res: Response) => {
            bucket!.set(req.url, res.clone());
          },
          delete: async (req: Request) => bucket!.delete(req.url),
        };
      },
    });
  }

  it("hydrates UDisc layouts + distances immediately on discover, busts /courses edge cache, and schedules OSM", async () => {
    const { sqlite, env } = await setup(["0030_udisc_layout_imports.sql"]);
    stubCloudflareCaches();
    const bgTasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void bgTasks.push(promise) } as unknown as ExecutionContext;
    const openToken = await signOpenPlaySession({ sub: "op_1234567890abcdef12345678", name: "Traveler" }, SECRET, 900);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://io.discgolfapi.com/v1/courses?region=PA")) {
        return new Response(
          JSON.stringify({
            total: 1,
            courses: [
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
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://udisc.com/api/courses/search")) {
        return new Response(
          JSON.stringify([
            { name: "Adventure Park DGC", shortId: "hbda", locationText: "Mechanicsburg, Pennsylvania" },
          ]),
          { status: 200 },
        );
      }
      if (url === "https://udisc.com/courses/adventure-park-dgc-hbda") {
        return new Response(udiscSampleHtml(), { status: 200 });
      }
      if (url.startsWith("https://api.openstreetmap.org/api/0.6/map.json")) {
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    // Warm GET /courses cache before discovery.
    const beforeCatalog = await worker.fetch(new Request("https://w/courses", { headers: { Origin: ORIGIN } }), env, ctx);
    expect(beforeCatalog.status).toBe(200);
    const beforeBody = (await beforeCatalog.json()) as { courses: { name: string }[] };
    expect(beforeBody.courses.some((c) => c.name === "Adventure Park Disc Golf Course")).toBe(false);

    const createRes = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_adv_high", region: "PA" }),
      }),
      env,
      ctx,
    );
    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as {
      course: { id: number; name: string; udisc_url: string; udisc_course_id: string };
      layouts: { id: number; name: string; total_par: number; holes: string }[];
    };
    expect(body.course.udisc_url).toBe("https://udisc.com/courses/adventure-park-dgc-hbda");
    expect(body.course.udisc_course_id).toBe("1956");
    expect(body.layouts.map((l) => l.name)).toEqual(["White", "Blue"]);
    expect(body.layouts.every((l) => l.name !== "Default (par 3s)")).toBe(true);
    const whiteHoles = JSON.parse(body.layouts[0]!.holes) as { par: number; distance_ft: number; distance_source: string }[];
    expect(whiteHoles[0]).toMatchObject({ par: 3, distance_ft: 234, distance_source: "udisc" });
    expect(whiteHoles[1]).toMatchObject({ par: 4, distance_ft: 412, distance_source: "udisc" });

    const importRow = sqlite.prepare("SELECT status, layouts_imported, udisc_url FROM udisc_layout_imports WHERE course_id = ?").get(body.course.id) as {
      status: string;
      layouts_imported: number;
      udisc_url: string;
    };
    expect(importRow).toEqual({
      status: "imported",
      layouts_imported: 2,
      udisc_url: "https://udisc.com/courses/adventure-park-dgc-hbda",
    });

    await Promise.all(bgTasks);

    // Immediate GET /courses sees the busted edge cache with the new course & hydrated layouts.
    const afterCatalog = await worker.fetch(new Request("https://w/courses", { headers: { Origin: ORIGIN } }), env, ctx);
    const afterBody = (await afterCatalog.json()) as { courses: { name: string; layouts: { name: string }[] }[] };
    const listed = afterBody.courses.find((c) => c.name === "Adventure Park Disc Golf Course");
    expect(listed?.layouts.map((l) => l.name)).toEqual(["White", "Blue"]);

    const roundRes = await worker.fetch(
      new Request("https://w/rounds", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          course_id: body.course.id,
          layout_id: body.layouts[0]!.id,
          liveScoringConfig: { groupFormat: "singles", scoringStyle: "stroke" },
        }),
      }),
      env,
      ctx,
    );
    expect(roundRes.status).toBe(201);
  });

  it("falls back to placeholder on transient UDisc outage and retries on next discover", async () => {
    const { sqlite, env } = await setup(["0030_udisc_layout_imports.sql"]);
    const openToken = await signOpenPlaySession({ sub: "op_1234567890abcdef12345678", name: "Traveler" }, SECRET, 900);
    let udiscHealthy = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://io.discgolfapi.com/v1/courses?region=PA")) {
        return new Response(
          JSON.stringify({
            total: 1,
            courses: [
              {
                id: "crs_adv_high",
                name: "Adventure Park Disc Golf Course",
                lat: 40.2767,
                lon: -77.009,
                locality: "Mechanicsburg",
                region_code: "PA",
                holes: 9,
                confidence_score: 0.85,
                existence_status: "existing",
                operational_status: "open",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (!udiscHealthy && url.startsWith("https://udisc.com/")) {
        return new Response("upstream error", { status: 503 });
      }
      if (url.startsWith("https://udisc.com/api/courses/search")) {
        return new Response(
          JSON.stringify([{ name: "Adventure Park DGC", shortId: "hbda", locationText: "Mechanicsburg, Pennsylvania" }]),
          { status: 200 },
        );
      }
      if (url === "https://udisc.com/courses/adventure-park-dgc-hbda") {
        return new Response(udiscSampleHtml(), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const first = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_adv_high", region: "PA" }),
      }),
      env,
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { course: { id: number }; layouts: { name: string }[] };
    expect(firstBody.layouts.map((l) => l.name)).toEqual(["Default (par 3s)"]);
    const priorImport = sqlite.prepare("SELECT * FROM udisc_layout_imports WHERE course_id = ?").get(firstBody.course.id);
    expect(priorImport).toBeUndefined();

    udiscHealthy = true;
    const second = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_adv_high", region: "PA" }),
      }),
      env,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { created: boolean; layouts: { name: string }[] };
    expect(secondBody.created).toBe(false);
    expect(secondBody.layouts.map((l) => l.name)).toEqual(["White", "Blue"]);
  });

  it("caches a clean UDisc miss as UDISC_LOCAL_MISS so repeat discover does not re-query UDisc", async () => {
    const { sqlite, env } = await setup(["0030_udisc_layout_imports.sql"]);
    const openToken = await signOpenPlaySession({ sub: "op_1234567890abcdef12345678", name: "Traveler" }, SECRET, 900);
    let udiscCalls = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://io.discgolfapi.com/v1/courses?region=PA")) {
        return new Response(
          JSON.stringify({
            total: 1,
            courses: [
              {
                id: "crs_mystery",
                name: "Mystery Backyard Nine",
                lat: 40.25,
                lon: -76.95,
                locality: "Mechanicsburg",
                region_code: "PA",
                holes: 9,
                confidence_score: 0.7,
                existence_status: "existing",
                operational_status: "open",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://udisc.com/")) {
        udiscCalls += 1;
        if (url.includes("/api/courses/search")) return new Response("[]", { status: 200 });
        return new Response("<html><body>No courses</body></html>", { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const first = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_mystery", region: "PA" }),
      }),
      env,
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { course: { id: number }; layouts: { name: string }[] };
    expect(firstBody.layouts.map((l) => l.name)).toEqual(["Default (par 3s)"]);
    expect(udiscCalls).toBe(2);

    const row = sqlite.prepare("SELECT status, error FROM udisc_layout_imports WHERE course_id = ?").get(firstBody.course.id) as {
      status: string;
      error: string;
    };
    expect(row).toEqual({ status: "no_url", error: UDISC_LOCAL_MISS });

    const second = await worker.fetch(
      new Request("https://w/courses/discover", {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: "Bearer " + openToken, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "discgolfapi", source_id: "crs_mystery", region: "PA" }),
      }),
      env,
    );
    expect(second.status).toBe(200);
    expect(udiscCalls).toBe(2);
  });
});
