import assert from "node:assert/strict";
import test from "node:test";
import { membershipAccountLine, membershipHomeHint } from "../src/shared/membership-status.js";

test("membership copy matches the year on the account", () => {
  const current = { throughYear: 2026, lapsed: false, remind: false, renewalYear: 2027 };
  assert.equal(membershipAccountLine(current), "Member through December 31, 2026.");
  assert.equal(membershipHomeHint(current), "");

  const december = { throughYear: 2026, lapsed: false, remind: true, renewalYear: 2027 };
  assert.match(membershipAccountLine(december), /January 1 for 2027/);
  assert.equal(membershipHomeHint(december), "Renew by January 1.");

  const lapsed = { throughYear: 2026, lapsed: true, remind: false, renewalYear: 2027 };
  assert.match(membershipAccountLine(lapsed), /lapsed on January 1/);
  assert.match(membershipHomeHint(lapsed), /Lapsed January 1/);
  assert.equal(membershipAccountLine(null), "");
});
