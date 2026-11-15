# Scorecard validation

The approved scorer keeps score entry and previous/next-hole navigation at the bottom. Weather, wind and gusts are populated in the actual-source browser fixture. Map actions no longer cover imagery; credits stay inside the image. Compact player labels retain full accessible names while separating smaller given names from emphasized surnames. The user approved this layout and these refinements.

The original visual pass was rejected and is superseded. Its rapid-input, recovery, finalization and shotgun match-play correctness fixes remain. The final combined source passed 515 frontend tests plus Chromium scoring/weather checks. These checks cover real app code with synthetic accounts and intercepted API responses.

## Repeat the checks

```sh
npm test
npm --prefix auth-worker run typecheck
npm --prefix auth-worker test -- test/live.test.ts
node scripts/qa/scorer-polish-browser-qa.mjs
node scripts/qa/scorer-weather-states-browser-qa.mjs
node scripts/qa/offline-round-browser-qa.mjs
```

The scorer fixture builds the source in memory and runs in Chromium. `GVDG_SCORER_SCREENSHOTS` sets the image directory. Set `GVDG_SCORER_SERVE=1` and optionally `GVDG_SCORER_PORT` to open the fixture for manual interaction. `GVDG_SCORER_CPU_RATE` defaults to 2× Chromium CPU slowdown. The offline round fixture emulates a downloaded module graph and blocks network access. Use the separate `scripts/qa/offline-service-worker-browser-qa.mjs` test for the generated service worker and cached documents.

| Check | Evidence |
| --- | --- |
| Frontend suite and Worker typecheck | 515 frontend tests passed and Worker typecheck passed |
| Live Durable Object | 107 tests passed, including an incomplete card returning 409, casual round finalization, and a match starting on hole 4 that blocked finishing with a gap before the clinch and locked with holes 1–3 unplayed |
| Scorer input and recovery | Five rapid increments produced five unique edits. A dropped acknowledgement triggered one retry. Pending scores survived reload, and reconnect synced the expected value. A cross-device conflict surfaced for review. Discard, reload, switched actor, and switched round left other scores intact |
| Local rounds | Single player and doubles, rapid input and keypad correction, marking a GPS fixture lie, reload, saved shots and clip draft, finish after queued edits, account and expiry checks, lost upload acknowledgement and personal archive link |
| Responsive controls checked | 390 px light phone, 320 px dark phone at 130% text size, 1280 px desktop with an applied Frost palette and wallpaper. Setup, score keypad, Round tools, shot editor, video sheet, wrist layout, full card and locking |

## Input feedback in Chromium

The fixture measures from an input event to the first animation frame showing the expected local change. Each cell reports median and 95th percentile in milliseconds from 12 samples. All three runs used the 2× throttle. Other test processes shared the host during the second run. Several full browser QA suites ran concurrently during the third run.

| Interaction | First run median / p95 | Second run median / p95 | Concurrent browser suites median / p95 |
| --- | ---: | ---: | ---: |
| Score stepper | 30 / 36 ms | 54 / 92 ms | 107 / 491 ms |
| Score keypad | 34 / 34 ms | 38 / 53 ms | 69 / 172 ms |
| Hole navigation | 37 / 42 ms | 47 / 60 ms | 69 / 398 ms |

Chromium reported zero long tasks in the first two samples and 20 in the concurrent run, with a longest task of 154 ms. These are local lab measurements. Physical phone responsiveness, on-course GPS and compass, camera permissions, video capture quality, and paired watch hardware need field checks. The browser fixtures use simulated positions, isolated sample accounts, and local API responses.


## Approved layout checks

The final fixture checks 390 px solo and four-player cards, 320 px enlarged text, landscape and desktop. All four score controls fit the 320 px / 125% text sample with 44 px targets. Independent touch checks exercised the final player, keypad focus/Escape, retained scores across Next/Previous, and map/round-detail scrolling. Singles, doubles matchplay and weighted putting passed. No map buttons overlap the image. Simulated safe-area and visual-viewport reductions passed; these do not stand in for a real phone keyboard or device cutout.

Weather tests cover loading, successful provider fallback, settled failure/offline, missing coordinates, missing wind/gust, valid zero wind speed, server-data priority and late results from the previous course.

A combined-source local run at 2× CPU throttle measured score 96/134 ms median/p95, keypad 54/92 ms and hole navigation 60/116 ms, with one 58 ms long task on the shared host. These are lab observations, not a real-device performance guarantee.
