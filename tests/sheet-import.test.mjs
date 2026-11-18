import assert from "node:assert/strict";
import test from "node:test";

import { fieldsFor, guessColumns, parseDues, parseMoney, parseTable, parseTag, parseTier, readRows, sheetCsvUrl } from "../src/shared/sheet-import.js";

test("reads CSV and cells copied out of Google Sheets", () => {
  assert.deepEqual(parseTable('Name,Balance\r\n"Parker, Jordan","$1,250.00"\r\n\r\nRiley Chen,"say ""hi"""\n'),
    [["Name", "Balance"], ["Parker, Jordan", "$1,250.00"], [""], ["Riley Chen", 'say "hi"']]);
  assert.deepEqual(parseTable("Player\tTag\nJordan Parker\t#7\n"), [["Player", "Tag"], ["Jordan Parker", "#7"]]);
  assert.deepEqual(parseTable(""), []);
});

test("turns any Google Sheets link into its CSV address", () => {
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc123/edit#gid=42"), "https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=42");
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing"), "https://docs.google.com/spreadsheets/d/abc123/export?format=csv");
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml?gid=7"), "https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?gid=7&single=true&output=csv");
  assert.equal(sheetCsvUrl("https://evil.example/spreadsheets/d/abc"), "");
  assert.equal(sheetCsvUrl("http://docs.google.com/spreadsheets/d/abc/edit"), "");
  assert.equal(sheetCsvUrl("not a link"), "");
});

test("guesses columns from the headers", () => {
  assert.deepEqual(guessColumns("balances", ["Player", "PDGA #", "Store Credit", "Member?"]), { pdga: 1, udisc: -1, balance: 2, first: -1, last: -1, name: 0, tier: 3 });
  assert.deepEqual(guessColumns("tags", ["First", "Last", "Bag Tag"]), { pdga: -1, udisc: -1, tag: 2, first: 0, last: 1, name: -1, tier: -1 });
  assert.deepEqual(guessColumns("dues", ["Name", "UDisc", "2026 Dues Paid"]), { pdga: -1, udisc: 1, dues: 2, first: -1, last: -1, name: 0, tier: -1 });
  assert.deepEqual(fieldsFor("people"), ["name", "first", "last", "pdga", "udisc", "tier"]);
});

test("reads amounts, dues, tags and tiers the way people type them", () => {
  assert.equal(parseMoney("$12.50"), 1250);
  assert.equal(parseMoney("(5.00)"), -500);
  assert.equal(parseMoney("-$3"), -300);
  assert.equal(parseMoney("1,000"), 100000);
  assert.equal(parseMoney(""), null);
  assert.ok(Number.isNaN(parseMoney("ten")));
  assert.equal(parseDues("Paid", 2026), 2026);
  assert.equal(parseDues("✓", 2026), 2026);
  assert.equal(parseDues("Paid 2027", 2026), 2027);
  assert.equal(parseDues("no", 2026), null);
  assert.equal(parseDues("", 2026), null);
  assert.ok(Number.isNaN(parseDues("maybe", 2026)));
  assert.equal(parseTag("#7"), 7);
  assert.equal(parseTag("Tag 12"), 12);
  assert.ok(Number.isNaN(parseTag("seven")));
  assert.equal(parseTier("Guest"), "guest");
  assert.equal(parseTier("M"), "member");
  assert.equal(parseTier("?"), "");
});

test("makes rows for the Worker, keeping sheet line numbers and flagging unreadable values", () => {
  const table = parseTable("Player,PDGA,Balance,Type\nJordan Parker,#80024,$20,Member\n,,,\nRiley Chen,,ten,Guest\n@nobody,,,\nSam Lee,,(3.00),\n");
  const rows = readRows("balances", table, guessColumns("balances", table[0]));
  assert.deepEqual(rows, [
    { line: 2, name: "Jordan Parker", pdga: "80024", udisc: "", tier: "member", value: 2000 },
    { line: 4, name: "Riley Chen", pdga: "", udisc: "", tier: "guest", value: null, error: '"ten" isn\'t an amount' },
    { line: 5, name: "@nobody", pdga: "", udisc: "", tier: "", value: null },
    { line: 6, name: "Sam Lee", pdga: "", udisc: "", tier: "", value: -300 },
  ]);
  const first = parseTable("First,Last,Dues\nJordan,Parker,yes\n");
  assert.deepEqual(readRows("dues", first, guessColumns("dues", first[0]), { duesYear: 2026 }),
    [{ line: 2, name: "Jordan Parker", pdga: "", udisc: "", tier: "", value: 2026 }]);
});
