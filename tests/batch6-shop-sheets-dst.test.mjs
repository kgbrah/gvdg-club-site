import assert from "node:assert/strict";
import test from "node:test";

import { clubWallClockToIso, isoToClubWallClock } from "../src/shared/events-model.js";
import { parseDues, parseMoney } from "../src/shared/sheet-import.js";

test("clubWallClockToIso handles spring-forward and fall-back DST transitions accurately", () => {
  for (const wall of [
    "2026-03-08T04:00",
    "2026-03-08T06:00",
    "2026-11-01T03:00",
    "2026-11-01T05:00",
  ]) {
    const iso = clubWallClockToIso(wall);
    assert.ok(iso, `expected ISO for ${wall}`);
    assert.equal(isoToClubWallClock(iso), wall, `${wall} -> ${iso}`);
  }
  assert.equal(clubWallClockToIso("2026-03-08T04:00"), "2026-03-08T08:00:00.000Z");
  assert.equal(clubWallClockToIso("2026-11-01T03:00"), "2026-11-01T08:00:00.000Z");
});

test("parseMoney rejects stray hyphens and malformed parenthetical negatives as NaN", () => {
  assert.equal(parseMoney("$12.50"), 1250);
  assert.equal(parseMoney("(5.00)"), -500);
  assert.equal(parseMoney("($5.00)"), -500);
  assert.equal(parseMoney("-$5"), -500);
  assert.equal(parseMoney("$-5.00"), -500);
  assert.equal(parseMoney("$1,234.56"), 123456);
  assert.equal(parseMoney("20"), 2000);
  assert.equal(parseMoney(""), null);
  assert.ok(Number.isNaN(parseMoney("12-50")));
  assert.ok(Number.isNaN(parseMoney("--5")));
  assert.ok(Number.isNaN(parseMoney("(-5)")));
  assert.ok(Number.isNaN(parseMoney("abc")));
});

test("parseDues treats Unpaid/Not paid/Lapsed with a year as null rather than paid", () => {
  assert.equal(parseDues("Unpaid 2026", 2026), null);
  assert.equal(parseDues("Not paid 2026", 2026), null);
  assert.equal(parseDues("Lapsed 2025", 2026), null);
  assert.equal(parseDues("No", 2026), null);
  assert.equal(parseDues("No - 2026", 2026), null);
  assert.equal(parseDues("No. 2026", 2026), 2026);
  assert.equal(parseDues("Receipt No. 2026", 2026), 2026);
  assert.equal(parseDues("Paid 2026 (no card)", 2026), 2026);
  assert.equal(parseDues("Paid 2026", 2026), 2026);
  assert.equal(parseDues("✓", 2026), 2026);
  assert.equal(parseDues("2027", 2026), 2027);
});
