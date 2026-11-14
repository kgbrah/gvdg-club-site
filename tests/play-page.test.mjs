import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatUdiscWhen, latestHomeRound, publicCasualRound, recentPlayRounds, relClass, roundRatingOf } from "../src/members-app/play-page-model.js";

test("recentPlayRounds keeps the newest unique casual cards", () => {
  const rows = recentPlayRounds([
    { round_code: "old1", course_name: "West", finalized_at: "2026-09-01T12:00:00Z", to_par: 4, total: 58 },
    { round_code: "jqeu74", course_name: "Ayden Park", layout_name: "Blue", finalized_at: "2026-09-18T12:00:00Z", to_par: -3, total: 51 },
    { round_code: "JQEU74", course_name: "Ayden Park dup", finalized_at: "2026-09-18T13:00:00Z", to_par: -3, total: 51 },
    { round_code: "", course_name: "Nope" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, "JQEU74");
  assert.equal(rows[0].title, "Ayden Park");
  assert.equal(rows[0].href, "score.html?round=JQEU74&watch=1");
  assert.equal(rows[0].toPar, -3);
  assert.equal(rows[1].code, "OLD1");
});

test("latestHomeRound prefers a newer casual card and keeps its mix", () => {
  const casual = latestHomeRound(
    [{ event_id: 4, event_name: "League", event_date: "2026-09-01", to_par: 1, place: 3 }],
    [{
      round_code: "SATURDAY",
      course_name: "Ayden Park",
      layout_name: "Main",
      finalized_at: "2026-09-18T12:00:00Z",
      to_par: -2,
      breakdown: JSON.stringify({ birdies: 4, pars: 10, bogeys: 3, doubles_plus: 1 }),
    }],
  );
  assert.equal(casual.kind, "casual");
  assert.equal(casual.title, "Ayden Park");
  assert.equal(casual.href, "score.html?round=SATURDAY&watch=1");
  assert.equal(casual.mix, "4 birdies · 10 pars · 3 bogeys · 1 dbl+");
  const event = latestHomeRound(
    [{ event_id: 4, event_name: "League", event_date: "2026-10-01", to_par: 1, place: 3 }],
    [{ round_code: "OLD", course_name: "West", finalized_at: "2026-09-01T12:00:00Z", to_par: 4 }],
  );
  assert.equal(event.kind, "event");
  assert.equal(event.href, "events.html#event/4");
});

test("round ratings ride on casual cards, event results, and not on doubles or match play", () => {
  assert.equal(roundRatingOf({ round_rating: 948.2, rating: 900 }), 948);
  assert.equal(roundRatingOf({ rating: "910" }), 910);
  assert.equal(roundRatingOf({ stroke: false, round_rating: 999 }), null);
  assert.equal(roundRatingOf({ match_result: "{\"result\":\"win\"}", rating: 880 }), null);
  assert.equal(roundRatingOf({}), null);
  const casual = publicCasualRound({
    round_code: "SATURDAY",
    course_name: "Farmville DiscGolfPark",
    to_par: 0,
    place: 1,
    rating: 948,
  });
  assert.equal(casual.rating, 948);
  const home = latestHomeRound(
    [{ event_id: 4, event_name: "League", event_date: "2026-10-02", to_par: 1, place: 3, round_rating: 932, rating: 900 }],
    [{ round_code: "OLD", course_name: "West", finalized_at: "2026-09-01T12:00:00Z", to_par: 4, rating: 870 }],
  );
  assert.equal(home.kind, "event");
  assert.equal(home.rating, 932);
  const overview = readFileSync("src/members-app/overview-dashboard.js", "utf8");
  const play = readFileSync("src/members-app/play-page.js", "utf8");
  const season = readFileSync("src/members-app/season-page.js", "utf8");
  const html = readFileSync("gvdg-members.html", "utf8");
  assert.match(overview, /Round rating/);
  assert.match(play, /Round rating/);
  assert.match(season, /roundRatingOf/);
  assert.match(html, /\.round-rating/);
});

test("publicCasualRound skips empty codes and paints relative colors", () => {
  assert.equal(publicCasualRound({}), null);
  assert.equal(relClass(-1), "under");
  assert.equal(relClass(0), "even");
  assert.equal(relClass(2), "over");
  assert.equal(relClass(null), "");
});

test("Play tab mounts a recent-rounds panel that watches finished cards", () => {
  const playPage = readFileSync("src/members-app/play-page.js", "utf8");
  const html = readFileSync("gvdg-members.html", "utf8");
  assert.match(playPage, /data-react-play-recent/);
  assert.match(playPage, /Recent rounds/);
  assert.match(playPage, /Replay/);
  assert.match(playPage, /\/my-results/);
  assert.match(playPage, /recentPlayRounds/);
  assert.match(playPage, /Club handicap/);
  assert.match(playPage, /myLayoutHandicaps/);
  assert.match(playPage, /data-react-play-handicap/);
  assert.match(html, /\.recent-round-score/);
  assert.match(html, /\.recent-round-score\.even, \.season-result-par\.even \{ color: var\(--accent\)/);
  assert.match(html, /\.recent-round-score\.over, \.season-result-par\.over \{ color: var\(--team-red\)/);
});

test("Play tab imports UDisc history without feeding the club handicap", () => {
  const playPage = readFileSync("src/members-app/play-page.js", "utf8");
  const html = readFileSync("gvdg-members.html", "utf8");
  assert.equal(formatUdiscWhen("2024-03-15T10:14:00"), "Fri, Mar 15, 2024 · 10:14 AM");
  assert.equal(formatUdiscWhen("2024-03-15T00:00:00"), "Fri, Mar 15, 2024");
  assert.match(playPage, /data-react-udisc-history/);
  assert.match(playPage, /data-react-udisc-stats/);
  assert.match(playPage, /no UDisc id/);
  assert.match(playPage, /No putting, fairway, or penalty stats/);
  assert.match(playPage, /\/me\/udisc-history/);
  assert.match(playPage, /do not change your club handicap/);
  assert.match(playPage, /Export to CSV/);
  assert.match(html, /\.udisc-history-row/);
  assert.match(html, /\.udisc-stat-grid/);
});
