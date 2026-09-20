import assert from "node:assert/strict";
import test from "node:test";
import {
  courseHasMap,
  courseSub,
  filterCoursesForPick,
  googleMapsDirectionsUrl,
  layoutHasMap,
  milesFromOrigin,
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
  const names = filterCoursesForPick([farMapped, nearBare, nearMapped], "", "all", ORIGIN).map((row) => row.name);
  assert.deepEqual(names, ["Near Mapped", "Far Mapped", "Near Bare"]);
});

test("filterCoursesForPick keeps mapped-first order inside a search and a 100-mile ring", () => {
  const farMapped = course({ id: 2, name: "Park Mapped", lat: 36.2, lng: -78.5, mapped: 1 });
  const nearBare = course({ id: 3, name: "Park Bare", lat: 35.62, lng: -77.37, mapped: 0 });
  const names = filterCoursesForPick([farMapped, nearBare], "park", "nearby", ORIGIN).map((row) => row.name);
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

test("course distances and range rings use the supplied origin, not a hardcoded club", () => {
  const ashe = { lat: 36.4207, lng: -81.4715 };
  const ashePark = course({ id: 10, name: "Ashe County Park", location: "Jefferson, NC", lat: 36.4201, lng: -81.4708 });
  const ayden = course({ id: 11, name: "Ayden Park", location: "Ayden, NC", lat: 35.4892, lng: -77.4268 });
  assert.ok(milesFromOrigin(ashePark, ashe) < 2);
  assert.ok(milesFromOrigin(ayden, ashe) > 100);
  assert.equal(courseSub(ashePark, ashe), "0.1 mi · Jefferson, NC");
  assert.equal(courseSub(ashePark), "Jefferson, NC");
  const nearbyFromAshe = filterCoursesForPick([ashePark, ayden], "", "nearby", ashe).map((row) => row.name);
  assert.deepEqual(nearbyFromAshe, ["Ashe County Park"]);
  const beforeGps = filterCoursesForPick([ashePark, ayden], "", "nearby").map((row) => row.name);
  assert.deepEqual(beforeGps, ["Ashe County Park", "Ayden Park"]);
});

test("googleMapsDirectionsUrl uses GPS when present and name otherwise", () => {
  const withGps = googleMapsDirectionsUrl(course({ lat: 35.6264, lng: -77.375 }));
  assert.match(withGps, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.match(withGps, /destination=35.6264%2C-77.375/);
  assert.match(withGps, /travelmode=driving/);
  const fromAshe = googleMapsDirectionsUrl(course({ lat: 35.6264, lng: -77.375 }), { lat: 36.42, lng: -81.47 });
  assert.match(fromAshe, /origin=36.42%2C-81.47/);
  const named = googleMapsDirectionsUrl({ name: "Ayden Park", location: "Ayden, NC" });
  assert.match(named, /destination=Ayden\+Park%2C\+Ayden%2C\+NC/);
  assert.equal(googleMapsDirectionsUrl({}), "");
});
