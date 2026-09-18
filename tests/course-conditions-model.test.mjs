import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConditionWhen,
  homeConditionRows,
  isStaleCondition,
  latestConditionsByCourse,
  matchCourseCondition,
  normalizeCondition,
  normalizeCourseName,
} from "../src/shared/course-conditions-model.js";

const NOW = Date.parse("2026-09-11T16:00:00Z");

test("normalizeCondition keeps allowlisted status and drops junk", () => {
  assert.equal(normalizeCondition({ status: "muddy" }), null);
  assert.deepEqual(normalizeCondition({
    id: 4,
    course_id: 1,
    course_name: "ECU North Rec Complex",
    member_name: "Jane",
    status: "wet",
    note: "12 is a puddle",
    created_at: "2026-09-11 15:00:00",
  }, NOW), {
    courseId: 1,
    courseName: "ECU North Rec Complex",
    createdAt: "2026-09-11 15:00:00",
    id: "4",
    label: "Wet",
    memberName: "Jane",
    note: "12 is a puddle",
    status: "wet",
    when: "1h ago",
  });
});

test("matchCourseCondition maps homepage cards to catalog names", () => {
  const reports = [
    normalizeCondition({ course_id: 2, course_name: "West Meadowbrook Park", status: "playable", created_at: "2026-09-11 15:30:00", id: 1 }),
    normalizeCondition({ course_id: 7, course_name: "Snipers Landing at Robersonville CC", status: "closed", created_at: "2026-09-11 14:00:00", id: 2 }),
  ];
  assert.equal(matchCourseCondition({ course: "West Meadowbrook Park", name: "West Meadowbrook Park" }, reports).status, "playable");
  assert.equal(matchCourseCondition({ course: "Snipers Landing at Robersonville CC", name: "Snipers Landing" }, reports).status, "closed");
  assert.equal(matchCourseCondition({ course: "Ayden Park", name: "Ayden Park" }, reports), null);
});

test("stale reports are older than 48 hours and names normalize for matching", () => {
  assert.equal(normalizeCourseName("Snipers Landing at Robersonville CC"), "snipers landing at robersonville cc");
  assert.equal(isStaleCondition("2026-09-11 15:00:00", NOW), false);
  assert.equal(isStaleCondition("2026-09-09 15:00:00", NOW), true);
  assert.equal(formatConditionWhen("2026-09-11 15:50:00", NOW), "10m ago");
  assert.equal(latestConditionsByCourse([
    { course_id: 1, course_name: "ECU North Rec Complex", status: "wet", id: 1 },
    { course_id: 1, course_name: "ECU North Rec Complex", status: "dry", id: 2 },
  ]).map((row) => row.status).join(","), "dry");
});

test("homeConditionRows drops stale reports and ranks alerts first", () => {
  const rows = homeConditionRows([
    { id: 1, course_id: 1, course_name: "ECU North Rec Complex", status: "dry", created_at: "2026-09-11 15:00:00" },
    { id: 2, course_id: 2, course_name: "West Meadowbrook Park", status: "wet", created_at: "2026-09-11 15:30:00" },
    { id: 3, course_id: 3, course_name: "Ayden Park", status: "closed", created_at: "2026-09-09 15:00:00" },
    { id: 4, course_id: 4, course_name: "Snipers Landing", status: "flooded", created_at: "2026-09-11 14:00:00" },
  ], NOW, 3);
  assert.deepEqual(rows.map((row) => row.courseName), ["Snipers Landing", "West Meadowbrook Park", "ECU North Rec Complex"]);
});
