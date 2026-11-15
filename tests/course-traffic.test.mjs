import assert from "node:assert/strict";
import test from "node:test";
import { courseTrafficMatch, trafficHoleLine, trafficSummary } from "../src/shared/course-traffic.js";

test("course traffic labels a busy hole without inventing a group", () => {
  const row = {
    courseId: 4,
    name: "Farmville DGC",
    groups: 2,
    players: 5,
    holes: [
      { hole: 7, groups: 2, players: 4 },
      { hole: 8, groups: 0, players: 1 },
    ],
  };
  assert.equal(trafficSummary(row), "2 groups · 5 players · hole 7");
  assert.equal(trafficHoleLine(row), "H7 · 2 groups   H8 · 1 player");
  assert.equal(courseTrafficMatch([row], { id: 4, name: "Other" }).name, "Farmville DGC");
  assert.equal(courseTrafficMatch([row], { id: 9, name: "Farmville DGC" }).courseId, 4);
  assert.equal(courseTrafficMatch([row], { id: 9, name: "Somewhere else" }), null);
  assert.equal(trafficSummary({ groups: 0 }), "");
});
