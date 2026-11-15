import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleCourseFavorites } from "../src/course-favorite-routes.js";
import { listCoursesCatalog, listPublicLayoutsCatalog } from "../src/db-courses.js";
import type { D1Like } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import { sanitizeHoles } from "../src/input.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

async function database() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init.sql", "0028_course_map_marks.sql", "0048_course_discovery.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO courses (id, name) VALUES (1, 'Woods'), (2, 'Other Park'), (3, 'Only listed');
    INSERT INTO course_layouts (id, course_id, name, holes, total_par)
      VALUES (11, 1, 'Blue Loop', '[{"hole":1,"par":3,"tee":{"lat":35.60,"lng":-77.37},"target":{"lat":35.601,"lng":-77.37}},{"hole":2,"par":4}]', 7),
        (22, 2, 'Default (par 3s)', '[{"hole":1,"par":3}]', 3);
    INSERT INTO course_map_consensus (layout_id, hole, kind, lat, lng, samples, members, published, updated_at)
      VALUES (11, 2, 'tee', 35.60, -77.37, 2, 2, 1, '2026-05-12 10:00:00'),
        (11, 2, 'target', 91, -77.371, 2, 2, 1, '2026-05-12 10:00:00'),
        (22, 1, 'target', 35.603, -77.372, 2, 2, 0, '2026-05-12 10:00:00');
  `);
  const db = {
    prepare(query: string) {
      let values: never[] = [];
      const statement = {
        bind(...bound: never[]) { values = bound; return statement; },
        async all() { return { results: sqlite.prepare(query).all(...values), success: true }; },
        async first() { return sqlite.prepare(query).get(...values) || null; },
        async run() { const result = sqlite.prepare(query).run(...values); return { results: [], success: true, meta: { changes: result.changes } }; },
      };
      return statement;
    },
  } as unknown as D1Like;
  const roster = { get: async (key: string) => /^member:m_[ab]$/.test(key) ?
    JSON.stringify({ memberId: key.slice(7), name: "Player", pinHash: "", pinVer: 2, mustChangePin: false }) : null };
  const env = { DB: db, ROSTER: roster, JWT_SECRET: SECRET } as unknown as Env;
  return { sqlite, db, env };
}

describe("course catalog coverage and freshness", () => {
  it("counts valid published geometry per hole while preserving the editor’s original layout", async () => {
    const { db, sqlite } = await database();
    const catalog = await listCoursesCatalog(db);
    expect(catalog.results.find((row) => row.id === 1)).toMatchObject({
      mapped: 1, coverage: "partial", layouts: [{ name: "Blue Loop", coverage: "partial", updated_at: "2026-05-12 10:00:00" }],
    });
    expect(catalog.results.find((row) => row.id === 2)).toMatchObject({ mapped: 0, coverage: "scorable" });
    expect(catalog.results.find((row) => row.id === 3)).toMatchObject({ mapped: 0, coverage: "listed" });
    const first = (await listPublicLayoutsCatalog(db, 1)).results[0]!;
    expect(first.quality).toMatchObject({ status: "partial", mappedCount: 1, holeCount: 2, teeSignPars: 0 });
    expect(first.map_updated_at).toBe("2026-05-12 10:00:00");
    expect(first.map_holes).toMatchObject([{}, { hole: 2, tee: { source: "community" } }]);
    expect(JSON.parse(String(first.holes))[1]).toEqual({ hole: 2, par: 4 });

    sqlite.exec("UPDATE course_map_consensus SET lat = 35.603 WHERE layout_id = 11 AND hole = 2 AND kind = 'target'");
    const complete = (await listPublicLayoutsCatalog(db, 1)).results[0]!;
    expect(complete.quality).toMatchObject({ status: "full", mappedCount: 2, teeSignPars: 0 });
    expect(complete.revision).not.toBe(first.revision);
    sqlite.exec("UPDATE course_layouts SET name = 'Blue revised' WHERE id = 11");
    const edited = sqlite.prepare("SELECT updated_at FROM course_layouts WHERE id = 11").get();
    expect(edited?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("keeps imported par provenance without letting clients claim tee sign verification", () => {
    const holes = sanitizeHoles([
      { hole: 1, par: 3, par_source: "placeholder" },
      { hole: 2, par: 4, par_source: "udisc" },
      { hole: 3, par: 4, par_source: "tee-sign", verified: { par: 4, tee_sign_key: "fake" } },
    ])!;
    expect(holes[0]).toMatchObject({ par_source: "placeholder" });
    expect(holes[1]).toMatchObject({ par_source: "udisc" });
    expect(holes[2]).not.toHaveProperty("par_source");
    expect(holes[2]).not.toHaveProperty("verified");
  });

  it("retains a declared hole count when only one hole has been recorded", async () => {
    const { db, sqlite } = await database();
    sqlite.exec(`INSERT INTO course_layouts (id, course_id, name, holes, total_par, expected_holes)
      VALUES (33, 3, 'Front and Back', '[{"hole":1,"par":3,"tee":{"lat":35.60,"lng":-77.37},"target":{"lat":35.601,"lng":-77.37}}]', 3, 18)`);
    expect((await listCoursesCatalog(db)).results.find((row) => row.id === 3)).toMatchObject({
      coverage: "partial", layouts: [{ expected_holes: 18 }],
    });
    expect((await listPublicLayoutsCatalog(db, 3)).results[0]).toMatchObject({
      expected_holes: 18, quality: { status: "partial", mappedCount: 1, holeCount: 18, unlistedHoles: 17 },
    });
  });
});

describe("account course favorites", () => {
  it("makes an idempotent favorite private to the signed-in member", async () => {
    const { env } = await database();
    const a = await signSession({ sub: "m_a", pinVer: 2, mustChangePin: false }, SECRET, 900);
    const b = await signSession({ sub: "m_b", pinVer: 2, mustChangePin: false }, SECRET, 900);
    const open = await signOpenPlaySession({ sub: "op_guest", name: "Guest" }, SECRET, 900);
    const request = (method: string, token: string, tail = "") => handleCourseFavorites(new Request(
      "https://auth.gvdgclub.com/me/course-favorites" + tail, { method, headers: { Authorization: "Bearer " + token } },
    ), env, ORIGIN);
    expect((await request("GET", open)).status).toBe(401);
    expect((await request("PUT", a, "/999")).status).toBe(404);
    expect((await request("PUT", a, "/1?memberId=m_b")).status).toBe(200);
    expect((await request("PUT", a, "/1")).status).toBe(200);
    expect((await request("PUT", b, "/2")).status).toBe(200);
    expect((await request("DELETE", b, "/1")).status).toBe(200);
    const own = await request("GET", a, "?memberId=m_b");
    expect(own.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await own.json()).toEqual({ courseIds: [1] });
    expect(await (await request("GET", b)).json()).toEqual({ courseIds: [2] });
    await request("DELETE", a, "/1");
    expect(await (await request("GET", a)).json()).toEqual({ courseIds: [] });
  });
});
