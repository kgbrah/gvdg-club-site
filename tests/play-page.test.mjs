import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { publicCasualRound, recentPlayRounds, relClass } from "../src/members-app/play-page-model.js";

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
  assert.match(html, /\.recent-round-score/);
  assert.match(html, /\.recent-round-score\.even, \.season-result-par\.even \{ color: var\(--accent\)/);
  assert.match(html, /\.recent-round-score\.over, \.season-result-par\.over \{ color: var\(--team-red\)/);
});
