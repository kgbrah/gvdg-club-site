import assert from "node:assert/strict";
import test from "node:test";

import { courseCoverage, layoutQuality, mappedHole } from "../src/shared/course-quality.js";
import { createCoursePackStore } from "../src/shared/course-packs.js";
import { coursesForPickScreen, filterCoursesForPick, googleMapsDirectionsUrl, milesFromOrigin } from "../src/score-app/course-pick.js";
import { favoriteOwner, readFavoriteCache, writeFavoriteCache } from "../src/score-app/course-favorites.js";

const tee = { lat: 35.60, lng: -77.37, label: "Gold" };
const target = { lat: 35.601, lng: -77.37, label: "A" };
const course = { id: 8, name: "Rivière Park", location: "Greenville, NC", ...tee };
const mapped = { hole: 1, par: 3, tee, target };
const layout = { id: 12, course_id: 8, name: "Main", total_par: 7, holes: [mapped, { hole: 2, par: 4, tee }], revision: "r1" };

test("coverage reflects missing tees, baskets, positions, and pars per hole", () => {
  const quality = layoutQuality({
    name: "Blue", expected_holes: 6,
    holes: [
      mapped,
      { hole: 2, par: 3, tee, target: { lat: 91, lng: -78 } },
      { hole: 3, par: 4, target, tee: { lat: "", lng: -77 } },
      { hole: 4, par: null, tee, target },
      { hole: 5, par: 4, tee, target: { ...tee } },
    ],
  });
  assert.equal(quality.status, "partial");
  assert.equal(quality.mappedCount, 2);
  assert.equal(quality.holeCount, 6);
  assert.equal(quality.unlistedHoles, 1);
  assert.equal(quality.scorable, false);
  assert.deepEqual(quality.holes.map((hole) => hole.missing), [[], ["basket"], ["tee"], ["par"], ["distinct-positions"]]);
  assert.equal(layoutQuality({ holes: [{ hole: 1, par: 4 }] }).status, "scorable");
  assert.equal(layoutQuality({ holes: [] }).status, "listed");
  assert.equal(layoutQuality({ holes: [mapped, { ...mapped, hole: 2 }] }).status, "full");
  assert.equal(layoutQuality({ holes: [mapped, mapped] }).status, "partial");
  assert.equal(mappedHole({ tee, target: { lat: tee.lat + 1e-10, lng: tee.lng } }), false);
});

test("placeholder pars permit scoring but never turn full geometry into confirmed data", () => {
  const legacy = layoutQuality({ name: "Default (par 3s)", holes: [mapped] });
  assert.equal(legacy.status, "partial");
  assert.equal(legacy.scorable, true);
  assert.equal(legacy.placeholderPars, 1);
  assert.equal(legacy.teeSignPars, 0);
  const legacyDistanceOnly = { ...mapped, distance_source: "tee_sign", tee_sign_key: "distance-only" };
  assert.equal(layoutQuality({ holes: [legacyDistanceOnly] }).teeSignPars, 0);
  const approved = { ...mapped, verified: { par: 3, tee_sign_key: "approved-test" } };
  const afterReview = layoutQuality({ name: "Default (par 3s)", holes: [approved] });
  assert.equal(afterReview.status, "full");
  assert.equal(afterReview.teeSignPars, 1);
  assert.equal(layoutQuality({ name: "Renamed", holes: [{ ...mapped, par_source: "placeholder" }] }).placeholderPars, 1);
  assert.equal(courseCoverage({ mapped: 1 }), "partial");
});

test("search finds layout names and intersecting filters never pin a nonmatching last course", () => {
  const rows = [
    { ...course, coverage: "full", layouts: [{ name: "Blue Timber" }] },
    { id: 9, name: "Riverside Park", coverage: "partial", lat: 35.605, lng: -77.37, layouts: [{ name: "Blue Short" }] },
    { id: 10, name: "East Course", coverage: "full", lat: 39, lng: -77.37, layouts: [{ name: "Blue Timber" }] },
  ];
  const origin = { ...tee };
  assert.deepEqual(filterCoursesForPick(rows, "riviere timber", "all", origin).map((row) => row.id), [8]);
  assert.deepEqual(filterCoursesForPick(rows, "blue", "25", origin, { coverage: "full" }).map((row) => row.id), [8]);
  assert.deepEqual(coursesForPickScreen(rows, "", "25", origin, {
    coverage: "full", favoritesOnly: true, favoriteIds: new Set(["8", "9"]), lastCourseId: 9,
  }).map((row) => row.id), [8]);
  assert.equal(milesFromOrigin({ lat: null, lng: null }, origin), null);
  assert.match(googleMapsDirectionsUrl({ name: "Listed", lat: null, lng: null }), /destination=Listed/);
});

function memoryDriver() {
  const rows = new Map();
  return {
    rows,
    get: async (key) => structuredClone(rows.get(key)),
    put: async (pack) => rows.set(pack.key, structuredClone(pack)),
    list: async () => [...rows.values()].map((row) => structuredClone(row)),
    remove: async (key) => rows.delete(key),
  };
}

test("session reload can read saved data and available schematics independently of the network", async () => {
  const driver = memoryDriver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network offline"); };
  try {
    const first = await createCoursePackStore(driver).save(course, layout, new Date("2026-11-14T15:00:00Z"));
    assert.equal(first.ok, true);
    assert.equal(first.pack.assets.schematicHoles, 1);
    assert.equal(first.pack.quality.holeCount, 2);
    assert.equal(first.pack.assets.satellite, "not-included");
    const reloaded = createCoursePackStore(driver);
    assert.deepEqual((await reloaded.list()).packs, [first.pack]);
    assert.equal((await reloaded.get(8, 12)).pack.layout.holes[1].par, 4);
    assert.equal((await reloaded.get(9, 12)).error, "not-saved");
    assert.equal((await reloaded.remove(8, 12)).ok, true);
    assert.deepEqual((await createCoursePackStore(driver).list()).packs, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an aborted, over-quota, or unconfirmed write never reports the pack saved", async () => {
  const driver = memoryDriver();
  const saved = createCoursePackStore(driver);
  assert.equal((await saved.save(course, layout)).ok, true);
  const quota = createCoursePackStore({ ...driver, put: async () => { throw new DOMException("Full", "QuotaExceededError"); } });
  assert.equal((await quota.save(course, { ...layout, revision: "r2" })).error, "storage-full");
  assert.equal((await saved.get(8, 12)).pack.revision, "r1");
  const aborted = createCoursePackStore({ ...driver, put: async () => { throw new DOMException("Aborted", "AbortError"); } });
  assert.equal((await aborted.save(course, layout)).error, "storage-unavailable");
  const unconfirmed = createCoursePackStore({ ...memoryDriver(), put: async () => {} });
  assert.equal((await unconfirmed.save(course, layout)).error, "could-not-confirm");
  assert.equal((await saved.save(course, { ...layout, holes: [], expected_holes: 2 })).error, "invalid-layout");
  driver.rows.get("8:12").layout.holes[0].par = 9;
  assert.equal((await saved.get(8, 12)).error, "unreadable-pack");
  assert.equal((await saved.list()).unreadable, 1);
});

test("favorites are cached for the signed-in member or a particular open-play identity", () => {
  const jwt = (sub) => "." + Buffer.from(JSON.stringify({ sub })).toString("base64url") + ".";
  const records = new Map();
  const storage = { getItem: (key) => records.get(key), setItem: (key, value) => records.set(key, value) };
  const member = favoriteOwner(jwt("m_jane"), jwt("op_one"));
  const visitor = favoriteOwner("", jwt("op_one"));
  assert.equal(member, "member:m_jane");
  assert.equal(visitor, "open:op_one");
  assert.equal(writeFavoriteCache(member, new Set(["8"]), storage), true);
  assert.equal(writeFavoriteCache(visitor, new Set(["12"]), storage), true);
  assert.deepEqual([...readFavoriteCache(member, storage)], ["8"]);
  assert.deepEqual([...readFavoriteCache(visitor, storage)], ["12"]);
  assert.deepEqual([...readFavoriteCache(favoriteOwner(jwt("m_sam"), jwt("op_one")), storage)], []);
  assert.deepEqual([...readFavoriteCache(favoriteOwner("", jwt("op_two")), storage)], []);
});
