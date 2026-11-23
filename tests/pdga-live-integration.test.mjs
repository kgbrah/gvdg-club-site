import assert from "node:assert/strict";
import test from "node:test";

import { groupPdgaEventsByYear, pdgaEventTitle, pdgaEventYear } from "../src/members-app/pdga-dashboard.js";
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

test("pdga-dashboard helpers decode HTML entities and group events descending by year", () => {
  assert.equal(pdgaEventTitle("Greenville &amp; Classic &#039;26"), "Greenville & Classic '26");
  assert.equal(pdgaEventYear({ date: "Nov 1, 2026" }), "2026");
  const groups = groupPdgaEventsByYear([
    { tournament: "Old", date: "2025-09-01" },
    { tournament: "New", date: "2026-06-20" },
  ]);
  assert.deepEqual(groups.map((g) => g.year), ["2026", "2025"]);
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
