import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { preRegistrationCsv } from "../src/admin-app/tournament-panel.js";
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
    "src/members-app/overview-dashboard.js": "Home: PDGA official rating, Next PDGA",
    "src/members-app/season-page.js": "Stats: PDGA official rating",
    "src/members-app/pdga-events-panel.js": "Nearby PDGA events",
    "src/home-app/feed-panels.js": "Public home: Area Tournaments (PDGA's API)",
    "src/score-app/scorecard-view.js": "Scorer: playing rating against the PDGA rating",
    "src/public-app/tournament-registration.js": "Public PDGA tournament registration",
    "src/admin-app/tournament-panel.js": "Admin PDGA tournament settings & reports",
    "src/admin-app/event-form.js": "Admin event PDGA lookup",
    "src/admin-app/scoring-panel.js": "Admin PDGA results export",
    "src/shared/pdga-membership.js": "PDGA membership join/renew card",
    "src/public-app/events-detail-app.js": "Public PDGA event detail page",
    "src/public-app/events-hub-app.js": "Public events schedule & PDGA sections",
  };
  for (const [file, what] of Object.entries(screens)) {
    assert.match(readFileSync(file, "utf8"), /h\(PdgaCredit,/, `${file} (${what}) shows the PDGA credit`);
  }
});

test("PDGA event names link to their pdga.com pages", () => {
  assert.match(readFileSync("src/members-app/pdga-dashboard.js", "utf8"), /pdgaPlayerHref\(pdgaNo\)/);
  assert.match(readFileSync("src/members-app/overview-dashboard.js", "utf8"), /h\(PdgaLink, \{ href: pdgaPlayerHref\(context\.pdgaNo\) \}, meta\)/);
  assert.match(readFileSync("src/members-app/pdga-events-panel.js", "utf8"), /h\(PdgaLink, \{ className: "register-name", href: event\.pdgaUrl/);
  assert.match(readFileSync("src/members-app/overview-dashboard.js", "utf8"), /h\(PdgaLink, \{ as: "div", className: "player-event-name", href: event\.pdgaUrl/);
  assert.match(readFileSync("src/home-app/feed-panels.js", "utf8"), /h\(PdgaLink, \{ as: "h4", className: "tournament-name", href: tournament\.pdgaUrl/);
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

// Owner: "Need PDGA attributions on the public facing site asap." PDGA's credit on every public page (the footer),
// under the lists of PDGA-sanctioned events, and on a PDGA event's page (with its pdga.com link).
test("every public page credits PDGA, and the PDGA event lists and pages do too", () => {
  const credit = /Player, event, and course data provided by <a href="https:\/\/www\.pdga\.com" target="_blank" rel="noopener noreferrer">PDGA<\/a>\./;
  for (const page of ["events.html", "ryder-cup.html", "lost-found.html", "pro-shop.html", "gvdg-blog.html", "scoring-app.html"]) {
    const html = readFileSync(page, "utf8");
    const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
    assert.match(footer, credit, page + " footer credits PDGA");
  }
  assert.match(readFileSync("src/home-app/community-sections.js", "utf8"), /"Player, event, and course data provided by ",\s*h\("a", \{ href: "https:\/\/www\.pdga\.com"/);
  assert.match(readFileSync("src/home-app/feed-panels.js", "utf8"), /h\(PdgaCredit, \{ key: "pdga-credit" \}\)/);
  assert.match(readFileSync("src/public-app/events-hub-app.js", "utf8"), /hub\.feedEvents\.length \? h\(PdgaCredit/);
  const detail = readFileSync("src/public-app/events-detail-app.js", "utf8");
  assert.match(detail, /h\(PdgaLink, \{ href: pdgaEventHref\(event\.pdga_event_id\) \}/);
  assert.match(detail, /event\.pdga_event_id \? h\(PdgaCredit/);
});

// PDGA's tech team (Nov 2026): no pdga.com content is shown from our pages; a pdga.com profile photo (older
// profiles) gives way to the member's initials.
test("pdga.com profile photos are not shown", async () => {
  const { shownProfilePhoto } = await import("../src/shared/profile-photo.js");
  assert.equal(shownProfilePhoto("https://www.pdga.com/files/pictures/picture-12345.jpg"), "");
  assert.equal(shownProfilePhoto("https://pdga.com/x.jpg"), "");
  assert.equal(shownProfilePhoto("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(shownProfilePhoto(null), "");
  const { playerPhotoSrc } = await import("../src/shared/hole-map-model.js");
  assert.equal(playerPhotoSrc("https://www.pdga.com/files/pictures/picture-12345.jpg"), "");
});

// PDGA's tech team (Nov 2026): no data from pdga.com pages or PDGA's internal endpoints. The features built on them
// are gone from the pages: who's registered for PDGA events, PDGA round ratings / event history / hole mix, the
// live rating estimate, and the admin's PDGA course baselines.
test("nothing in the site asks for the removed PDGA data", () => {
  const files = ["src/members-app/registration-data.js", "src/members-app/overview-dashboard.js", "src/members-app/registration-panel.js",
    "src/members-app/registration-events.js", "src/members-app/pdga-dashboard.js", "src/members-app/play-stats-panel.js",
    "src/admin-app/course-health.js", "src/members-app/season-charts.js"];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /pdga-registrations|pdga-baselines|(?:pdgaStats|stats)\?\.live_rating|play_rounds|peak_rating|Clubmates at PDGA/, file);
  }
  assert.doesNotMatch(readFileSync("src/members-app/pdga-dashboard.js", "utf8"), /Live rating estimate|Best round rating|Tournaments \(/);
  assert.doesNotMatch(readFileSync("src/shared/play-stats.js", "utf8"), /pdgaRowsFromStats/);
});

test("PDGA compliance cleanup: no scraped claims on scoring-app.html, no DGS scraper in admin, no Rating/Membership in CSV", () => {
  const scoring = readFileSync("scoring-app.html", "utf8");
  assert.doesNotMatch(scoring, /checks PDGA's registration lists|scoring mix for available PDGA rounds/);
  const pdgaRegisterSection = scoring.slice(scoring.indexOf('id="pdga-register"'), scoring.indexOf('id="pdga-nearby"'));
  assert.doesNotMatch(pdgaRegisterSection, /store credit/);
  const csv = preRegistrationCsv(
    [{ name: "Ada Lovelace", pdga_number: "80024", division: "MA3", pdga_rating: 935, pdga_status: "current", paid_at: "2026-11-11T10:00:00Z", payment_method: "paypal" }],
    [{ name: "Bo Wait", pdga_number: "90001", division: "MPO", pdga_rating: 1000, pdga_status: "current" }],
  );
  assert.match(csv, /^List,Order,Name,PDGA #,Division,Paid at,Method\nRegistered,1,Ada Lovelace,80024,MA3,/);
  assert.doesNotMatch(csv, /Rating|Membership|935|1000|current/);
  for (const file of ["src/admin-app/import-controls.js", "src/admin-app/import-controller.js"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /GVDG-DGS-Scraper|\/admin\/import\/dgs|Import from DiscGolfScene/);
  }
});
