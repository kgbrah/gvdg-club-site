import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { highlightParts, matchScore, normalizeForMatch, rankSuggestions, suggestionItem } from "../src/shared/autocomplete-rank.js";
import { discSearchSuggestions } from "../src/shared/disc-catalog.js";
import { visibleWalletRows, walletMoney } from "../src/admin-app/wallet-balances.js";

// Owner: "would like auto complete for all searches, especially player names, across all surfaces in the member app",
// and "need admin to be able to view all member wallet balances".

const PLAYERS = ["Max Crotts", "Jon Upchurch", "Fred Jarrett", "José Ortiz", "Jonathan O'Neil", "Joanna Smith", "Ada Lovelace"];

test("names starting with what's typed come first, then a later word, then anywhere", () => {
  // Prefix matches, shorter names first.
  assert.deepEqual(rankSuggestions("jo", PLAYERS).map((item) => item.label), ["José Ortiz", "Joanna Smith", "Jon Upchurch", "Jonathan O'Neil"]);
  assert.deepEqual(rankSuggestions("up", PLAYERS).map((item) => item.label), ["Jon Upchurch"]);
  assert.deepEqual(rankSuggestions("arre", PLAYERS).map((item) => item.label), ["Fred Jarrett"]);
  // Every typed word matches a word start: "jo sm" finds Joanna Smith.
  assert.deepEqual(rankSuggestions("jo sm", PLAYERS).map((item) => item.label), ["Joanna Smith"]);
});

test("accents, case and apostrophes don't get in the way", () => {
  assert.deepEqual(rankSuggestions("jose", PLAYERS).map((item) => item.label), ["José Ortiz"]);
  assert.deepEqual(rankSuggestions("ONEIL", PLAYERS).map((item) => item.label), ["Jonathan O'Neil"]);
  assert.equal(normalizeForMatch("  José  O'Neil "), "jose oneil");
});

test("hints match after names; at most six; nothing once the full value is typed; duplicates once", () => {
  const courses = [
    { label: "Elm Street Park", hint: "Greenville, NC" }, { label: "Greenville Country Club", hint: "Greenville, NC" },
    { label: "River Park North", hint: "Greenville, NC" }, { label: "Covenant DGC", hint: "Winterville, NC" },
  ];
  assert.deepEqual(rankSuggestions("green", courses).map((item) => item.label), ["Greenville Country Club", "Elm Street Park", "River Park North"]);
  const many = Array.from({ length: 20 }, (_, index) => "Player " + index);
  assert.equal(rankSuggestions("pl", many).length, 6);
  assert.equal(rankSuggestions("pl", many, 3).length, 3);
  assert.deepEqual(rankSuggestions("Max Crotts", PLAYERS), []);
  assert.deepEqual(rankSuggestions("max", ["Max Crotts", "max crotts", "Max Crotts"]).map((item) => item.label), ["Max Crotts"]);
  assert.deepEqual(rankSuggestions("", PLAYERS), []);
  assert.equal(matchScore("zz", suggestionItem("Max Crotts")), null);
});

test("the typed part is shown bold", () => {
  assert.deepEqual(highlightParts("Jon Upchurch", "up"), [{ text: "Jon ", match: false }, { text: "Up", match: true }, { text: "church", match: false }]);
  assert.deepEqual(highlightParts("Jon Upchurch", "jo up"), [{ text: "Jo", match: true }, { text: "n Upchurch", match: false }]);
  assert.deepEqual(highlightParts("Jon", ""), [{ text: "Jon", match: false }]);
});

test("disc searches suggest brands, molds (with their brand) and, for Lost & Found, colours", () => {
  const discs = discSearchSuggestions();
  assert.deepEqual(rankSuggestions("destr", discs).map((item) => [item.label, item.hint]), [["Destroyer", "Innova"]]);
  assert.ok(rankSuggestions("innov", discs).some((item) => item.label === "Innova" && item.hint === "Brand"));
  assert.ok(!discs.some((item) => item.hint === "Colour"));
  assert.ok(rankSuggestions("oran", discSearchSuggestions({ colors: true })).some((item) => item.label === "Orange" && item.hint === "Colour"));
});

test("every member-app search uses the shared autocomplete", () => {
  const uses = (file, pattern) => assert.match(readFileSync(file, "utf8"), pattern, file);
  uses("src/members-app/club-directory-panel.js", /h\(AutocompleteInput, \{\s*suggestions: nameSuggestions/);
  uses("src/members-app/doubles-league-panel.js", /h\(AutocompleteInput, \{\s*suggestions: leaderboard\.map/);
  uses("src/members-app/community-panel.js", /field\("Find a member", AutocompleteInput, \{ suggestions: page\.profiles/);
  uses("src/members-app/registration-events.js", /useMemberNameSuggestions\(team, \{ token, request: requestJson/);
  uses("src/members-app/registration-events.js", /h\(AutocompleteInput, \{\s*suggestions: partnerNames/);
  uses("src/members-app/community-courses-panel.js", /h\(AutocompleteInput, \{[^}]*value: filter\.q,\s*suggestions: courseNames/);
  uses("src/members-app/practice-panels.js", /field\("Find in my bag", \{[^}]*suggestions: workspace\.data\.discs/);
  uses("src/score-app/setup-flow.js", /h\(AutocompleteInput, \{\s*suggestions: \(allCourses \|\| \[\]\)/);
  uses("src/score-app/setup-flow.js", /h\(AutocompleteInput, \{ className: "field", placeholder: "Layout name"/);
  uses("src/public-app/market-browse.js", /h\(AutocompleteInput, \{\s*suggestions: DISC_SUGGESTIONS/);
  uses("src/public-app/market-wanted.js", /h\(AutocompleteInput, \{ suggestions: DISC_SUGGESTIONS/);
  uses("src/public-app/lf-list.js", /h\(AutocompleteInput, \{\s*suggestions: LF_SUGGESTIONS/);
  uses("src/public-app/pro-shop-app.js", /h\(AutocompleteInput, \{\s*suggestions: \(products \|\| \[\]\)/);
  uses("src/admin-app/wallet-form.js", /h\(AutocompleteInput, \{\s*suggestions: roster\.map/);
  // Messages and the Play page's course search already list matches as you type.
  uses("src/members-app/messages-panel.js", /\/me\/messages\/people\?q=/);
  uses("tokens.css", /\.ac-list \{[^}]*background: var\(--bg-secondary\)/);
});

test("admin wallet balances: money, and which members show", () => {
  assert.equal(walletMoney(1250), "$12.50");
  assert.equal(walletMoney(-500), "-$5.00");
  const members = [
    { memberId: "m_a", name: "Ada Lovelace", pdgaNo: "80024", balanceCents: 1250 },
    { memberId: "m_b", name: "Bo Diddley", balanceCents: 0 },
    { memberId: "m_c", name: "Cy Young", balanceCents: -500 },
  ];
  assert.deepEqual(visibleWalletRows(members).map((member) => member.memberId), ["m_a", "m_c"]);
  assert.deepEqual(visibleWalletRows(members, { showZero: true }).map((member) => member.memberId), ["m_a", "m_b", "m_c"]);
  assert.deepEqual(visibleWalletRows(members, { query: "bo" }).map((member) => member.memberId), ["m_b"]);
  assert.deepEqual(visibleWalletRows(members, { query: "8002" }).map((member) => member.memberId), ["m_a"]);
  assert.match(readFileSync("admin.html", "utf8"), /<div id="adminWalletFormReactApp"><\/div>\s*<div id="adminWalletBalancesReactApp"><\/div>/);
});

// Owner: "Would be nice to have a drill down for wallet transactions here in admin so admin can see each transaction
// with every member."
test("the wallet drill-down: what each entry was, signed amounts, the balance after each, and who posted it", async () => {
  const { walletLedgerRows } = await import("../src/admin-app/wallet-balances.js");
  const rows = walletLedgerRows([
    { id: 9, amount_cents: -1500, source: "event_entry", event_id: 4, event_name: "Fall Classic", created_at: "2026-11-20 15:00:00", created_by: null },
    { id: 7, amount_cents: 1000, source: "manual_adjustment", note: "League payout", created_at: "2026-11-10 12:00:00", created_by: "m_admin" },
    { id: 3, amount_cents: 3100, source: "sheet_import", created_at: "2026-09-01 12:00:00", created_by: "m_gone" },
    { id: 2, amount_cents: 500, source: "marketplace_sale", order_id: 12 },
  ], { balanceCents: 2600, names: new Map([["m_admin", "Club Admin"]]) });
  assert.deepEqual(rows.map((row) => [row.what, row.detail, row.amountCents, row.balanceAfterCents, row.by]), [
    ["Event entry", "Fall Classic", -1500, 2600, ""],
    ["Admin adjustment", "", 1000, 4100, "Club Admin"],
    ["Google Sheet balance", "", 3100, 3100, "m_gone"],
    ["Marketplace sale", "Order #12", 500, 0, ""],
  ]);
  assert.equal(rows[1].note, "League payout");
  assert.match(rows[0].when, /Nov 20, 2026/);
  // A later page continues the running balance from where the first stopped.
  assert.equal(walletLedgerRows([{ id: 1, amount_cents: 200 }], { balanceCents: 2600, newerCents: 2400 })[0].balanceAfterCents, 200);
});

test("the recent ledger's entries read in words, without repeating the event in the note", async () => {
  const { describeWalletTx } = await import("../src/admin-app/wallet-balances.js");
  const names = new Map([["m_admin", "Club Admin"]]);
  assert.deepEqual(
    (({ what, detail, note, by, amountCents }) => ({ what, detail, note, by, amountCents }))(describeWalletTx({
      id: 3, amount_cents: 500, source: "event_payout", event_id: 4, event_name: "Putt League Test Scoring [scheduled]",
      note: "Event payout: Putt League Test Scoring [scheduled]", created_by: "m_admin",
    }, names)),
    { what: "Event payout", detail: "Putt League Test Scoring [scheduled]", note: "", by: "Club Admin", amountCents: 500 },
  );
  assert.equal(describeWalletTx({ amount_cents: -3500, source: "manual_adjustment", note: "Kg correcting testing wallet balance" }).note, "Kg correcting testing wallet balance");
  assert.match(readFileSync("src/admin-app/wallet-recent-list.js", "utf8"), /h\(WalletLedger, \{ member, names/);
});
