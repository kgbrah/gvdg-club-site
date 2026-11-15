import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCoursePackStore } from "../src/shared/course-packs.js";
import { createLocalRound, offlineRoundOutcome, offlineTargets, parseOfflineRound } from "../src/shared/offline-round.js";

async function savedPack() {
  const packs = new Map();
  const store = createCoursePackStore({
    async put(row) { packs.set(row.key, row); },
    async get(key) { return packs.get(key); },
  });
  const holes = [1, 2, 4, 3].map((hole) => ({ hole, par: 3 }));
  holes[0] = { ...holes[0], target: { lat: 35.001, lng: -82, label: "Older basket" } };
  const { pack } = await store.save({ id: 4, name: "Course" }, { id: 5, name: "Layout", expected_holes: 4, holes });
  return pack;
}

test("doubles match finishes after the clinch and keeps extra entered scores in its snapshot", async () => {
  const pack = await savedPack();
  const round = createLocalRound({ pack, owner: { kind: "open", id: "op_owner" }, names: ["A", "B", "C", "D"],
    format: { groupFormat: "doubles", scoringStyle: "matchplay" }, uuid: randomUUID });
  const [left, right] = offlineTargets(round);
  assert.deepEqual(left.members, ["A", "B"]);
  assert.deepEqual(right.members, ["C", "D"]);
  round.scores[left.id] = { 1: 2, 2: 2, 4: 2, 3: 3 };
  round.scores[right.id] = { 1: 3, 2: 3 };
  assert.equal(offlineRoundOutcome(round).complete, false);
  round.scores[right.id][4] = 3;
  const complete = offlineRoundOutcome(round);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.requiredHoles, [1, 2, 4]);
  assert.equal(complete.match.label, "3&1");
  assert.equal(complete.summaries[0].total, 6);
  round.finishedAt = round.startedAt;
  const archive = parseOfflineRound(round);
  pack.layout.holes[0].target.label = "Later basket";
  assert.equal(archive.source.holes[0].target.label, "Older basket");
  assert.equal(archive.scores[left.id][3], 3);
});

test("archives require an owner and complete supported scores while local rounds can be unlinked", async () => {
  const pack = await savedPack();
  const round = createLocalRound({ pack, owner: null, names: ["Walk-on"],
    format: { groupFormat: "singles", scoringStyle: "stroke" }, uuid: randomUUID });
  assert.equal(round.startedAs, "device");
  assert.equal(round.owner, null);
  round.finishedAt = round.startedAt;
  round.scores = { "player:0": { 1: 2, 2: 3, 3: 3, 4: 4 } };
  assert.equal(parseOfflineRound(round), null);
  round.owner = { kind: "member", id: "m_walkon" };
  const accepted = parseOfflineRound({ ...round, token: "ignored", standings: ["ignored"] });
  assert.equal(accepted.startedAs, "device");
  assert.equal("token" in accepted, false);
  assert.equal("standings" in accepted, false);
  round.scores["player:1"] = { 1: 3 };
  assert.equal(parseOfflineRound(round), null);
});
