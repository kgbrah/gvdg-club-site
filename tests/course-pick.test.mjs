import assert from "node:assert/strict";
import test from "node:test";
import {
  courseHasMap,
  filterCoursesForPick,
  layoutHasMap,
  sortLayoutsForPick,
} from "../src/score-app/course-pick.js";

const ORIGIN = { lat: 35.6127, lng: -77.3664 };

function course(partial) {
  return { id: 1, name: "Course", location: "Greenville, NC", lat: ORIGIN.lat, lng: ORIGIN.lng, ...partial };
}

test("courseHasMap requires tee and pin GPS, not just a default par-3 layout", () => {
  assert.equal(courseHasMap(course({ mapped: 1 })), true);
  assert.equal(courseHasMap(course({ mapped: 0 })), false);
  assert.equal(courseHasMap(course({ holes: [{ hole: 1, par: 3 }] })), false);
  assert.equal(
    courseHasMap(
      course({
        holes: [{ hole: 1, par: 3, tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.601, lng: -77.37 } }],
      }),
    ),
    true,
  );
  assert.equal(
    layoutHasMap({ holes: JSON.stringify([{ hole: 1, par: 3, distance_ft: 250 }]) }),
    false,
  );
});

test("filterCoursesForPick lists mapped courses above unmapped ones regardless of distance", () => {
  const farMapped = course({
    id: 2,
    name: "Far Mapped",
    lat: 36.0,
    lng: -78.9,
    mapped: 1,
  });
  const nearBare = course({
    id: 3,
    name: "Near Bare",
    lat: 35.62,
    lng: -77.37,
    mapped: 0,
  });
  const nearMapped = course({
    id: 4,
    name: "Near Mapped",
    lat: 35.63,
    lng: -77.32,
    mapped: 1,
  });
  const names = filterCoursesForPick([farMapped, nearBare, nearMapped], "", "all").map((row) => row.name);
  assert.deepEqual(names, ["Near Mapped", "Far Mapped", "Near Bare"]);
});

test("filterCoursesForPick keeps mapped-first order inside a search and a 100-mile ring", () => {
  const farMapped = course({ id: 2, name: "Park Mapped", lat: 36.2, lng: -78.5, mapped: 1 });
  const nearBare = course({ id: 3, name: "Park Bare", lat: 35.62, lng: -77.37, mapped: 0 });
  const names = filterCoursesForPick([farMapped, nearBare], "park", "nearby").map((row) => row.name);
  assert.deepEqual(names, ["Park Mapped", "Park Bare"]);
});

test("sortLayoutsForPick puts tee/pin layouts first", () => {
  const bare = { id: 1, name: "Default (par 3s)", holes: [{ hole: 1, par: 3 }] };
  const mapped = {
    id: 2,
    name: "Long",
    holes: [{ hole: 1, par: 3, tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.601, lng: -77.37 } }],
  };
  assert.deepEqual(sortLayoutsForPick([bare, mapped]).map((row) => row.name), ["Long", "Default (par 3s)"]);
});
