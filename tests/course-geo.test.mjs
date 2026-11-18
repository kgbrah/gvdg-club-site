import assert from "node:assert/strict";
import test from "node:test";

import {
  distanceMeters, distanceToSegment, formatDistance, holeCount, layoutHoles, matchSpokenCourse, nearestCourse, nearestHole, point, searchCourses,
} from "../src/shared/course-geo.js";

const courses = [
  { id: 1, name: "Elm Street Park", location: "Greenville, NC", lat: 35.6096, lng: -77.3664 },
  { id: 2, name: "ECU North Rec Complex", location: "Greenville, NC", lat: 35.6355, lng: -77.3540 },
  { id: 3, name: "Covenant Church DGC", location: "Greenville, NC", lat: 35.5960, lng: -77.4210 },
  { id: 4, name: "Lake Park", location: "Kinston, NC", lat: 35.2627, lng: -77.5816 },
  { id: 5, name: "Lake Park", location: "Raleigh, NC", lat: 35.7796, lng: -78.6382 },
  { id: 6, name: "The Farm", location: "Winterville, NC", lat: 35.5290, lng: -77.4011 },
  { id: 7, name: "No Pin", location: "Nowhere", lat: null, lng: null },
];

test("distances", () => {
  assert(Math.abs(distanceMeters(courses[0], courses[1]) - 3100) < 150);
  assert.equal(distanceMeters(courses[0], courses[6]), Infinity);
  assert.equal(point({ lat: 0, lng: 0 }), null, "0,0 is a missing pin");
  // 10 m off the middle of a 100 m east-west line.
  const tee = { lat: 35.6, lng: -77.36 };
  const basket = { lat: 35.6, lng: -77.36 + 100 / (111_320 * Math.cos(35.6 * Math.PI / 180)) };
  const mid = { lat: 35.6 + 10 / 111_320, lng: (tee.lng + basket.lng) / 2 };
  assert(Math.abs(distanceToSegment(mid, tee, basket) - 10) < 0.5);
  assert.equal(formatDistance(200), "Here");
  assert.equal(formatDistance(5_000), "3.1 mi");
  assert.equal(formatDistance(40_000), "25 mi");
});

test("the course you're at, only when you're really there", () => {
  const atElm = { lat: 35.6101, lng: -77.3670 };
  assert.equal(nearestCourse(courses, atElm).course.id, 1);
  assert.equal(nearestCourse(courses, { lat: 35.70, lng: -77.10 }), null, "at home, no course is filled");
  assert.equal(nearestCourse(courses, null), null);
});

test("the hole you're on: closest tee-to-basket line within range", () => {
  const layouts = [{ holes: JSON.stringify([
    { hole: 1, tee: { lat: 35.6000, lng: -77.3600 }, target: { lat: 35.6010, lng: -77.3600 } },
    { hole: 2, tee: { lat: 35.6010, lng: -77.3605 }, target: { lat: 35.6010, lng: -77.3620 } },
    { hole: 3, par: 3 },
  ]) }, { holes: [{ hole: 21, tee: null, target: null }] }];
  const holes = layoutHoles(layouts);
  assert.equal(holes.length, 4);
  assert.equal(holeCount(layouts), 21);
  assert.equal(nearestHole(holes, { lat: 35.6005, lng: -77.3601 }).hole, 1, "beside hole 1's fairway");
  assert.equal(nearestHole(holes, { lat: 35.6011, lng: -77.3615 }).hole, 2);
  assert.equal(nearestHole(holes, { lat: 35.65, lng: -77.36 }), null, "far from every hole");
  assert.deepEqual(layoutHoles([{ holes: "not json" }]), []);
});

test("search: name starts, then word starts, then the town; nearest first on ties", () => {
  assert.deepEqual(searchCourses(courses, "elm").map((row) => row.course.id), [1]);
  assert.deepEqual(searchCourses(courses, "ecu nor").map((row) => row.course.id), [2]);
  assert.deepEqual(searchCourses(courses, "rec").map((row) => row.course.id), [2]);
  assert.deepEqual(searchCourses(courses, "lake", { lat: 35.78, lng: -78.64 }).map((row) => row.course.id), [5, 4], "the Raleigh one is nearer");
  assert.deepEqual(searchCourses(courses, "kinston").map((row) => row.course.id), [4], "town names count too");
  assert.deepEqual(searchCourses(courses, "").map((row) => row.course.id), [], "nothing typed, no location: no list");
  assert.deepEqual(searchCourses(courses, "", { lat: 35.6096, lng: -77.3664 }, 3).map((row) => row.course.id), [1, 2, 3], "nothing typed: nearest");
});

test("a course said by voice", () => {
  assert.equal(matchSpokenCourse("orange destroyer, found it on hole 7 at Elm Street, by the pond", courses)?.id, 1);
  assert.equal(matchSpokenCourse("found it at the ECU north rec complex", courses)?.id, 2);
  assert.equal(matchSpokenCourse("lost it at covenant church", courses)?.id, 3);
  assert.equal(matchSpokenCourse("a blue buzzz at the farm", courses)?.id, 6);
  assert.equal(matchSpokenCourse("found it in the lake on hole 3", courses), null, "the word lake isn't Lake Park");
  assert.equal(matchSpokenCourse("lost it at Lake Park", courses), null, "two Lake Parks, no location: leave it blank");
  assert.equal(matchSpokenCourse("lost it at Lake Park", courses, { lat: 35.27, lng: -77.58 })?.id, 4, "the nearer Lake Park");
  assert.equal(matchSpokenCourse("", courses), null);
});
