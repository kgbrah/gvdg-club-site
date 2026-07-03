# Gate Review: GVDG Events Live Order And Scoring

recommendation: APPROVE

## originalIntent

The recovered user intent was to move Live Now events to the top of the public Events page, fix live scoring display for doubles/matchplay rounds so the public view shows the correct play/scoring format, players, teams, team rows, and teammate names, show Live Now events in member/player dashboards, and close the previous final-gate blockers around missing durable evidence and implementation-mirroring static tests.

## desiredOutcome

- Public `events.html` renders `Live Now` before the normal Events feed.
- Public live-event detail renders `Doubles · Matchplay`, player count, team count, one row per team, and teammate names.
- Member dashboard renders public Live Now events before personal active scorecards.
- Public and member API payloads expose enough stable metadata for the UI: `format`, `play_format`, course name, and layout name.
- Tests cover rendered DOM and stable request/API contracts rather than source-shape snippets.
- Durable code-review, manual-QA, notepad, and screenshot evidence exists under `.omo/evidence`.

## userOutcomeReview

The working tree satisfies the recovered user outcome. The public Events capture shows `Live Now` above the regular Events feed, with the live card displaying `Doubles · Matchplay`. The event-detail capture shows the live summary cards for `Doubles · Matchplay`, `4 players`, and `2 teams · Blue / Red`; the leaderboard table uses the `Team` heading, team rows `Blue` and `Red`, and teammate subtext `TJ Braley / Jane Doe` and `Sam Smith / Riley Jones`.

The member dashboard capture shows `Live Now & Scorecards`, a public `Live now` card with `View event`, and the personal scorecard section below it. This matches the user-visible goal that members can see when a match is happening while still being able to rejoin their own scorecard.

Post-review mobile overlay fixes are included in the final capture set: the Crotts assistant button is suppressed at the site's mobile/tablet breakpoint so it does not cover event detail summary cards, and the member dashboard mobile header/menu no longer floats over scrolled content.

The implementation is real DOM and live data plumbing, not screenshot-only behavior. `events.html` renders `#liveEvents` before the calendar feed, uses existing DOM helper construction, and uses existing CSS variables/tokens for added summary and row styling. `events.js` keeps play-format/scoring-format handling in exported pure helpers and derives team rows from the live snapshot players/holes. The worker route changes expose `play_format`, course, and layout metadata on public events and member live rounds.

## blockers

None.

## programmingAndSlopReview

I loaded and applied the required `omo:remove-ai-slops` and `omo:programming` criteria, including the TypeScript reference for worker code. Direct pass results:

- No new `as any`, `@ts-ignore`, `@ts-expect-error`, non-null assertions, focused/skipped tests, or source-shape test blocks were found in the changed scope.
- The prior implementation-mirroring `tests/pwa.test.mjs` assertions for score setup were removed.
- `tests/events.ui.test.mjs` drives browser DOM flows and asserts visible order/content plus the stable `/rounds` POST contract separating `format: "matchplay"` from `playFormat: "doubles"`.
- `tests/events.parse.test.mjs` asserts stable helper outputs for normalization, format labels, and team-row aggregation; these are behavior contracts for exported helpers, not deletion-only tests.
- No excessive, tautological, or deletion-only tests were introduced for this goal.
- The new public-event query helpers in `club-public-routes.ts` are scoped to the public payload shape and avoid changing broader admin/internal DB helper behavior.
- Existing empty `catch` patterns and oversized legacy HTML/DB files remain outside this goal's scope; the changed behavior does not add a blocker-level slop issue for the recovered request.

The supplied code-review artifact also includes a `Programming And Slop Review` section covering no type escape hatches, existing DOM/token usage, removal of the source-shape test, and behavior-level browser replacement coverage. It is concise but supported by the inspected diff and current tests.

## checkedArtifactPaths

- `/home/kg/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/remove-ai-slops/SKILL.md`
- `/home/kg/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/programming/SKILL.md`
- `/home/kg/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/programming/references/typescript/README.md`
- `/home/kg/dev/gvdg-club-site/events.html`
- `/home/kg/dev/gvdg-club-site/events.js`
- `/home/kg/dev/gvdg-club-site/crotts.js`
- `/home/kg/dev/gvdg-club-site/gvdg-members.html`
- `/home/kg/dev/gvdg-club-site/auth-worker/src/club-public-routes.ts`
- `/home/kg/dev/gvdg-club-site/auth-worker/src/db.ts`
- `/home/kg/dev/gvdg-club-site/auth-worker/src/input.ts`
- `/home/kg/dev/gvdg-club-site/auth-worker/src/club-live-formats.ts`
- `/home/kg/dev/gvdg-club-site/auth-worker/src/club-rounds-routes.ts`
- `/home/kg/dev/gvdg-club-site/score.html`
- `/home/kg/dev/gvdg-club-site/auth-worker/test/admin-event-fixture.ts`
- `/home/kg/dev/gvdg-club-site/auth-worker/test/admin-events.test.ts`
- `/home/kg/dev/gvdg-club-site/auth-worker/test/my-live-rounds.test.ts`
- `/home/kg/dev/gvdg-club-site/tests/events.parse.test.mjs`
- `/home/kg/dev/gvdg-club-site/tests/events.ui.test.mjs`
- `/home/kg/dev/gvdg-club-site/tests/pwa.test.mjs`
- `/home/kg/dev/gvdg-club-site/package.json`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring-code-review.md`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring-manual-qa.md`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring-notepad.md`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-hub-1280.png`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-detail-1280.png`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-detail-375.png`
- `/home/kg/dev/gvdg-club-site/.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-member-dashboard-375.png`
- `/tmp/gvdg-live-now-visual-qa.mjs`

## verification

- CodeGraph consulted first for the indexed repository.
- `node --test tests/events.ui.test.mjs tests/pwa.test.mjs`: PASS, 10 tests.
- `git diff --check`: PASS.
- `npm --prefix auth-worker run typecheck`: PASS.
- `npm test`: PASS, 78 tests.
- `npm --prefix auth-worker test`: PASS, 52 files / 421 tests.
- `node /tmp/gvdg-live-now-visual-qa.mjs`: PASS, 7 fresh `/tmp` captures.
- Manual screenshot inspection: PASS for Live Now order, event detail team rows/teammates, member dashboard live-card placement, and the 375px/768px overlay fixes.

## exactEvidenceGaps

No blocking evidence gaps remain.

Nonblocking notes:

- `tests/events.ui.test.mjs` and `.omo/` evidence files are untracked in the working tree and must be included if this becomes a commit/PR.
- The existing empty registration-section shell can render as a blank band when there are no open registrations; it appears in the hub capture but is outside the recovered Live Now/scoring/dashboard request.
