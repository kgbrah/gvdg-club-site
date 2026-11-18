# Field test kit

The kit lets club volunteers play a real round on their own phones and send back measurements for
[field-verification.md](field-verification.md). Nothing here is a parity claim; it is how the claim gets its
evidence. The volunteer sheet is the public page [`field-test.html`](../field-test.html) (printable, one page).

## What the volunteers use

- **Field test mode** (off by default) in **Account → Devices** or the scorer's **Tools** sheet. While it is on,
  the scorecard shows a small **FIELD TEST** pill; tapping it adds notes (quick chips, free text, battery %).
- **Account → Field log** (`gvdg-members.html#field-test`): the summary, notes, **Export** (JSON + CSV through
  the share sheet, or a download), **Download files**, and **Clear log** (asks first).
- With the mode off nothing loads: the recorder is a lazy module (`score-app/field-test-recorder.js`, a member
  chunk in the member app). `scripts/qa/field-test-browser-qa.mjs` checks there is no request, listener, timer,
  observer or database.

## Running the day

1. **Before**: two volunteers, one iPhone and one Android phone, both club members, plus a second test account
   for the account-switch step. Phone B saves the layout under **Score → Offline rounds** on Wi-Fi. If anyone can
   watch from a third phone, they turn on Field test mode there too and open the round's watch link; that phone
   measures spectator delay.
2. **At the course**: each volunteer turns the mode on, names the phone in Field log ("Pixel 7 · Chrome"),
   fills in section 1 of the sheet, and (iPhone) enters a starting **Battery %** note.
3. **Round 1** (18 holes, four players, both phones score everyone) and **Round 2** (doubles: Phone A online,
   Phone B as an offline round from the saved course pack) follow the sheet's hole-by-hole script. The
   interruptions map to the round recovery matrix: airplane mode (4–5), close/reopen (7), concurrent edits and
   stale-edit review (9), lost upload response (10), phone restart (11), reconnect flapping (12), account
   switching (13), offline reload and offline clips (round 2). The 48-hour interruption (which also expires the
   12-hour sign-in) and low storage are separate.
4. **After**: each volunteer exports from Field log and sends both files plus a photo of the sheet. They keep
   the log until you confirm you have it.

Watch steps are on the sheet as "when the watch builds are available"; the native watch apps aren't distributed.

## What is recorded, and how

Every event has `at` (epoch ms), `t` (page clock ms), `sid` (one per app launch), `app` (`score` or `members`),
`type`, `net` (`on`/`off` at that moment) and `eff` (Chrome's effective connection type, when the browser has
one). The ring buffer is IndexedDB `gvdg-field-test`, capped at 10,000 events (oldest dropped), written on the next
task after each event so closing the app right after a tap loses nothing. The browser is asked to keep the
storage persistent.

| Measurement | Event(s) | Hook |
|---|---|---|
| Score-entry feedback | `tap.feedback` `{target, ms, clickMs}`; `tap.nochange` | Capture `pointerdown` on −, +, the value, the pad, hole navigation and the hole strip. `ms` runs from the pointerdown's timestamp to the first frame painted after the score area, hole header or pad changes (requestAnimationFrame, then a posted message, which lands just after the paint). `clickMs` starts at the click instead, without finger dwell. No visible change within 3 s is `tap.nochange`. |
| Server acknowledgement | `sync.queue` `{id, kind, hole, key, strokes, queue}`; `sync.ack` `{id, ms, queuedMs, state, attempt, status, error, queue}`; `sync.discard` | The round recovery journal in `score-controller.js`: enqueue, and each send in `drainRoundJournal`. `ms` is the request; `queuedMs` is from the tap's save to the acknowledgement (includes time offline). `state` is saved / pending (will retry) / auth / error. `error: recovery_edit_conflict` is a stale edit sent back for review. |
| Conflicts | `sync.conflict` `{hole, source}` | The scorer's live socket `conflict` message. |
| Connectivity | `net.offline`, `net.online` `{offlineMs}`, `net.change`; `ws.open` `{role, connectMs, recoverMs}`, `ws.close` `{role, code}` | Window online/offline, `navigator.connection` change; the scorer's and spectator's live sockets. `recoverMs` is close → next open. |
| Live update delay | `live.update` `{role, rev, delayMs, gapMs, revStep, first}` | Each new revision on the scorer's socket and in the spectator view. `delayMs` = arrival − the server's `updatedAt` for that revision (phone and server clocks; a few hundred ms of skew is possible). `gapMs` is the time between successive revisions. Same-revision rebroadcasts (weather, locations) and the first snapshot after opening are not delays. |
| Round lifecycle | `round.create`, `round.open` `{mode, roundCode, roundId, courseId, layoutId, holeCount, playerCount, cached}`, `round.finish` `{result, ms}`, `round.check` | Casual round create, each new card scope in `applyMinePayload`, the finish-card call; offline rounds log open/finish/`offline.save`/`offline.upload`. |
| End-of-round check | `round.check` `{verdict, checked, mismatches, duplicates, rows}` | When the card locks or the round goes final, the last score this phone entered for every player and hole is compared with the server's card. A difference, or the same write acknowledged twice, is `lost/duplicate suspected`. |
| Clips | `clip.start` `{id, bytes, mode}`, `clip.result` `{state, ms, status, error}` | The live and offline clip upload functions the clip queue drains. |
| Battery | `battery` `{level, charging}` every 5 min and on change; `battery.unavailable` | `navigator.getBattery()` (Android Chrome). iPhones have no battery API: volunteers add **Battery %** notes, and the summary uses those. |
| Errors | `error` `{kind, message, source}` | `error` and `unhandledrejection`: message and file:line:column only. |
| Context | `session.start`, `session.build`, `session.visibility`, `session.pagehide`, `auth.change`, `auth.expired` | UA, platform, screen, viewport, pixel ratio, Home Screen or browser, connection type, page (round/event only; tokens are dropped), member id, phone name, load type (reload); then the live commit from `version.json`, the HTML's build stamp, the service-worker cache name and storage use. |
| Notes | `note` `{chip, text, battery}` | The pill sheet and Field log. |

**Privacy**: every event goes through `src/shared/field-test-privacy.js` before it is stored and again on export.
It drops name, roster and identity keys (`name`, `playerName`, `label`, `members`, `players`, `pdgaNo`, `email`,
`token`, …) at any depth, replaces the round's player names in free text with `[player]`, and replaces PDGA numbers
(and bare 5–7 digit numbers in notes and error text) with `[number]`. Scores are keyed `i:<player index>` or
`t:<pair id>`, never by name. The member's own id is kept.

## Export format

- `gvdg-field-log-<phone>-<yyyymmdd-hhmm>.json`: `{ schema: "gvdg-field-log/1", exportedAt, device: { label, ua,
  platform, screen, dpr, standalone, memberId, commit, swCache }, summary, events: [...] }`. Android's share
  sheet can refuse `.json`, so the share also offers a `.json.txt` twin with the same content.
- `gvdg-field-log-<phone>-<yyyymmdd-hhmm>.csv`: `seq,time,session,app,type,net,eff,ms,target,kind,hole,state,status,detail`
  with everything else as JSON in `detail`. Text cells starting with `= + - @`, a tab or a carriage return get a
  leading apostrophe so a spreadsheet won't run them; numbers stay numeric.

## Reading and comparing the logs

```bash
node scripts/field/summarize-logs.mjs ~/field-day/*.json            # tables to the terminal (Markdown)
node scripts/field/summarize-logs.mjs ~/field-day/*.json --json out.json
```

Logs from the same phone (same label, or the same browser when unlabeled) are joined, and repeated exports are
de-duplicated. The report has:

- **Per device**: rounds finished/started, lost/duplicate suspicions, corrections (score entries after the first
  for the same player and hole), feedback and save medians (p90), retries/failed sends, offline minutes,
  reconnects and recovery, spectator delay, clips saved, battery %/h (from notes when there is no battery API).
- **Combined**: pooled medians and p90 across every sample, and the range of the device medians. Devices are never
  averaged into one claim; report the per-device rows and the range.
- **By network condition**: connected / slow (Chrome reports 2g or 3g) / interrupted (offline, or within 60 s of
  reconnecting), so slow and interrupted play are reported apart from ordinary play.

Median is the middle sample (mean of the two middle ones for an even count); p90 is the nearest-rank 90th
percentile. These are tested in `tests/field-test.test.mjs` and shared with the phone's Field log screen.

How to read it:

- **Feedback** should sit around one to three frames (≈16–50 ms) on a recent phone; a p90 above ~100 ms is worth a
  look at the raw `tap.feedback` rows for that hole.
- **Save** times are network round trips; `queuedMs` shows how long an edit waited while offline.
- Any **lost/duplicate suspected** fails the release regardless of averages. Open the JSON, find the
  `round.check` event and its `mismatches` (`key`, `hole`, `local`, `server`), then match it against the
  volunteer's notes and `sync.discard` events.
- **Spectator delay** depends on both clocks; compare it with `gapMs` and the scorer's `sync.ack` times when it
  looks off.
- **Battery** needs at least 15 minutes off the charger; iPhone numbers come from the volunteer's notes.

Still by hand: correction effort in taps and seconds, help requests, accessibility observations, UDisc timings,
clip availability after the round, and anything about the watch.
