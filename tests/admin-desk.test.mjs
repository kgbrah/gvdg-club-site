import assert from "node:assert/strict";
import test from "node:test";

import { counterHandoff, deskSummary, handoffLabel, holdDeskOrder, usualPriceDollars } from "../src/admin-app/desk-model.js";
import { nextWeekOffer } from "../src/admin-app/repeat-draft.js";

test("the morning line puts people who owe first and knows when everyone is here", () => {
  const summary = deskSummary([
    { name: "Ava", checkedIn: true, paid: true },
    { name: "Ben", checkedIn: false, paid: false },
    { name: "Cam", checkedIn: false, paid: true },
  ]);
  assert.deepEqual(summary.line.map((player) => player.name), ["Ben", "Cam", "Ava"]);
  assert.equal(summary.ready, false);
  assert.equal(summary.owe, 1);
  assert.equal(deskSummary([{ name: "Ava", checkedIn: true, paid: true }]).ready, true);
  const players = [
    { id: 1, name: "Ava", checkedIn: true, paid: true },
    { id: 2, name: "Ben", checkedIn: false, paid: false },
  ];
  const first = holdDeskOrder(players, []);
  assert.deepEqual(first, ["2", "1"]);
  const stayed = holdDeskOrder(players.map((player) => ({ ...player, checkedIn: true, paid: true })), first);
  assert.equal(stayed, first);
});

test("the counter hands off a ready order and remembers the usual price", () => {
  const order = counterHandoff([
    { id: 1, status: "submitted", member_name: "Sam", items: [{ name_snapshot: "Buzzz", quantity: 1 }] },
    { id: 2, status: "ready", member_name: "Kevin", items: [{ name_snapshot: "Destroyer", quantity: 1 }] },
  ]);
  assert.equal(order.id, 2);
  assert.equal(handoffLabel(order), "Kevin, Destroyer");
  assert.equal(usualPriceDollars([
    { name: "Destroyer", price_cents: 1800 },
    { name: "Destroyer", price_cents: 1800 },
    { name: "Destroyer", price_cents: 2000 },
  ], "destroyer"), "18");
});

test("a finished one-off match is not offered as next week", () => {
  const events = [
    { date: "2026-10-31", name: "#4 KG/TJ vs MIKE/CALEB RYDER CUP DUBS", status: "final", type: "league_round" },
    { date: "2026-10-24", name: "Saturday league", status: "final", type: "league_round" },
  ];
  assert.match(nextWeekOffer(events, "2026-11-02").label, /Saturday league/);
  assert.equal(nextWeekOffer([events[0]], "2026-11-02"), null);
});

test("next week is offered only when that Saturday is not already on the calendar", () => {
  const events = [
    { date: "2026-10-31", name: "Saturday league", status: "final", type: "league_round" },
  ];
  assert.match(nextWeekOffer(events, "2026-11-02").label, /Saturday league/);
  events.push({ date: "2026-11-07", name: "Saturday league", status: "scheduled", type: "league_round" });
  assert.equal(nextWeekOffer(events, "2026-11-02"), null);
});
