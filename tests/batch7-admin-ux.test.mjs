import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(path, "utf8");
}

test("Batch 7 archive export & destination security controls", () => {
  const controls = read("src/admin-app/data-archive-export-controls.js");
  assert.match(controls, /if \(form\.destinationId\) body\.endpoint_id = Number\(form\.destinationId\);\s*else body\.download_only = true;/);
  assert.match(controls, /current\.destinationId === ""/);
  assert.match(controls, /if \(busy\) return;/);

  const form = read("src/admin-app/data-archive-destination-form.js");
  assert.match(form, /\^https:\\\/\\\//);
  assert.match(form, /autoComplete:\s*"new-password"/);
  assert.match(form, /id:\s*"dxAuthToken"[\s\S]*type:\s*"password"/);
  assert.match(form, /if \(busy\) return;/);

  const controller = read("src/admin-app/data-archive-controller.js");
  assert.match(controller, /async function activateDataArchiveDestination[\s\S]*?try\s*\{[\s\S]*?adminApi/);
  assert.match(controller, /async function deleteDataArchiveDestination[\s\S]*?try\s*\{[\s\S]*?adminApi/);
});

test("Batch 7 admin registration, putting preservation & bulk member cap", () => {
  const regControls = read("src/admin-app/registration-controls.js");
  assert.match(regControls, /existing\.scoringStyle === "putting" && existing\.putting \? \{ putting: existing\.putting \} : \{\}/);
  assert.match(regControls, /id:\s*"rgEntry"[\s\S]*step:\s*"0\.01"/);
  assert.match(regControls, /id:\s*"rgCtp"[\s\S]*step:\s*"0\.01"/);
  assert.match(regControls, /id:\s*"rgAce"[\s\S]*step:\s*"0\.01"/);

  const picker = read("src/admin-app/registration-member-picker.js");
  const selectAllBlock = picker.match(/function selectAllShown\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.doesNotMatch(selectAllBlock, /setSelected\(\(/);
  assert.match(selectAllBlock, /const next = new Set\(selectedIds\);/);
  assert.match(selectAllBlock, /setError\(hitCap \? "Select 40 or fewer members at a time\." : ""\);/);
  assert.match(picker, /if \(next\.size <= 40\) setError\(""\);/);
  assert.match(picker, /if \(selectedIds\.length > 40\)/);
  assert.match(picker, /Select 40 or fewer members at a time\./);
});

test("Batch 7 product lock, event form refs/putting preservation & finalize delegation", () => {
  const products = read("src/admin-app/products-list.js");
  assert.match(products, /disabled:\s*sellBusy \|\| Number\(stockValue\) < 1/);

  const eventForm = read("src/admin-app/event-form.js");
  assert.match(eventForm, /scoring === "putting" && !editingEvent \? \{ putting: \{ stations: defaultPuttingStations\(\) \} \} : \{\}/);
  assert.match(eventForm, /const formRef = React\.useRef\(form\);[\s\S]*formRef\.current = form;/);
  assert.match(eventForm, /applyEventVoice\(latestForm, fields, coursesRef\.current\)/);
});

test("Batch 7 bag tags auth gate, nav donations badge, admin shelf snapshot & scoring guards", () => {
  const bagTags = read("src/admin-app/bag-tags-panel.js");
  assert.doesNotMatch(bagTags, /dataset\.adminPanel/);
  assert.match(bagTags, /currentAdminAuthGateState\(\)\.status !== "panel"/);

  const nav = read("src/admin-app/navigation.js");
  assert.match(nav, /function itemBadge\(key\)[\s\S]*key === "donations"/);

  const needs = read("src/admin-app/admin-needs.js");
  assert.match(needs, /let adminShelfState = null;/);
  assert.match(needs, /React\.useState\(\(\) => adminShelfState\)/);
  assert.match(needs, /if \(adminShelfState != null\) setShelf\(adminShelfState\);/);

  const scorecard = read("src/admin-app/scoring-scorecard.js");
  assert.match(scorecard, /const initial = score == null \? "" : String\(score\);[\s\S]*if \(readOnly \|\| !trimmed \|\| trimmed === initial\) return;/);

  const scoringPanel = read("src/admin-app/scoring-panel.js");
  assert.match(scoringPanel, /dispatchRequest\("gvdg:admin-tab-request", \{ tab: "registration", eventId: state\.eventId \}\)/);
});

test("Batch 7 import retry, donations inline reject, push state safety & controller error handling", () => {
  const candidates = read("src/admin-app/import-candidates-list.js");
  assert.match(candidates, /requestKeysRef\.current\.set/);
  assert.match(candidates, /failed[\s\S]*Retry/);

  const donations = read("src/admin-app/donations-panel.js");
  assert.doesNotMatch(donations, /window\.prompt/);
  assert.match(donations, /className:\s*"admin-mark-paid-form"/);
  assert.match(donations, /Confirm not received/);

  const push = read("src/admin-app/admin-push.js");
  assert.match(push, /let unsubscribed = false;/);
  assert.match(push, /setState\(unsubscribed \? "off" : "on"\)/);
  assert.match(push, /role:\s*"alert"/);

  const controller = read("src/admin-app/admin-controller.js");
  assert.match(controller, /if \(pane !== 'scoring'\) scCloseWs\(\);/);
  assert.match(controller, /if \(!scEventId\) \{\s*scCloseWs\(\);/);
  assert.match(controller, /if \(!delegated\) finishAdminScoringAction\('finalize', finalized\);/);
  assert.match(controller, /gvdg:admin-product-save-result/);
  assert.match(controller, /gvdg:admin-membership-action-result/);
  assert.match(controller, /gvdg:admin-wallet-balances-refresh/);
});

test("Batch 7 mobile 44px touch targets in admin-polish.css", () => {
  const css = read("admin-polish.css");
  assert.match(css, /\.admin-page \.admin-member-actions > \.admin-btn,[\s\S]*min-height:\s*2\.75rem;/);
  assert.match(css, /\.admin-page \.admin-member-actions \.admin-member-tier select\s*\{[^}]*min-height:\s*2\.75rem;/);
  assert.match(css, /\.admin-page \.admin-header-icon\s*\{[^}]*width:\s*2\.75rem;\s*height:\s*2\.75rem;/);
  assert.match(css, /\.admin-page \.admin-header-actions \.theme-toggle\s*\{[^}]*width:\s*2\.75rem;\s*height:\s*2\.75rem;/);
});
