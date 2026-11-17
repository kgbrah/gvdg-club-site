import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineProvenance, clubCalendarDay, clubPlaces, compareLayoutGeometry, discoverableEvent, evaluatePdgaBaselines, matchPdgaLayout,
  median, ourLayoutHoles, parsePdgaEvent, parsePdgaRound, parseRatingDetailEvents, pdgaBaselineFor, pdgaEventComplete, pdgaRoundTasks,
  type BaselineRound, type OurCourse, type PdgaHole, type ValidationPdgaRound,
} from "../src/pdga-baselines.js";
import { pointsPerThrow, roundRatingForScore } from "../src/rating-engine.js";

// Real PDGA live-results responses (event 104547, the 2026 Yard Gnomes Open) with player names,
// PDGA numbers, home cities and player ratings removed. The club layouts are our public course data.
const fixture = (name: string) => JSON.parse(readFileSync(new URL("./fixtures/pdga/" + name, import.meta.url), "utf8"));

function clubCourses(): OurCourse[] {
  return fixture("club-courses-sample.json").map((course: OurCourse & { layouts: { id: number; name: string; holes: unknown }[] }) => ({
    ...course, layouts: course.layouts.map((layout) => ({ ...layout, holes: ourLayoutHoles(layout.holes)! })),
  }));
}

const holes = (lengths: (number | null)[], par = 3): PdgaHole[] => lengths.map((lengthFt, index) => ({ hole: index + 1, par, lengthFt }));
const ours = (lengths: (number | null)[], par = 3) => lengths.map((distanceFt, index) => ({ hole: index + 1, par, distanceFt }));

describe("PDGA live-results parsers", () => {
  it("reads the event summary, round dates, divisions and both layouts with per-hole par and length", () => {
    const event = parsePdgaEvent(fixture("event-104547.json"), 104547)!;
    expect(event).toMatchObject({
      tournId: 104547, startDate: "2026-07-11", city: "greenville", state: "NC", tier: "B", rounds: 2, highestCompletedRound: 2,
      roundDates: { 1: "2026-07-11", 2: "2026-07-11" },
    });
    expect(event.divisions).toHaveLength(10);
    expect(event.layouts.map((layout) => [layout.layoutId, layout.courseName, layout.holes.length])).toEqual([
      [761495, "The Meadow at West Meadowbrook Park", 18], [761497, "Ayden Park", 18],
    ]);
    const meadow = event.layouts[0]!;
    expect(meadow.holes.reduce((sum, hole) => sum + hole.par, 0)).toBe(64);
    expect(meadow.holes.reduce((sum, hole) => sum + hole.lengthFt!, 0)).toBe(7404);
    expect(pdgaEventComplete(event, "2026-07-12T00:00:00Z")).toBe(true);
    expect(pdgaRoundTasks(event)).toHaveLength(20);
    expect(parsePdgaEvent({ data: [] }, 104547)).toBeNull();
    expect(parsePdgaEvent(fixture("event-104547.json"), 999)).toBeNull();
  });

  it("returns the official round SSA per layout and anonymous score/rating pairs, skipping unrated finishes", () => {
    const round = parsePdgaRound(fixture("round-104547-MA2-1.json"), 1);
    expect(round.layouts.map((layout) => [layout.layoutId, layout.ssa, layout.holes.length])).toEqual([[761497, 49.565, 18]]);
    const pairs = round.pairs.get(761497)!;
    expect(pairs).toEqual([[52, 974], [55, 943], [57, 922], [57, 922], [58, 912], [58, 912], [62, 870], [64, 849], [67, 818]]);
    // The live payload carries names, PDGA numbers and home towns; none survive parsing.
    const raw = fixture("round-104547-MA2-1.json");
    raw.data.scores = raw.data.scores.map((score: object, index: number) => ({ ...score, Name: "Private Person " + index,
      PDGANum: 5550000 + index, City: "Hometown", Rating: 901 }));
    const parsed = JSON.stringify({ ...parsePdgaRound(raw, 1), pairs: [...parsePdgaRound(raw, 1).pairs] });
    expect(parsed).not.toMatch(/Private Person|555000|Hometown|901/);
    // The same layout record is not rated for a round it was not played in.
    expect(parsePdgaRound(fixture("round-104547-MA2-1.json"), 2).layouts[0]!.ssa).toBeNull();
    expect(parsePdgaRound(fixture("round-104547-MPO-2.json"), 2).layouts.map((layout) => [layout.layoutId, layout.ssa]))
      .toEqual([[761495, 55.742]]);
  });

  it("skips doubles teams, incomplete cards and rounds with no rating", () => {
    const body = fixture("round-104547-MA2-1.json");
    const [first, second, third] = body.data.scores;
    body.data.scores = [{ ...first, Teammates: [{}] }, { ...second, Completed: 0 }, { ...third, RoundRating: null }];
    expect(parsePdgaRound(body, 1).pairs.size).toBe(0);
  });

  it("converts metre layouts to feet and refuses malformed layouts", () => {
    const event = fixture("event-104547.json");
    const layout = { ...event.data.Layouts[1], Units: "Meters", Details: event.data.Layouts[1].Details.map((hole: object) => ({ ...hole, Length: 100 })) };
    const parsed = parsePdgaEvent({ data: { ...event.data, Layouts: [layout, { LayoutID: 3, CourseName: "Bad", Holes: 2, Details: [{ Par: 0 }] }] } }, 104547)!;
    expect(parsed.layouts).toHaveLength(1);
    expect(parsed.layouts[0]!.holes[0]!.lengthFt).toBe(328);
  });
});

describe("discovery filter", () => {
  const places = clubPlaces(["Greenville, NC", "Ayden, NC", "Farmville, VA", null, "Somewhere"]);
  const now = "2026-11-17T00:00:00Z";

  it("keeps recent events in our states whose city matches one of our course cities, allowing one typo", () => {
    const events = parseRatingDetailEvents(fixture("rating-detail-sample.json"));
    expect(events.length).toBe(35);
    expect(JSON.stringify(events)).not.toMatch(/score|rating"/);
    const kept = events.filter((event) => discoverableEvent(event, places, now)).map((event) => event.tournId);
    expect(kept).toContain(104547);
    expect(kept).toContain(88303); // "Greenivlle"
    expect(kept).toContain(104398); // city entered as a ZIP code: state check only
    expect(kept).toContain(87798); // Ayden
    expect(kept).not.toContain(75703); // Kinston: no course of ours there in this sample
    expect(kept).not.toContain(75214); // Rocky Mount
  });

  it("drops events older than about three years, in the future, or outside our states", () => {
    const base = { tournId: 1, name: "x", city: "greenville", state: "NC" };
    expect(discoverableEvent({ ...base, startDate: "2023-12-01" }, places, now)).toBe(true);
    expect(discoverableEvent({ ...base, startDate: "2023-11-01" }, places, now)).toBe(false);
    expect(discoverableEvent({ ...base, startDate: "2027-01-01" }, places, now)).toBe(false);
    expect(discoverableEvent({ ...base, startDate: "2026-01-01", state: "SC" }, places, now)).toBe(false);
    expect(discoverableEvent({ ...base, startDate: "2026-01-01", city: "greenwood" }, places, now)).toBe(false);
  });
});

describe("layout matching", () => {
  it("matches the real Ayden YGO layout to Ayden Park's main layout and leaves the tournament Meadow layout unmatched", () => {
    const event = parsePdgaEvent(fixture("event-104547.json"), 104547)!;
    const courses = clubCourses();
    const ayden = matchPdgaLayout(event.layouts[1]!, event.state, courses);
    expect(ayden).toMatchObject({ quality: "close", courseId: 7, layoutId: 9 });
    expect(ayden.candidates.find((candidate) => candidate.layoutId === 10)).toMatchObject({ grade: "none" });
    // Ayden-Grifton HS shares the name token but has nine holes, so it is never a candidate here.
    expect(ayden.candidates.some((candidate) => candidate.courseId === 12)).toBe(false);

    const meadow = matchPdgaLayout(event.layouts[0]!, event.state, courses);
    expect(meadow).toMatchObject({ quality: "none", layoutId: null });
    expect(meadow.reason).toMatch(/Length differs .* on 4 holes/);
    expect(meadow.candidates[0]).toMatchObject({ layoutId: 1, parMatches: 18, lengthMatches: 14, totalDiffPct: 5.1 });
  });

  it("applies the par, per-hole length and total length thresholds", () => {
    const pdga = holes([300, 300, 300, 300, 300, 300, 300, 300, 300, 300]);
    expect(compareLayoutGeometry(pdga, ours([300, 300, 300, 300, 300, 300, 300, 300, 300, 300])).grade).toBe("exact");
    // Within max(25 ft, 8%) on 8 of 10 holes, total within 5%.
    expect(compareLayoutGeometry(pdga, ours([300, 300, 300, 300, 300, 300, 300, 300, 340, 260])).grade).toBe("close");
    expect(compareLayoutGeometry(pdga, ours([300, 300, 300, 300, 300, 300, 300, 340, 340, 340])))
      .toMatchObject({ grade: "none", parOk: true, reason: expect.stringMatching(/3 holes/) });
    // Every hole just inside tolerance in the same direction: total off by 8%.
    expect(compareLayoutGeometry(pdga, ours(new Array(10).fill(324)))).toMatchObject({ grade: "none", totalDiffPct: 8 });
    const pars = ours(new Array(10).fill(300));
    pars[0]!.par = 4;
    expect(compareLayoutGeometry(pdga, pars).grade).toBe("close");
    pars[1]!.par = 4;
    expect(compareLayoutGeometry(pdga, pars)).toMatchObject({ grade: "none", parOk: false });
    expect(compareLayoutGeometry(pdga, ours([300, 300, 300, null, null, null, 300, 300, 300, 300])).grade).toBe("unverified");
    expect(compareLayoutGeometry(pdga, ours([300, 300]))).toMatchObject({ grade: "none", reason: "Hole count differs (10 vs 2)" });
  });

  const course = (layouts: OurCourse["layouts"], name = "River Park", location = "Greenville, NC"): OurCourse => ({ id: 1, name, location, layouts });
  const pdga = { courseName: "River Park DGC", holes: holes([300, 310, 320, 330, 340, 350, 360, 370, 380]) };

  it("never auto-matches two equally close layouts", () => {
    const same = ours([300, 310, 320, 330, 340, 350, 360, 370, 380]);
    const match = matchPdgaLayout(pdga, "NC", [course([{ id: 1, name: "Long", holes: same }, { id: 2, name: "Copy", holes: same }])]);
    expect(match).toMatchObject({ quality: "ambiguous", layoutId: null });
    const nearby = ours([300, 310, 320, 330, 340, 350, 360, 370, 400]);
    expect(matchPdgaLayout(pdga, "NC", [course([{ id: 1, name: "Long", holes: same }, { id: 2, name: "Alt", holes: nearby }])]))
      .toMatchObject({ quality: "ambiguous" });
    const distinct = ours([300, 310, 320, 360, 370, 350, 360, 370, 380]);
    expect(matchPdgaLayout(pdga, "NC", [course([{ id: 1, name: "Long", holes: same }, { id: 2, name: "Alt", holes: distinct }])]))
      .toMatchObject({ quality: "exact", layoutId: 1 });
  });

  it("needs a name-token match in the event's state and our hole lengths to verify", () => {
    const layout = { id: 1, name: "Main", holes: ours([300, 310, 320, 330, 340, 350, 360, 370, 380]) };
    expect(matchPdgaLayout(pdga, "NC", [course([layout], "Elsewhere Woods")])).toMatchObject({ quality: "none", reason: expect.stringMatching(/No club course/) });
    expect(matchPdgaLayout(pdga, "VA", [course([layout])])).toMatchObject({ quality: "none" });
    expect(matchPdgaLayout(pdga, null, [course([layout], "River Park", "Greenville, SC")])).toMatchObject({ quality: "exact" });
    const unmeasured = { id: 2, name: "Unmapped", holes: ours([null, null, null, null, null, null, null, null, null]) };
    expect(matchPdgaLayout(pdga, "NC", [course([unmeasured])])).toMatchObject({ quality: "unverified", layoutId: 2 });
    expect(matchPdgaLayout({ ...pdga, holes: pdga.holes.slice(0, 8) }, "NC", [course([layout])]))
      .toMatchObject({ quality: "none", reason: "No 8-hole layout at River Park" });
  });

  it("falls back to courses in the event's town when no course name matches, letting geometry decide", () => {
    const layout = { id: 1, name: "Main", holes: ours([300, 310, 320, 330, 340, 350, 360, 370, 380]) };
    const ecu = { ...course([layout], "ECU North Rec Complex", "Greenville, NC") };
    const renamed = { ...pdga, courseName: "East Carolina University" };
    expect(matchPdgaLayout(renamed, "NC", [ecu], "greenville")).toMatchObject({ quality: "exact", layoutId: 1, reason: expect.stringMatching(/town/) });
    expect(matchPdgaLayout(renamed, "NC", [ecu], "greenivlle")).toMatchObject({ quality: "exact", layoutId: 1 });
    expect(matchPdgaLayout(renamed, "NC", [ecu], "ayden")).toMatchObject({ quality: "none", candidates: [] });
    expect(matchPdgaLayout(renamed, "NC", [ecu])).toMatchObject({ quality: "none" });
    // A named match elsewhere in the state wins over the town fallback.
    expect(matchPdgaLayout(pdga, "NC", [ecu, { ...course([{ ...layout, id: 2 }]), id: 2, location: "Ayden, NC" }], "greenville"))
      .toMatchObject({ quality: "exact", layoutId: 2, reason: null });
  });

  it("treats a par-estimated distance as unmeasured", () => {
    expect(ourLayoutHoles([{ hole: 1, par: 3, distance_ft: 300, distance_source: "geo" }, { hole: 2, par: 3, distance_ft: 250, distance_source: "par_estimate" }]))
      .toEqual([{ hole: 1, par: 3, distanceFt: 300 }, { hole: 2, par: 3, distanceFt: null }]);
    expect(ourLayoutHoles([{ hole: 2, par: 3 }])).toBeNull();
  });
});

describe("chronological PDGA baselines", () => {
  const lengths = [300, 310, 320, 330, 340, 350, 360, 370, 380];
  const round = (tournId: number, roundDate: string, ssa: number | null, extra: Partial<BaselineRound> = {}): BaselineRound => ({
    tournId, roundNumber: 1, pdgaLayoutId: 9, roundDate, ssa, ratingsStatus: "official", reviewStatus: "auto", holes: holes(lengths), ...extra,
  });
  const rounds = [
    round(1, "2024-03-01", 48.2), round(2, "2025-03-01", 50.1, { ratingsStatus: "unconfirmed" }), round(3, "2025-06-01", 49.6),
    round(4, "2026-04-01", 51.0), round(5, "2026-04-01", null),
  ];

  it("takes the median official SSA of rounds played on an earlier day, with count, spread and dates", () => {
    const baseline = pdgaBaselineFor(rounds, ours(lengths), "2026-04-02")!;
    expect(baseline).toMatchObject({ ssa: 49.85, rounds: 4, officialRounds: 3, minSsa: 48.2, maxSsa: 51, firstDate: "2024-03-01", lastDate: "2026-04-01" });
    expect(baseline.ppt).toBeCloseTo(pointsPerThrow(49.85), 10);
    expect(baselineProvenance(baseline)).toBe("4 PDGA rated rounds, 2024–2026, median SSA 49.9");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("never looks ahead: a PDGA round on the same day or later is excluded", () => {
    expect(pdgaBaselineFor(rounds, ours(lengths), "2026-04-01")).toMatchObject({ ssa: 49.6, rounds: 3 });
    expect(pdgaBaselineFor(rounds, ours(lengths), "2025-03-01")).toMatchObject({ ssa: 48.2, rounds: 1 });
    expect(baselineProvenance(pdgaBaselineFor(rounds, ours(lengths), "2025-03-01")!)).toBe("1 PDGA rated round, 2024, median SSA 48.2");
    expect(pdgaBaselineFor(rounds, ours(lengths), "2024-03-01")).toBeNull();
  });

  it("uses only rounds whose layout fits the as-played geometry; admins may vouch past lengths, not pars", () => {
    const moved = ours([300, 310, 320, 330, 340, 350, 450, 470, 480]);
    expect(pdgaBaselineFor(rounds, moved, "2026-05-01")).toBeNull();
    const confirmed = rounds.map((entry) => ({ ...entry, reviewStatus: "confirmed" as const }));
    expect(pdgaBaselineFor(confirmed, moved, "2026-05-01")).toMatchObject({ rounds: 4 });
    const repar = ours(lengths, 4);
    expect(pdgaBaselineFor(confirmed, repar, "2026-05-01")).toBeNull();
  });

  it("dates a round by the club's calendar day", () => {
    expect(clubCalendarDay("2026-07-12T03:30:00.000Z")).toBe("2026-07-11");
    expect(clubCalendarDay("2026-07-11T15:00:00Z")).toBe("2026-07-11");
    expect(clubCalendarDay("2026-07-11")).toBe("2026-07-11");
    expect(clubCalendarDay("2026-07-11T00:00:00.000Z")).toBe("2026-07-11");
    expect(clubCalendarDay("nope")).toBeNull();
  });
});

describe("PDGA validation maths", () => {
  const layoutHoles = holes([300, 310, 320, 330, 340, 350, 360, 370, 380]);
  const vround = (tournId: number, roundDate: string, ssa: number, pairs: [number, number][], layoutId = 1): ValidationPdgaRound => ({
    tournId, roundNumber: 1, pdgaLayoutId: 100 + tournId, roundDate, ssa, ratingsStatus: "official", reviewStatus: "auto",
    holes: layoutHoles, layoutId, pairs,
  });
  const rate = (score: number, ssa: number) => roundRatingForScore(score, ssa, pointsPerThrow(ssa));

  it("predicts each round from earlier rounds only and reports MAE, bias and counts", () => {
    const report = evaluatePdgaBaselines([
      vround(1, "2025-01-01", 50, [[50, rate(50, 50)]]),
      vround(2, "2025-02-01", 52, [[50, rate(50, 52)], [54, rate(54, 52)]]),
      vround(3, "2025-03-01", 48, [[50, rate(50, 48)]]),
    ]);
    // Round 2 predicted from round 1 (SSA 50): ratings 20-ish points low. Round 3 from median(50, 52) = 51.
    const r2a = rate(50, 50) - rate(50, 52);
    const r2b = roundRatingForScore(54, 50, pointsPerThrow(50)) - rate(54, 52);
    const r3 = rate(50, 51) - rate(50, 48);
    expect(report).toMatchObject({
      status: "small-sample", matchedRounds: 3, matchedLayouts: 1, predictedRounds: 2, roundsWithoutPriorBaseline: 1, ratingPairs: 3,
      maeSsaStrokes: 2.5, biasSsaStrokes: 0.5, formulaPairs: 4, formulaMaeRating: 0,
    });
    expect(report.biasRating).toBeCloseTo((r2a + r2b + r3) / 3, 1);
    expect(report.maeRating).toBeCloseTo((Math.abs(r2a) + Math.abs(r2b) + Math.abs(r3)) / 3, 1);
  });

  it("checks the engine's score-to-rating formula against PDGA's published ratings for a real round", () => {
    const round = parsePdgaRound(fixture("round-104547-MA2-1.json"), 1);
    const report = evaluatePdgaBaselines([{ ...vround(1, "2026-07-11", 49.565, round.pairs.get(761497)! as [number, number][]),
      holes: round.layouts[0]!.holes }]);
    // PDGA appears to truncate: 974.6 is published as 974 where the engine rounds to 975.
    expect(report).toMatchObject({ status: "no-data", formulaPairs: 9, formulaMaxAbsRating: 1, formulaMaeRating: 0.1, ratingPairs: 0 });
  });

  it("compares stored club baselines with the PDGA baseline available on the same date", () => {
    const report = evaluatePdgaBaselines([vround(1, "2025-01-01", 50, []), vround(2, "2025-02-01", 52, [])],
      [{ layoutId: 1, playedAt: "2025-03-01T15:00:00Z", ssa: 52.5 }, { layoutId: 1, playedAt: "2024-12-01T15:00:00Z", ssa: 49 },
        { layoutId: 2, playedAt: "2025-03-01T15:00:00Z", ssa: 50 }]);
    expect(report).toMatchObject({ clubComparisons: 1, clubMinusPdgaSsaMean: 1.5, clubMinusPdgaSsaMae: 1.5, status: "no-data" });
  });
});
