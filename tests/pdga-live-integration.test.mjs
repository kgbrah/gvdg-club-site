import assert from "node:assert/strict";
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
    points: 412,
    prize: 240,
    wins: 2,
  }), ["8 events", "412 pts", "$240 cash", "2 wins"]);
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
