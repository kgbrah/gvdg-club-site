import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatPdgaAnnualSummary,
  formatPdgaPlace,
  formatPdgaToPar,
  groupPdgaEventsByYear,
  pdgaEventTitle,
  pdgaEventYear,
  pdgaRoundStatChips,
} from "../src/members-app/pdga-dashboard.js";
import { goingText, pdgaEventMeta, readPdgaRegistrations, tierLabel } from "../src/members-app/pdga-registrations.js";
import { hasPdgaLiveDetailedStats, pdgaLiveObText, pdgaLivePositionText, pdgaLiveStatPctText } from "../src/public-app/pdga-live-panel.js";
import { extractPdgaEventId } from "../src/shared/pdga-live-panel.js";
import { mergePdgaPlayPayload } from "../src/shared/play-stats.js";

test("pdga-registrations helpers format tiers, clubmates, and defend against malformed API payloads", () => {
  assert.deepEqual(readPdgaRegistrations(null), { mine: [], club: [] });
  assert.equal(tierLabel("B"), "B-tier");
  assert.equal(tierLabel("ES"), "Elite Series");
  assert.equal(goingText([
    { name: "Ada Lovelace", division: "FPO" },
    { name: "Grace Hopper", division: "" },
    ...Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, division: "MA1" })),
  ]), "Ada Lovelace (FPO), Grace Hopper, P0 (MA1), P1 (MA1), P2 (MA1), P3 (MA1) and 2 more");
  assert.equal(
    pdgaEventMeta({ start: "2026-12-12", end: "2026-12-13", tier: "B", location: "Greenville, NC" }),
    "Dec 12–13, 2026 · B-tier · Greenville, NC",
  );
});

test("pdga-dashboard helpers decode HTML entities, format place/to-par/annual/stat chips, and group descending", () => {
  assert.equal(pdgaEventTitle("Greenville &amp; Classic &#039;26"), "Greenville & Classic '26");
  assert.equal(pdgaEventYear({ date: "Nov 1, 2026" }), "2026");
  const groups = groupPdgaEventsByYear([
    { tournament: "Old", date: "2025-09-01" },
    { tournament: "New", date: "2026-06-20" },
  ]);
  assert.deepEqual(groups.map((g) => g.year), ["2026", "2025"]);

  assert.equal(formatPdgaPlace(1), "1st");
  assert.equal(formatPdgaPlace(2), "2nd");
  assert.equal(formatPdgaPlace(3), "3rd");
  assert.equal(formatPdgaPlace(11), "11th");
  assert.equal(formatPdgaPlace(22), "22nd");
  assert.equal(formatPdgaPlace(99, true), "DNF");
  assert.equal(formatPdgaPlace(null), "");

  assert.equal(formatPdgaToPar(0), "E");
  assert.equal(formatPdgaToPar(-4), "-4");
  assert.equal(formatPdgaToPar(3), "+3");
  assert.equal(formatPdgaToPar(null), "");

  assert.deepEqual(pdgaRoundStatChips({
    fwh: { hit: 12, opp: 16 },
    c1r: { hit: 0, opp: 0 }, // opp === 0 means no throw tracking -> omitted
    c1x: { hit: 9, opp: 10 },
    ob: { count: 2, holes: 18 },
  }), [
    { id: "fwh", label: "FWH", text: "FWH 75%" },
    { id: "c1x", label: "C1X", text: "C1X 90%" },
    { id: "ob", label: "OB", text: "OB 2" },
  ]);

  assert.deepEqual(formatPdgaAnnualSummary({
    events: 8,
    rounds: 16,
    points: 412,
    prize: 240,
    playersDefeated: 120,
    wins: 2,
  }), ["8 events", "16 rounds", "412 pts", "$240 cash", "120 defeated", "2 wins"]);

  assert.equal(extractPdgaEventId(107755, ""), 107755);
  assert.equal(extractPdgaEventId(null, "https://www.pdga.com/tour/event/96414"), 96414);
  assert.equal(extractPdgaEventId(undefined, "https://www.pdga.com/live/event/88001/MA1/scores"), 88001);
  assert.equal(extractPdgaEventId(null, "https://example.com/other"), null);
});

test("pdga-live-panel helpers handle ties, DNF, and missing throw tracking (opp === 0)", () => {
  assert.equal(pdgaLivePositionText({ runningPlace: 2, tied: true }), "T2");
  assert.equal(pdgaLivePositionText({ runningPlace: 1, tied: false }), "1");
  assert.equal(pdgaLivePositionText({ dnf: true, runningPlace: 99 }), "DNF");
  assert.equal(pdgaLivePositionText({ runningPlace: null }), "-");
  assert.equal(pdgaLiveStatPctText({ hit: 0, opp: 0, value: 0 }), "-");
  assert.equal(pdgaLiveStatPctText({ hit: 12, opp: 16, value: 75 }), "75%");
  assert.equal(pdgaLiveObText({ obCount: { hit: 2, opp: 18, value: 2 } }), "2");
  assert.equal(pdgaLiveObText({ obRate: { hit: 3, opp: 18, value: 16.67 } }), "3");
  assert.equal(pdgaLiveObText({ obRate: { hit: null, opp: 18, value: 5.56 } }), "5.6%");
  assert.equal(hasPdgaLiveDetailedStats([{ scores: [{ stats: null }] }]), false);
  assert.equal(hasPdgaLiveDetailedStats([{ scores: [{ stats: { fwh: { hit: 1, opp: 2, value: 50 } } }] }]), true);
});

test("pdga-live-panel splits round controls, gives lb-wrap scroll-region semantics, and locks grid overflow in CSS", () => {
  const panelSource = readFileSync("src/shared/pdga-live-panel.js", "utf8");
  const memberCss = readFileSync("member-surfaces.css", "utf8");
  const publicCss = readFileSync("public-polish.css", "utf8");

  assert.match(panelSource, /className: "pdga-live-block"/);
  assert.match(panelSource, /pdga-live-controls pdga-live-rounds/);
  assert.match(panelSource, /role: "region"/);
  assert.match(panelSource, /tabIndex: 0/);
  assert.match(memberCss, /#members \.pdga-live-drawer\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(memberCss, /#members \.pdga-live-drawer > \.player-btn\s*\{[^}]*width:\s*100%/);
  assert.match(memberCss, /#members \.pdga-live-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(memberCss, /#members \.pdga-live-block\s*\{[^}]*min-width:\s*0/);
  assert.match(memberCss, /#members \.pdga-live-panel \.lb-wrap\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(publicCss, /\[data-pdga-live-panel\] \.pdga-live-block\s*\{[^}]*min-width:\s*0/);
  assert.match(publicCss, /\[data-pdga-live-panel\] \.lb-wrap\s*\{[^}]*overflow-x:\s*auto/);
});

test("mergePdgaPlayPayload merges club-hosted PDGA scoring with live rounds without double counting or external ranks", () => {
  const empty = mergePdgaPlayPayload(null, null, "m1", "Ada", []);
  assert.equal(empty.source, "none");
  assert.equal(empty.showRank, false);

  const clubOnly = {
    mine: { memberId: "m1", name: "Ada", totals: { holes: 18, birdies: 5, pars: 11, bogeys: 2, birdie_hit: 5, par_hit: 11 } },
    categories: [],
    views: {
      "all-all": { mine: { memberId: "m1", name: "Ada", totals: { holes: 18, birdies: 5, pars: 11, bogeys: 2, birdie_hit: 5, par_hit: 11 } }, categories: [] },
      "singles-stroke": { mine: { memberId: "m1", name: "Ada", totals: { holes: 18, birdies: 5, pars: 11, bogeys: 2, birdie_hit: 5, par_hit: 11 } }, categories: [] },
    },
  };
  const onlyClub = mergePdgaPlayPayload(clubOnly, null, "m1", "Ada", ["104547"]);
  assert.equal(onlyClub.source, "club");
  assert.equal(onlyClub.showRank, true);
  assert.equal(onlyClub.payload.mine.totals.holes, 18);

  const pdgaStats = {
    name: "Ada",
    play_rounds: [
      { event_id: "104547", group_format: "singles", scoring_style: "stroke", breakdown: { holes: 18, birdies: 5, pars: 11, bogeys: 2 } },
      { event_id: "107755", group_format: "singles", scoring_style: "stroke", breakdown: { holes: 18, birdies: 4, pars: 12, bogeys: 2 } },
    ],
  };
  const liveOnly = mergePdgaPlayPayload(null, pdgaStats, "m1", "Ada", []);
  assert.equal(liveOnly.source, "live");
  assert.equal(liveOnly.showRank, false);
  assert.equal(liveOnly.payload.mine.totals.holes, 36);

  const mixed = mergePdgaPlayPayload(clubOnly, pdgaStats, "m1", "Ada", ["104547"]);
  assert.equal(mixed.source, "mixed");
  assert.equal(mixed.showRank, false);
  // 18 holes from club 104547 + 18 holes from live 107755 (104547 deduped out of live)
  assert.equal(mixed.payload.mine.totals.holes, 36);
  assert.equal(mixed.payload.mine.totals.birdies, 9);
});
