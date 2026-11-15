import assert from "node:assert/strict";
import test from "node:test";

import { leagueAbout } from "../src/public-app/events-league-detail-app.js";

test("a league blurb splits the weekly layouts and hides the raw UDisc address", () => {
  const about = leagueAbout(
    "Weekly handicap league at The Meadow. Sign in every Sunday by 10am. Entry $2, with $1 going to best handicap score and $1 going to best overall score. First week entry is $5 for the bag tag. If you stop playing you will be refunded the $5 when you return your tag. Set layouts based on the week of the month. First Sunday - White Pads to B pins Second Sunday - Purple layout Third Sunday - White Pads to A pins Fourth Sunday - Gold Layout Fifth Sunday - Blue pads to A pins\nhttps://udisc.com/leagues/sunday-baggers-1lgehZ",
  );
  assert.match(about.intro, /refunded the \$5/);
  assert.doesNotMatch(about.intro, /First Sunday|udisc\.com/);
  assert.deepEqual(about.layouts.map((row) => row.label), [
    "First Sunday",
    "Second Sunday",
    "Third Sunday",
    "Fourth Sunday",
    "Fifth Sunday",
  ]);
  assert.equal(about.layouts[0].value, "White Pads to B pins");
  assert.equal(about.layouts[4].value, "Blue pads to A pins");
  assert.deepEqual(about.urls, ["https://udisc.com/leagues/sunday-baggers-1lgehZ"]);
});

test("a league blurb without a schedule stays one paragraph", () => {
  const about = leagueAbout("Just a weekly round.");
  assert.equal(about.intro, "Just a weekly round.");
  assert.deepEqual(about.layouts, []);
  assert.deepEqual(about.urls, []);
});
