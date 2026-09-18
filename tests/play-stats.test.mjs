import assert from "node:assert/strict";
import test from "node:test";

import {
  addHoleToTotals,
  emptyPlayTotals,
  fairwayHit,
  formatPct,
  formatRank,
  holePlayStats,
  holeStatChips,
  parseBreakdown,
  playKindLabel,
  playRowKind,
  playStatsByKind,
  playStatsView,
  rankCategory,
  regulationStrokes,
  roundPlayStats,
  statPct,
  sumPlayTotals,
} from "../src/shared/play-stats.js";

const TEE = { lat: 35.6, lng: -77.37 };
const BASKET = { lat: 35.6008, lng: -77.37 };
const HOLE = { hole: 1, par: 3, tee: TEE, target: BASKET };

function northOf(point, meters) {
  return { lat: point.lat + meters / 111320, lng: point.lng };
}

function eastOf(point, meters) {
  const mPerDegLng = 111320 * Math.cos(point.lat * Math.PI / 180);
  return { lat: point.lat, lng: point.lng + meters / mPerDegLng };
}

test("regulation strokes are par minus two putts", () => {
  assert.equal(regulationStrokes(3), 1);
  assert.equal(regulationStrokes(4), 2);
  assert.equal(regulationStrokes(5), 3);
});

test("fairway hit uses a 45 ft corridor around the tee-to-basket line", () => {
  assert.equal(fairwayHit(northOf(TEE, 40), TEE, BASKET), true);
  assert.equal(fairwayHit(eastOf(northOf(TEE, 40), 30), TEE, BASKET), false);
});

test("holePlayStats marks C1R, C1 putting, and scramble from throw pins", () => {
  const c1 = northOf(BASKET, 8);
  const birdie = holePlayStats(HOLE, [c1], 2);
  assert.equal(birdie.c1r.hit, 1);
  assert.equal(birdie.c1Putt.att, 1);
  assert.equal(birdie.c1Putt.hit, 1);
  assert.equal(birdie.scramble, null);

  const miss = holePlayStats(HOLE, [c1], 3);
  assert.equal(miss.c1Putt.hit, 0);
  assert.equal(miss.c1Putt.att, 1);

  const offline = eastOf(northOf(TEE, 50), 40);
  const scramble = holePlayStats(HOLE, [offline], 3);
  assert.equal(scramble.c1r.hit, 0);
  assert.equal(scramble.fir.hit, 0);
  assert.equal(scramble.scramble.hit, 1);
});

test("roundPlayStats and breakdown parsing keep score mix plus throw stats", () => {
  const totals = roundPlayStats(
    [HOLE, { hole: 2, par: 3, tee: TEE, target: BASKET }],
    { 1: [northOf(BASKET, 8)] },
    { 1: 2, 2: 4 },
  );
  assert.equal(totals.holes, 2);
  assert.equal(totals.birdie_hit, 1);
  assert.equal(totals.par_hit, 1);
  assert.equal(totals.c1r_hit, 1);
  assert.equal(totals.c1r_att, 1);

  const parsed = parseBreakdown('{"eagles":1,"birdies":3,"pars":8,"bogeys":5,"doubles_plus":1,"fir_hit":10,"fir_att":12}');
  assert.equal(parsed.holes, 18);
  assert.equal(parsed.eagles, 1);
  assert.equal(parsed.birdies, 3);
  assert.equal(parsed.birdie_hit, 4);
  assert.equal(parsed.par_hit, 12);
  assert.equal(parsed.fir_hit, 10);
  const summed = sumPlayTotals([parsed, { breakdown: { birdies: 2, pars: 16, bogeys: 0, doubles_plus: 0, eagles: 0 } }]);
  assert.equal(summed.holes, 36);
  assert.equal(summed.birdie_hit, 6);
});

test("club ranks only count members with enough attempts", () => {
  const players = [
    { memberId: "a", name: "Ann", totals: addHoleToTotals(emptyPlayTotals(), HOLE, [northOf(BASKET, 8)], 2) },
    { memberId: "b", name: "Ben", totals: parseBreakdown({ eagles: 2, birdies: 8, pars: 6, bogeys: 2, doubles_plus: 0 }) },
    { memberId: "c", name: "Cara", totals: parseBreakdown({ eagles: 0, birdies: 4, pars: 10, bogeys: 4, doubles_plus: 0 }) },
  ];
  const birdie = rankCategory(players, { att: "holes", hit: "birdie_hit", min: 18 });
  assert.equal(birdie.length, 2);
  assert.equal(birdie[0].name, "Ben");
  assert.equal(birdie[0].rank, 1);
  assert.equal(formatPct(statPct(10, 18)), "55.6%");
  assert.equal(formatRank(3, 22), "#3 of 22");
  const view = playStatsView(players, "b");
  const par = view.find((row) => row.id === "par");
  assert.equal(par.mine.memberId, "b");
  const mix = view.find((row) => row.id === "birdieMix");
  assert.equal(mix.mine.pct, statPct(8, 18));
  const bogey = rankCategory(players, { att: "holes", hit: "bogeys", invert: true, min: 18 });
  assert.equal(bogey[0].name, "Ben");
  const unranked = playStatsView(players, "a").find((row) => row.id === "birdie");
  assert.equal(unranked.mine.rank, null);
  assert.equal(unranked.mine.hit, 1);
  assert.equal(holeStatChips({ fir: { hit: 1, att: 1 }, c1r: { hit: 1, att: 1 } }).map((chip) => chip.label).join(","), "FIR,C1R");
});

test("casual scoring percentages stay out of the competitive club ranks", () => {
  const payload = playStatsByKind([
    { member_id: "b", name: "Ben", kind: "competitive", breakdown: { eagles: 2, birdies: 8, pars: 6, bogeys: 2, doubles_plus: 0 } },
    { member_id: "b", name: "Ben", kind: "casual", breakdown: { eagles: 0, birdies: 16, pars: 2, bogeys: 0, doubles_plus: 0 } },
    { member_id: "c", name: "Cara", kind: "competitive", breakdown: { eagles: 0, birdies: 4, pars: 10, bogeys: 4, doubles_plus: 0 } },
  ], "b");
  const competitiveBirdie = payload.competitive.categories.find((row) => row.id === "birdieMix");
  const casualBirdie = payload.casual.categories.find((row) => row.id === "birdieMix");
  assert.equal(playRowKind({ kind: "casual" }), "casual");
  assert.equal(playKindLabel("casual"), "Casual");
  assert.equal(competitiveBirdie.mine.hit, 8);
  assert.equal(competitiveBirdie.mine.pct, statPct(8, 18));
  assert.equal(competitiveBirdie.mine.rank, 1);
  assert.equal(casualBirdie.mine.hit, 16);
  assert.equal(casualBirdie.mine.pct, statPct(16, 18));
  assert.notEqual(competitiveBirdie.mine.pct, statPct(24, 36));
  assert.equal(payload.casual.categories.find((row) => row.id === "birdieMix").field, 1);
  assert.equal(payload.competitive.mine.totals.holes, 18);
  assert.equal(payload.casual.mine.totals.holes, 18);
  assert.equal(payload.competitive.mine.totals.birdies, 8);
  assert.equal(payload.casual.mine.totals.birdies, 16);
});
