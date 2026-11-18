import assert from "node:assert/strict";
import test from "node:test";

import { cleanKarmaDirectory, karmaOf, karmaSuffix, karmaText } from "../src/shared/karma.js";
import { handicapKey } from "../src/shared/handicap.js";

// The page and the Worker must make the same anonymous key; the Worker's test pins the same value.
test("the anonymous player key matches the Worker's", () => {
  assert.equal(handicapKey("m_80024"), "9f54821bf08584f9");
  assert.equal(handicapKey("g_walkon"), "");
});

test("karma is found by payload key, member id, PDGA number or trader key, and checked on the way in", () => {
  const directory = cleanKarmaDirectory({
    players: { [handicapKey("m_80024")]: 40, [handicapKey("m_u_bo")]: 5, nothex: 9, [handicapKey("m_1")]: 0, abcdefabcdefabcd: "12", ffffffffffffffff: 2.5 },
    traders: { "0123456789abcdef01": 15, bad: 3 },
  });
  assert.deepEqual(directory, {
    players: { [handicapKey("m_80024")]: 40, [handicapKey("m_u_bo")]: 5, abcdefabcdefabcd: 12 },
    traders: { "0123456789abcdef01": 15 },
  });
  assert.equal(karmaOf(directory, { karmaKey: handicapKey("m_80024") }), 40);
  assert.equal(karmaOf(directory, { memberId: "m_u_bo" }), 5);
  assert.equal(karmaOf(directory, { pdga: "80024" }), 40);
  assert.equal(karmaOf(directory, { pdga: "#80,024" }), 40);
  assert.equal(karmaOf(directory, { traderKey: "0123456789abcdef01" }), 15);
  assert.equal(karmaOf(directory, { memberId: "m_nobody" }), 0);
  assert.equal(karmaOf(directory, {}), 0);
  assert.equal(karmaOf(null, { memberId: "m_80024" }), 0);
  assert.equal(karmaSuffix(directory, { memberId: "m_80024" }), " ✦ 40");
  assert.equal(karmaSuffix(directory, { memberId: "m_nobody" }), "");
  assert.deepEqual(cleanKarmaDirectory(null), { players: {}, traders: {} });
});

test("a total below zero (an admin penalty for gaming round karma) survives and reads with a true minus sign", () => {
  const directory = cleanKarmaDirectory({ players: { [handicapKey("m_80024")]: -15, [handicapKey("m_1")]: 0 }, traders: { "0123456789abcdef01": -15 } });
  assert.deepEqual(directory, { players: { [handicapKey("m_80024")]: -15 }, traders: { "0123456789abcdef01": -15 } });
  assert.equal(karmaOf(directory, { memberId: "m_80024" }), -15);
  assert.equal(karmaSuffix(directory, { memberId: "m_80024" }), " ✦ \u221215");
  assert.equal(karmaText(-8), "\u22128");
  assert.equal(karmaText(40), "40");
});
