import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PDGA_HOME, pdgaEventHref, pdgaPlayerHref } from "../src/shared/pdga-credit.js";

// PDGA Developer Program attribution: every screen showing PDGA data says "Player, event, and course data provided
// by PDGA." (PDGA linked to pdga.com), and PDGA event and player names link to their pdga.com pages.

test("PDGA links point at pdga.com player and event pages, and nowhere else", () => {
  assert.equal(PDGA_HOME, "https://www.pdga.com");
  assert.equal(pdgaPlayerHref("#80024"), "https://www.pdga.com/player/80024");
  assert.equal(pdgaEventHref(104547), "https://www.pdga.com/tour/event/104547");
  assert.equal(pdgaEventHref("javascript:alert(1)"), "https://www.pdga.com/tour/event/1");
  assert.equal(pdgaEventHref(""), "");
  const credit = readFileSync("src/shared/pdga-credit.js", "utf8");
  assert.match(credit, /"Player, event, and course data provided by "/);
  assert.match(credit, /rel: "noopener noreferrer"/);
});

test("every screen that shows PDGA data carries the PDGA credit", () => {
  const screens = {
    "src/members-app/overview-dashboard.js": "Home: PDGA live and official rating, PDGA events, Next PDGA",
    "src/members-app/season-page.js": "Stats: PDGA ratings and history, ratings from PDGA course data",
    "src/members-app/pdga-events-panel.js": "Nearby PDGA events",
    "src/members-app/pdga-registrations.js": "Clubmates at PDGA events",
    "src/members-app/registration-events.js": "My events: PDGA events the member is registered for",
    "src/admin-app/pdga-baselines-panel.js": "Admin PDGA rated rounds and baselines",
    "src/score-app/scorecard-view.js": "Scorer: playing rating from PDGA course data or against the PDGA rating",
  };
  for (const [file, what] of Object.entries(screens)) {
    assert.match(readFileSync(file, "utf8"), /h\(PdgaCredit,/, `${file} (${what}) shows the PDGA credit`);
  }
});

test("PDGA event names link to their pdga.com pages", () => {
  assert.match(readFileSync("src/members-app/pdga-dashboard.js", "utf8"), /h\(PdgaLink, \{ as: "div", className: "dash-event-name", href: pdgaEventHref\(event\.eventId\)/);
  assert.match(readFileSync("src/members-app/pdga-dashboard.js", "utf8"), /pdgaPlayerHref\(pdgaNo\)/);
  assert.match(readFileSync("src/members-app/pdga-events-panel.js", "utf8"), /h\(PdgaLink, \{ className: "register-name", href: event\.pdgaUrl/);
  assert.match(readFileSync("src/members-app/pdga-registrations.js", "utf8"), /h\(PdgaLink, \{ className: "register-name", href: event\.url/);
  assert.match(readFileSync("src/admin-app/pdga-baselines-panel.js", "utf8"), /href: pdgaEventHref\(round\.tournId\)/);
});

test("an event can be marked a PDGA event in the event form, and lists badge it", () => {
  const form = readFileSync("src/admin-app/event-form.js", "utf8");
  assert.match(form, /PDGA-sanctioned event \(players register on this site, not Disc Golf Scene\)/);
  assert.match(form, /\/admin\/events\/\$\{encodeURIComponent\(detail\.eventId\)\}\/pdga`, \{ method: "PATCH"/);
  assert.match(readFileSync("src/public-app/events-hub-app.js", "utf8"), /event\.pdga \? h\(Badge, \{ className: "type-badge pdga-badge", key: "pdga", text: "PDGA" \}\)/);
  assert.match(readFileSync("src/public-app/events-detail-app.js", "utf8"), /event\.pdga_event_id \? h\(Badge/);
  assert.match(readFileSync("src/members-app/registration-events.js", "utf8"), /tournament \? h\("span", \{ className: "player-chip pdga-badge"/);
  assert.match(readFileSync("src/admin-app/events-list.js", "utf8"), /event\.source\?\.pdga_event_id \?/);
});

test("the event page keeps the PDGA link (normalizeEvent used to drop it, hiding the PDGA badge)", async () => {
  const { normalizeEvent } = await import("../src/shared/events-model.js");
  assert.equal(normalizeEvent({ id: 7, name: "Fall Classic", pdga_event_id: 104547 }).pdga_event_id, 104547);
  assert.equal(normalizeEvent({ id: 8, name: "League night" }).pdga_event_id, null);
  assert.equal(normalizeEvent({ id: 9, name: "Bad", pdga_event_id: "abc" }).pdga_event_id, null);
});
