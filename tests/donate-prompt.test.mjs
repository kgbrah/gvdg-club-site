import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { clubPaypalUrl, dismissPrompt, promptDismissed, recordFinishedCasualRound } from "../src/shared/donate-prompt.js";
import { clubMembershipCard } from "../src/shared/membership-status.js";

// Owner: "add a PayPal app link at the end of every 5th completed casual round and on the results page of every
// completed club event giving the user an easy way to donate $1 or dismiss", and "put GVDG Membership status under
// here with a quick PayPal app link to renew or donate to the club".

function memoryStorage() {
  const rows = new Map();
  return { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, String(value)), removeItem: (key) => rows.delete(key) };
}

test("every 5th finished casual round on this device asks for $1; a round counts once", () => {
  const storage = memoryStorage();
  const asked = [];
  for (const code of ["AAA111", "BBB222", "CCC333", "DDD444", "EEE555", "FFF666", "GGG777", "HHH888", "III999", "JJJ000"]) {
    const result = recordFinishedCasualRound(code, storage);
    if (result.ask) asked.push(code + "@" + result.count);
  }
  assert.deepEqual(asked, ["EEE555@5", "JJJ000@10"]);
  // Reopening the 5th round's finished card asks again (until dismissed), and doesn't count it twice.
  assert.deepEqual(recordFinishedCasualRound("eee555", storage), { count: 10, ask: true });
  dismissPrompt("round:EEE555", storage);
  assert.deepEqual(recordFinishedCasualRound("EEE555", storage), { count: 10, ask: false });
  assert.equal(recordFinishedCasualRound("", storage).ask, false);
});

test("No thanks is remembered per event; the PayPal links go to the club's PayPal.me", () => {
  const storage = memoryStorage();
  assert.equal(promptDismissed("event:42", storage), false);
  dismissPrompt("event:42", storage);
  assert.equal(promptDismissed("event:42", storage), true);
  assert.equal(promptDismissed("event:43", storage), false);
  assert.equal(clubPaypalUrl(1), "https://paypal.me/greenvillediscgolf/1");
  assert.equal(clubPaypalUrl(15), "https://paypal.me/greenvillediscgolf/15");
  assert.equal(clubPaypalUrl(), "https://paypal.me/greenvillediscgolf");
});

test("the prompts sit on finished casual rounds and finished club events", () => {
  const scorecard = readFileSync("src/score-app/scorecard-view.js", "utf8");
  assert.match(scorecard, /props\.finish && props\.finish\.locked && props\.finish\.status === "final" && !props\.eventId && props\.roundCode\s+\? h\(RoundDonatePrompt/);
  assert.match(readFileSync("src/public-app/events-detail-app.js", "utf8"), /event\.status === "final" \? h\(DonateDollar, \{ key: "donate", promptKey: "event:" \+ event\.id/);
  assert.match(readFileSync("src/members-app/more-page.js", "utf8"), /h\(PdgaMembershipCard[^\n]*\n\s*h\(ClubMembershipCard/);
});

test("the GVDG membership card: status, the dues year to pay, and when it's due", () => {
  const base = { throughYear: 2026, currentYear: 2026, current: true, lapsed: false, guest: false, remind: false, renewalYear: 2027 };
  assert.deepEqual(clubMembershipCard(base), { line: "Member through December 31, 2026.", renewYear: 2027, due: false, dues: 15 });
  assert.deepEqual(clubMembershipCard({ ...base, remind: true }), { line: "Member through December 31, 2026. Renew by January 1 for 2027.", renewYear: 2027, due: true, dues: 15 });
  assert.deepEqual(clubMembershipCard({ ...base, throughYear: 2027, renewalYear: null }), { line: "Member through December 31, 2027.", renewYear: null, due: false, dues: 15 });
  assert.deepEqual(clubMembershipCard({ ...base, throughYear: 2025, current: false, lapsed: true, renewalYear: 2026 }), { line: "Your membership lapsed on January 1.", renewYear: 2026, due: true, dues: 15 });
  assert.equal(clubMembershipCard({ ...base, guest: true, renewalYear: null }).renewYear, null);
  assert.equal(clubMembershipCard(base, 2000).dues, 20);
  assert.equal(clubMembershipCard(null), null);
});

// Owner: "Let's make ALL donations reward +10 karma per dollar" (an admin confirms each one).
test("telling the club about a donation: signed in it's reported for the admin to confirm; signed out it asks to sign in", async () => {
  const { reportDonation, KARMA_PER_DOLLAR } = await import("../src/shared/donate-prompt.js");
  assert.equal(KARMA_PER_DOLLAR, 10);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ donation: { id: 7, amountCents: 100, status: "pending" } }), { status: 201 });
  };
  const ok = await reportDonation(100, "round", { token: "t0k", base: "https://gvdgclub.com/api", fetchImpl });
  assert.deepEqual(ok, { ok: true, donation: { id: 7, amountCents: 100, status: "pending" } });
  assert.equal(calls[0].url, "https://gvdgclub.com/api/me/donations");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0k");
  assert.deepEqual(JSON.parse(calls[0].init.body), { amountCents: 100, source: "round" });
  assert.deepEqual(await reportDonation(100, "round", { token: "", fetchImpl }), { ok: false, error: "signed_out" });
  const full = async () => new Response(JSON.stringify({ error: "too_many_pending" }), { status: 409 });
  assert.deepEqual(await reportDonation(500, "club-card", { token: "t", base: "x", fetchImpl: full }), { ok: false, error: "too_many_pending" });
});

test("donations reach the admin: a Donations screen under Money and a Needs you item", async () => {
  const { adminNeedsItems } = await import("../src/admin-app/admin-needs.js");
  const items = adminNeedsItems({ donations: 2 });
  assert.deepEqual(items.find((item) => item.id === "donations"), { id: "donations", tab: "donations", count: 2, label: "Donations to confirm", detail: "Check the club's PayPal" });
  const { ADMIN_DESTINATIONS } = await import("../src/shared/app-navigation.js");
  assert.equal(ADMIN_DESTINATIONS.find((item) => item.key === "donations")?.group, "money");
  assert.match(readFileSync("admin.html", "utf8"), /<div class="admin-pane" id="apane-donations">\s*<div id="adminDonationsReactApp"><\/div>/);
  // The report step follows every way to give: the $1 prompts, the Club page card, fundraisers.
  assert.match(readFileSync("src/shared/donate-prompt.js", "utf8"), /h\(DonationReport, \{ source: String\(promptKey\)\.split\(":"\)\[0\] === "event" \? "event" : "round", cents: 100/);
  assert.match(readFileSync("src/members-app/club-membership-card.js", "utf8"), /h\(DonationReport, \{ source: "club-card"/);
  assert.match(readFileSync("src/public-app/events-club-content-app.js", "utf8"), /reporting \? h\(DonationReport, \{ source: "fundraiser"/);
});
