import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Owner: "update the website letting people know about all the app features including lost and found. Don't want to
// direct lost discs to facebook group yet, want to have people use the app or website flow for that." And: "update
// the readme and website with the PDGA integration info and features."

test("Home sends lost discs to Lost & Found, and the Facebook group keeps rain calls only", () => {
  const hero = readFileSync("src/home-app/hero-about-app.js", "utf8");
  assert.match(hero, /href: "lost-found\.html", key: "lost-found" \}, \[\s*h\("span", \{ key: "copy" \}, "Lost a disc, or found one\?"\),\s*h\("strong", \{ key: "go" \}, "Lost & Found"\)/);
  assert.match(hero, /"Rain calls, who's playing"/);
  for (const file of ["src/home-app/hero-about-app.js", "src/home-app/community-sections.js", "src/home-app/scoring-teaser.js", "index.html", "scoring-app.html", "lost-found.html"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /lost discs?[^.\n]{0,60}facebook|facebook[^.\n]{0,60}lost discs?/i, file + " doesn't point lost discs at Facebook");
  }
});

test("Home's app section covers the whole app, Lost & Found and PDGA included", () => {
  const teaser = readFileSync("src/home-app/scoring-teaser.js", "utf8");
  for (const title of ["Score + watch live", "Stats + club ranks", "Lost & Found", "PDGA, built in", "My Bag + marketplace", "Customize your app"]) {
    assert.ok(teaser.includes(`title: "${title}"`), title);
  }
  assert.match(readFileSync("src/home-app/community-sections.js", "utf8"), /\$5 off PDGA membership with the club's code/);
});

test("the app page has Lost & Found and PDGA in its rail, a PDGA section with PDGA's credit, and FAQs", () => {
  const page = readFileSync("scoring-app.html", "utf8");
  assert.match(page, /<a href="#lost-found">Lost &amp; Found<\/a><a href="#pdga">PDGA<\/a>/);
  assert.match(page, /<section class="signature-section new-features" id="pdga" aria-labelledby="pdga-title">/);
  for (const id of ["pdga-ratings", "pdga-register", "pdga-nearby", "pdga-membership"]) assert.ok(page.includes(`<article id="${id}">`), id);
  assert.match(page, /Player, event, and course data provided by <a href="https:\/\/www\.pdga\.com"/);
  assert.match(page, /<summary>Lost a disc, or found one\?<\/summary><p>Post it in <a href="lost-found\.html">Lost &amp; Found<\/a>/);
  // Registering here is only for PDGA events the club runs (owner: "register here only applies for our events").
  assert.match(page, /<summary>Can I sign up for the club's PDGA events here\?<\/summary><p>Yes\. When GVDG runs a PDGA-sanctioned event/);
  assert.match(page, /<h3>Our events\.<br>Register with us\.<\/h3><p>When GVDG runs a PDGA-sanctioned event/);
  assert.doesNotMatch(page, /Register here\.<br>Skip the extra fee/);
  assert.match(page, /The club rating is the club's, not an official PDGA rating\./);
  assert.doesNotMatch(page, /Live rating estimate|Best round rating/);
});

test("the README documents the PDGA integration", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /^### PDGA$/m);
  for (const text of ["PDGA_API_USERNAME", "PdgaCredit", "PDGA-sanctioned event", "/admin/club-settings/pdga-promo", "PATCH /admin/events/:id/pdga", "src/shared/outside-link.js"]) {
    assert.ok(readme.includes(text), text);
  }
});
