import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { pdgaMembershipNeedsAttention } from "../src/shared/pdga-membership.js";

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test("Home nudges about PDGA membership only when it has lapsed or ends within 45 days", () => {
  assert.equal(pdgaMembershipNeedsAttention({ player: { membershipStatus: "expired", membershipExpires: day(-30) } }), true);
  assert.equal(pdgaMembershipNeedsAttention({ player: { membershipStatus: "current", membershipExpires: day(20) } }), true);
  assert.equal(pdgaMembershipNeedsAttention({ player: { membershipStatus: "current", membershipExpires: day(200) } }), false);
  assert.equal(pdgaMembershipNeedsAttention({ player: null, lookup: "none" }), false);
  assert.equal(pdgaMembershipNeedsAttention(null), false);
});

test("the join/renew card is on the More page and (when needed) Home; admins set the club code; guests never get it", () => {
  assert.match(readFileSync("src/members-app/more-page.js", "utf8"), /h\(PdgaMembershipCard, \{ data: pdgaMembership \}\)/);
  assert.match(readFileSync("src/members-app/overview-dashboard.js", "utf8"), /pdgaMembershipNeedsAttention\(pdgaMembership\)/);
  assert.match(readFileSync("src/admin-app/more-page.js", "utf8"), /h\(AdminPdgaPromo, \{ key: "pdga-promo" \}\)/);
  const card = readFileSync("src/shared/pdga-membership.js", "utf8");
  assert.match(card, /data\.promo \? h\(PromoCode/); // the code comes only from the server's member-only answer
  assert.match(card, /h\(PdgaCredit/);
  const event = readFileSync("src/public-app/tournament-registration.js", "utf8");
  assert.match(event, /https:\/\/www\.pdga\.com\/membership\/renew/);
  assert.match(event, /sign in to see it/);
});
