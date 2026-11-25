import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Like } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import { parseOsmDiscGolfHoles } from "../src/imports/osm-disc-golf.js";
import { OSM_MAPS_D1KV_NS, enrichCoursePinsFromOsm } from "../src/osm-course-map.js";
import { D1KV } from "../src/d1kv.js";
import { COURSE_CATALOG_CACHE_NAME, COURSE_CATALOG_CACHE_URL } from "../src/course-catalog-cache.js";

function makeDb(sqlite: { prepare: (q: string) => { all: (...args: never[]) => unknown[]; get: (...args: never[]) => unknown; run: (...args: never[]) => { changes: number } } }): D1Like {
  return {
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
}

async function setupCourseDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "0001_init.sql",
    "0003_course_positions.sql",
    "0008_tee_signs.sql",
    "0010_kv_store.sql",
    "0015_udisc_export.sql",
    "0028_course_map_marks.sql",
    "0030_udisc_layout_imports.sql",
  ]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  return { sqlite, db: makeDb(sqlite as never) };
}

describe("parseOsmDiscGolfHoles", () => {
  it("extracts ways (including reversed basket->tee) and standalone tee/basket nodes while separating neighboring courses", () => {
    const payload = {
      elements: [
        // Two neighboring courses inside Pinchot State Park (~700m apart)
        { type: "node", id: 1, lat: 40.0701, lon: -76.8875, tags: { leisure: "disc_golf_course", name: "Boulder Woods Disc Golf" } },
        { type: "node", id: 2, lat: 40.0755, lon: -76.8960, tags: { leisure: "disc_golf_course", name: "Quaker's Challenge Disc Golf" } },

        // Boulder Woods Hole 1 (way tee -> basket)
        { type: "node", id: 101, lat: 40.0702, lon: -76.8874, tags: { disc_golf: "tee" } },
        { type: "node", id: 102, lat: 40.0710, lon: -76.8874, tags: { disc_golf: "basket" } },
        { type: "way", id: 1001, nodes: [101, 102], tags: { disc_golf: "hole", ref: "1", par: "3" } },

        // Boulder Woods Hole 2 (reversed way basket -> tee)
        { type: "node", id: 103, lat: 40.0712, lon: -76.8870, tags: { disc_golf: "basket" } },
        { type: "node", id: 104, lat: 40.0703, lon: -76.8870, tags: { disc_golf: "tee" } },
        { type: "way", id: 1002, nodes: [103, 104], tags: { disc_golf: "hole", ref: "2", par: "4" } },

        // Boulder Woods Hole 3 (standalone tee + basket nodes with matching ref)
        { type: "node", id: 105, lat: 40.0705, lon: -76.8866, tags: { disc_golf: "tee", ref: "3" } },
        { type: "node", id: 106, lat: 40.0713, lon: -76.8866, tags: { disc_golf: "basket", ref: "3" } },

        // Quaker's Challenge Hole 1 (closer to Quaker's Challenge than Boulder Woods)
        { type: "node", id: 201, lat: 40.0756, lon: -76.8958, tags: { disc_golf: "tee" } },
        { type: "node", id: 202, lat: 40.0764, lon: -76.8958, tags: { disc_golf: "basket" } },
        { type: "way", id: 2001, nodes: [201, 202], tags: { disc_golf: "hole", ref: "1", par: "3" } },
      ],
    };

    const boulderHoles = parseOsmDiscGolfHoles(payload, { name: "Boulder Woods Disc Golf", lat: 40.0701, lng: -76.8875 });
    expect(boulderHoles.map((h) => h.hole)).toEqual([1, 2, 3]);
    expect(boulderHoles[0]).toMatchObject({
      hole: 1,
      par: 3,
      tee: { label: "Hole 1 tee", lat: 40.0702, lng: -76.8874, source: "osm" },
      target: { label: "Hole 1 basket", lat: 40.0710, lng: -76.8874, source: "osm" },
    });
    // Hole 2 was reversed in OSM, so tee and target must be normalized back to tee -> basket.
    expect(boulderHoles[1]!.tee).toMatchObject({ lat: 40.0703, lng: -76.8870, source: "osm" });
    expect(boulderHoles[1]!.target).toMatchObject({ lat: 40.0712, lng: -76.8870, source: "osm" });

    // Quaker's Challenge must NOT absorb Boulder Woods holes 1/2/3 even within 750m; <3 Quaker holes -> [].
    const quakerHoles = parseOsmDiscGolfHoles(payload, { name: "Quaker's Challenge at Pinchot State Park", lat: 40.0755, lng: -76.8960 });
    expect(quakerHoles).toEqual([]);
  });
});

describe("enrichCoursePinsFromOsm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fills missing pins with source='osm', keeps verified/existing pins untouched, adds positions, busts cache, and caches misses", async () => {
    const { sqlite, db } = await setupCourseDb();
    sqlite.exec(`
      INSERT INTO courses (id, name, location, lat, lng, is_default) VALUES
        (1, 'Pinchot Boulder Woods', 'Lewisberry, PA', 40.0701, -76.8875, 0),
        (2, 'Empty Course', 'Mechanicsburg, PA', 40.27, -77.01, 0);
      INSERT INTO course_layouts (id, course_id, name, holes, total_par) VALUES
        (10, 1, 'Main', '${JSON.stringify([
          { hole: 1, par: 3, tee: null, target: null, verified: { par: 4, distance_ft: 420, tee_sign_key: "k1" } },
          { hole: 2, par: 3, tee: { label: "Existing tee", lat: 40.0705, lng: -76.8871 }, target: { label: "Existing basket", lat: 40.0713, lng: -76.8871 } },
          { hole: 3, par: 3, udisc_distance_ft: 240, tee: null, target: null },
        ])}', 9),
        (20, 2, 'Main', '${JSON.stringify([{ hole: 1, par: 3 }])}', 3);
    `);

    const deletedUrls: string[] = [];
    vi.stubGlobal("caches", {
      open: async (name: string) => {
        expect(name).toBe(COURSE_CATALOG_CACHE_NAME);
        return {
          delete: async (req: Request) => {
            deletedUrls.push(req.url);
            return true;
          },
        };
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("40.0")) {
        return new Response(
          JSON.stringify({
            elements: [
              { type: "node", id: 1, lat: 40.0701, lon: -76.8875, tags: { leisure: "disc_golf_course", name: "Pinchot Boulder Woods" } },
              { type: "node", id: 11, lat: 40.0702, lon: -76.8875, tags: { disc_golf: "tee" } },
              { type: "node", id: 12, lat: 40.0710, lon: -76.8875, tags: { disc_golf: "basket" } },
              { type: "way", id: 101, nodes: [11, 12], tags: { disc_golf: "hole", ref: "1" } },
              { type: "node", id: 13, lat: 40.0700, lon: -76.8870, tags: { disc_golf: "tee" } },
              { type: "node", id: 14, lat: 40.0709, lon: -76.8870, tags: { disc_golf: "basket" } },
              { type: "way", id: 102, nodes: [13, 14], tags: { disc_golf: "hole", ref: "2" } },
              { type: "node", id: 15, lat: 40.0706, lon: -76.8866, tags: { disc_golf: "tee" } },
              { type: "node", id: 16, lat: 40.0715, lon: -76.8866, tags: { disc_golf: "basket" } },
              { type: "way", id: 103, nodes: [15, 16], tags: { disc_golf: "hole", ref: "3" } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });

    const env = { DB: db } as unknown as Env;
    const res = await enrichCoursePinsFromOsm(env, { id: 1, name: "Pinchot Boulder Woods", lat: 40.0701, lng: -76.8875 });
    expect(res).toEqual({ action: "applied", holesApplied: 2, layoutsUpdated: 1 });
    expect(deletedUrls).toContain(COURSE_CATALOG_CACHE_URL);

    const layoutRow = sqlite.prepare("SELECT holes, total_par FROM course_layouts WHERE id = 10").get() as { holes: string; total_par: number };
    const savedHoles = JSON.parse(layoutRow.holes) as Array<{
      hole: number;
      par: number;
      distance_ft: number;
      distance_source: string;
      tee?: { label?: string; lat?: number; lng?: number; source?: string };
      target?: { label?: string; lat?: number; lng?: number; source?: string };
      verified?: { par: number; distance_ft: number; tee_sign_key: string };
    }>;

    // Hole 1 gets OSM coords for map rendering, while sticky verified par/distance stay intact.
    expect(savedHoles[0]!.tee).toMatchObject({ lat: 40.0702, lng: -76.8875, source: "osm" });
    expect(savedHoles[0]!.verified).toEqual({ par: 4, distance_ft: 420, tee_sign_key: "k1" });
    expect(savedHoles[0]).toMatchObject({ par: 4, distance_ft: 420, distance_source: "tee_sign" });

    // Hole 2 already had existing GPS pins -> untouched.
    expect(savedHoles[1]!.tee).toEqual({ label: "Existing tee", lat: 40.0705, lng: -76.8871 });

    // Hole 3 gets OSM pins and upgrades from udisc to geo distance.
    expect(savedHoles[2]!.tee).toMatchObject({ label: "Hole 3 tee", lat: 40.0706, lng: -76.8866, source: "osm" });
    expect(savedHoles[2]!.distance_source).toBe("geo");

    const positions = sqlite.prepare("SELECT kind, label FROM course_positions WHERE course_id = 1 ORDER BY kind, label").all() as { kind: string; label: string }[];
    expect(positions).toHaveLength(4);

    // Miss is cached in osm_maps D1KV so subsequent non-forced call skips immediately.
    const missRes = await enrichCoursePinsFromOsm(env, { id: 2, name: "Empty Course", lat: 40.27, lng: -77.01 });
    expect(missRes).toEqual({ action: "miss" });
    expect(await new D1KV(db as never, OSM_MAPS_D1KV_NS).get("c:2")).toBe("miss");
    const cachedSkip = await enrichCoursePinsFromOsm(env, { id: 2, name: "Empty Course", lat: 40.27, lng: -77.01 });
    expect(cachedSkip).toEqual({ action: "skipped" });
  });
});
