import assert from "node:assert/strict";
import test from "node:test";

import { guestSpotsText } from "../src/members-app/auth-forms.js";
import { historyLocked } from "../src/members-app/membership-needed.js";
import { membershipAccountLine, membershipHomeHint } from "../src/shared/membership-status.js";

test("the guest promotion reads right while spots last and once they're gone", () => {
  assert.match(guestSpotsText({ left: 37, limit: 100 }), /^Free promotion: 37 of 100 guest spots left, with round history and stats included\./);
  assert.match(guestSpotsText({ left: 0, limit: 100 }), /^All 100 promotional guest spots are taken\..*round history and stats come with a club membership\.$/);
  assert.match(guestSpotsText(null), /^Free for the first 100 players/);
});

test("only a guest without a promo spot is locked out of round history and stats", () => {
  assert.equal(historyLocked({ membership: { guest: true, history: false } }), true);
  assert.equal(historyLocked({ membership: { guest: true, history: true } }), false);
  assert.equal(historyLocked({ membership: { guest: false, history: true } }), false);
  assert.equal(historyLocked({ membership: null }), false);
  assert.equal(historyLocked({}), false);
});

test("a guest account's status line", () => {
  const guest = { throughYear: 2026, guest: true, lapsed: false, history: true };
  assert.equal(membershipAccountLine(guest), "Guest account: play, score, register for events and buy. Ask a club admin about membership to sell in the marketplace.");
  assert.equal(membershipHomeHint(guest), "");
});
