import assert from "node:assert/strict";
import test from "node:test";

import {
  aceHint,
  acePotLine,
  buildLivePots,
  dollarsFromCents,
  normalizeAcePot,
  normalizeCtp,
} from "../src/shared/live-pots-model.js";

test("dollarsFromCents formats whole and fractional amounts", () => {
  assert.equal(dollarsFromCents(0), "$0");
  assert.equal(dollarsFromCents(1500), "$15");
  assert.equal(dollarsFromCents(1250), "$12.50");
  assert.equal(dollarsFromCents(-400), "-$4");
});

test("normalizeCtp keeps hole, prize, and winner", () => {
  assert.deepEqual(normalizeCtp({ id: 9, hole: 7, division: "MA1", prize: "Disc", winner_name: "Jane" }), {
    division: "MA1",
    hole: 7,
    id: "9",
    prize: "Disc",
    winnerName: "Jane",
  });
  assert.equal(normalizeCtp({ prize: "no hole" }).hole, null);
});

test("ace pot is hidden when empty and active", () => {
  assert.equal(normalizeAcePot(null), null);
  assert.equal(normalizeAcePot({ total_cents: 0, status: "active" }).visible, false);
  assert.equal(normalizeAcePot({ total_cents: 2500, contributors: 5, status: "active" }).visible, true);
  assert.equal(acePotLine(normalizeAcePot({ total_cents: 2500, contributors: 5 })), "$25 in the pot (5 in)");
  assert.equal(acePotLine(normalizeAcePot({ total_cents: 1000, status: "paid_out", winner_name: "Pat" })), "Paid out to Pat");
});

test("buildLivePots marks the current hole CTP and stays hidden when empty", () => {
  const empty = buildLivePots({});
  assert.equal(empty.visible, false);
  assert.equal(empty.currentHoleCtps.length, 0);

  const pots = buildLivePots({
    currentHole: 7,
    acePot: { total_cents: 1800, contributors: 3, status: "active" },
    ctps: [
      { id: 1, hole: 3, prize: "Mini" },
      { id: 2, hole: 7, prize: "Disc", division: "Open" },
    ],
  });
  assert.equal(pots.visible, true);
  assert.equal(pots.aceLine, "$18 in the pot (3 in)");
  assert.deepEqual(pots.holeNumbers, [3, 7]);
  assert.equal(pots.currentHoleCtps.length, 1);
  assert.equal(pots.currentHoleCtps[0].prize, "Disc");
});

test("aceHint only fires for an ace on an active pot", () => {
  const pots = buildLivePots({ acePot: { total_cents: 4000, status: "active" } });
  assert.equal(aceHint({ hole: 8, pots, scores: [3, 4] }), "");
  assert.equal(
    aceHint({ hole: 8, pots, scores: [3, 1] }),
    "Ace on hole 8. Pot is $40 — an admin records the winner.",
  );
  const paid = buildLivePots({ acePot: { total_cents: 4000, status: "paid_out", winner_name: "Pat" } });
  assert.equal(aceHint({ hole: 8, pots: paid, scores: [1] }), "");
});
