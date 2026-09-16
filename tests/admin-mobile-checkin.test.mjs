import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("admin phone chrome hides the public hamburger and stacks the dock above Crotts", () => {
  const html = readFileSync("admin.html", "utf8");
  const chrome = readFileSync("src/admin-app/page-chrome.js", "utf8");
  const nav = readFileSync("src/admin-app/navigation.js", "utf8");
  const crotts = readFileSync("src/shared/crotts-widget.js", "utf8");
  const tokens = readFileSync("tokens.css", "utf8");

  assert.match(html, /z-index: 10050/);
  assert.match(html, /header \.menu-toggle \{ display: none !important; \}/);
  assert.match(html, /header \.nav-account \{ display: flex !important;/);
  assert.match(html, /footer, \.back-link \{ display: none; \}/);
  assert.match(html, /\.admin-btn \{[^}]*min-height: 44px;/);
  assert.match(html, /\.admin-btn\.danger \{[^}]*min-height: 44px;/);
  assert.match(html, /\.admin-chip \{[^}]*min-height: 44px;/);
  assert.match(html, /\.admin-form input, \.admin-form select, \.admin-form textarea \{[^}]*font-size: 16px;/);
  assert.match(html, /\.admin-today-tiles \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(html, /\.admin-dialog-overlay \{[^}]*z-index: 11000;/);
  assert.match(html, /\.admin-roster \{ display: grid;/);
  assert.match(html, /\.admin-roster-card \{/);
  assert.match(chrome, /helpLink\("desktop-help-link"\)/);
  assert.match(chrome, /CrottsHelpLink/);
  assert.match(chrome, /nav-account-short/);
  assert.match(chrome, /Back to Members/);
  assert.match(nav, /"aria-selected": selected \? "true" : "false"/);
  assert.match(nav, /role: "tab"/);
  assert.match(crotts, /body\.admin-page #crotts-panel/);
  assert.match(crotts, /z-index:10040/);
  assert.match(tokens, /body\.admin-page \.pwa-update/);
});

test("admin registration roster is check-in cards instead of an al-holes table", () => {
  const roster = readFileSync("src/admin-app/registration-roster.js", "utf8");
  const rows = readFileSync("src/admin-app/registration-roster-rows.js", "utf8");

  assert.match(roster, /className: "admin-roster"/);
  assert.doesNotMatch(roster, /className: "al-holes"/);
  assert.doesNotMatch(roster, /thead|tbody|<tr|colSpan/);
  assert.match(rows, /className: "admin-roster-card"/);
  assert.match(rows, /"aria-pressed"/);
  assert.match(rows, /Check in/);
  assert.match(rows, /Walk-on/);
  assert.match(rows, /gvdg:admin-registration-roster-patch-request/);
  assert.match(rows, /gvdg:admin-registration-remove-request/);
  assert.match(rows, /gvdg:admin-registration-manual-remove-request/);
  assert.match(rows, /data-admin-registration-id/);
  assert.match(rows, /data-admin-registration-manual-id/);
});
