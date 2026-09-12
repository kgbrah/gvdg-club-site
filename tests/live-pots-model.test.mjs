import assert from "node:assert/strict";
import test from "node:test";

import {
  aceHint,
  acePotLine,
  buildLivePots,
  dollarsFromCents,
  normalizeAcePot,
  normalizeCtp,
  withLiveCtpLeaders,
  unawardedLiveCtps,
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
    live: false,
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

test("withLiveCtpLeaders fills an empty winner from the live card claim", () => {
  const merged = withLiveCtpLeaders(
    [{ id: 9, hole: 7, prize: "Disc", winner_name: "" }],
    [{ id: 9, hole: 7, leaderName: "Ann" }],
  );
  assert.equal(merged[0].winner_name, "Ann");
  assert.equal(merged[0].live_leader, true);
  const awarded = withLiveCtpLeaders(
    [{ id: 9, hole: 7, winner_name: "Bo" }],
    [{ id: 9, leaderName: "Ann" }],
  );
  assert.equal(awarded[0].winner_name, "Bo");
  const replaced = withLiveCtpLeaders(
    [{ id: 9, hole: 7, winner_name: "Ann", live_leader: true }],
    [{ id: 9, leaderName: "Bo" }],
  );
  assert.equal(replaced[0].winner_name, "Bo");
  assert.equal(replaced[0].live_leader, true);
  const cleared = withLiveCtpLeaders(
    [{ id: 9, hole: 7, winner_name: "Ann", live_leader: true }],
    [{ id: 9, leaderName: null }],
  );
  assert.equal(cleared[0].winner_name, "");
  assert.equal(cleared[0].live_leader, false);
});

test("unawardedLiveCtps hides a live leader after an admin records a winner", () => {
  const live = [
    { id: 9, hole: 7, leaderName: "Ann" },
    { id: 10, hole: 8, leaderName: "Cy" },
  ];
  const visible = unawardedLiveCtps(live, [
    { id: 9, hole: 7, winner_name: "Bo" },
    { id: 10, hole: 8, winner_name: "" },
  ]);
  assert.deepEqual(visible.map((ctp) => ctp.id), [10]);
  assert.equal(unawardedLiveCtps(live, [{ id: 9, winner_name: "Ann", live_leader: true }]).length, 2);
});
