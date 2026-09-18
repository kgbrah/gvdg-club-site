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
  livePlayStatsView,
  liveRoundStatsFromCard,
  parseBreakdown,
  playKindLabel,
  playRowGroup,
  playRowKind,
  playRowStyle,
  playStatsByKind,
  playStatsView,
  playViewKey,
  rankCategory,
  regulationStrokes,
  roundPlayStats,
  selectPlayStatsView,
  statPct,
  sumPlayTotals,
  totalsFromPdgaScoreLine,
  mergePartnerPlayInputs,
  pdgaRowsFromStats,
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

test("doubles, singles, match play, and stroke stay on separate tracks", () => {
  const payload = playStatsByKind([
    { member_id: "b", name: "Ben", kind: "competitive", group_format: "singles", scoring_style: "stroke", breakdown: { eagles: 0, birdies: 8, pars: 8, bogeys: 2, doubles_plus: 0 } },
    { member_id: "b", name: "Ben", kind: "competitive", group_format: "doubles", scoring_style: "stroke", breakdown: { eagles: 0, birdies: 16, pars: 2, bogeys: 0, doubles_plus: 0 } },
    { member_id: "b", name: "Ben", kind: "competitive", group_format: "singles", scoring_style: "matchplay", breakdown: { eagles: 0, birdies: 4, pars: 12, bogeys: 2, doubles_plus: 0 } },
  ], "b");
  const singles = selectPlayStatsView(payload.competitive, "singles", "all");
  const doubles = selectPlayStatsView(payload.competitive, "doubles", "all");
  const stroke = selectPlayStatsView(payload.competitive, "all", "stroke");
  const matchplay = selectPlayStatsView(payload.competitive, "all", "matchplay");
  const singlesStroke = selectPlayStatsView(payload.competitive, "singles", "stroke");
  assert.equal(playRowGroup({ group_format: "doubles" }), "doubles");
  assert.equal(playRowStyle({ scoring_style: "matchplay" }), "matchplay");
  assert.equal(playViewKey("singles", "stroke"), "singles-stroke");
  assert.equal(singles.mine.totals.birdies, 12);
  assert.equal(doubles.mine.totals.birdies, 16);
  assert.equal(stroke.mine.totals.birdies, 24);
  assert.equal(matchplay.mine.totals.birdies, 4);
  assert.equal(singlesStroke.mine.totals.birdies, 8);
  assert.equal(singlesStroke.mine.totals.holes, 18);
  assert.notEqual(payload.competitive.mine.totals.birdies, doubles.mine.totals.birdies);
});

test("PDGA hole lines become a scoring mix without touching club ranks", () => {
  const mix = totalsFromPdgaScoreLine(
    "2,3,3,5,3,3,4,5,4,4,6,4,3,4,4,3,3,4,,,,,,,,,,,,,,,,,,",
    "3,3,3,4,3,3,3,4,4,3,3,3,3,3,4,3,3,4,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3",
    18,
  );
  assert.equal(mix.holes, 18);
  assert.equal(mix.birdies, 1);
  assert.equal(mix.pars, 10);
  assert.equal(mix.bogeys, 6);
  assert.equal(mix.doubles_plus, 1);
  const payload = playStatsByKind([
    { member_id: "b", name: "Ben", kind: "competitive", breakdown: { eagles: 0, birdies: 8, pars: 8, bogeys: 2, doubles_plus: 0 } },
    { member_id: "b", name: "Ben", kind: "pdga", breakdown: mix },
  ], "b");
  assert.equal(playKindLabel("pdga"), "PDGA");
  assert.equal(payload.competitive.mine.totals.birdies, 8);
  assert.equal(payload.pdga.mine.totals.birdies, 1);
  assert.equal(payload.pdga.mine.totals.holes, 18);
  const fromStats = pdgaRowsFromStats({
    name: "Ben",
    play_rounds: [{ breakdown: mix, group_format: "singles", scoring_style: "stroke" }],
  }, "b", "Ben");
  assert.equal(fromStats[0].kind, "pdga");
  assert.equal(fromStats[0].member_id, "b");
});

test("doubles partners both receive the team hole mix", () => {
  const merged = mergePartnerPlayInputs([
    { scores: { 1: 2 }, throws: { 1: [northOf(BASKET, 8)] } },
    { scores: {}, throws: {} },
  ]);
  const play = roundPlayStats([HOLE], merged.throws, merged.scores);
  assert.equal(play.holes, 1);
  assert.equal(play.birdies, 1);
  assert.equal(play.c1r_hit, 1);
});

test("live round stats update from scored holes and marked lies", () => {
  const holes = [HOLE, { hole: 2, par: 3, tee: TEE, target: BASKET }];
  const empty = liveRoundStatsFromCard({ holes, holeGrid: holes.map((hole, index) => ({ hole: hole.hole, index, score: null })) });
  assert.equal(empty.totals.holes, 0);
  assert.equal(empty.mix.find((row) => row.id === "birdieMix").mine.hit, 0);
  assert.equal(empty.throwStats.find((row) => row.id === "fir").mine.att, 0);
  assert.equal(livePlayStatsView(empty.totals).find((row) => row.id === "par").mine.pct, null);

  const live = liveRoundStatsFromCard({
    holes,
    holeGrid: [
      { hole: 1, score: 2 },
      { hole: 2, score: 3 },
    ],
    throwsByHole: { 1: [northOf(BASKET, 8)] },
  });
  assert.equal(live.totals.holes, 2);
  assert.equal(live.mix.find((row) => row.id === "birdieMix").mine.hit, 1);
  assert.equal(live.mix.find((row) => row.id === "parMix").mine.hit, 1);
  assert.equal(live.throwStats.find((row) => row.id === "c1r").mine.hit, 1);
  assert.equal(live.throwStats.find((row) => row.id === "birdie").mine.pct, statPct(1, 2));
});
