# GVDG Events Live Order And Scoring Code Review

verdict: PASS

## Scope

Recovered goal from interrupted Codex session:

- Move Live Now events to the top of the public Events page.
- Fix live event detail scoring display so doubles/matchplay rounds show the correct play/scoring format, team count, team rows, and teammate names.
- Show public Live Now events in the member dashboard so members know a match is happening.
- Remove final-gate blocker from implementation-mirroring static test coverage.

## Reviewed Files

- `events.html`
- `events.js`
- `crotts.js`
- `gvdg-members.html`
- `auth-worker/src/club-public-routes.ts`
- `auth-worker/src/db.ts`
- `auth-worker/test/admin-event-fixture.ts`
- `auth-worker/test/admin-events.test.ts`
- `auth-worker/test/my-live-rounds.test.ts`
- `tests/events.parse.test.mjs`
- `tests/events.ui.test.mjs`
- `tests/pwa.test.mjs`
- `package.json`

## Findings

No blocking findings remain.

## Behavior Review

- Events hub now renders `#liveEvents` before the normal `#calendarEvents` feed.
- Event cards include separate play/scoring format text when metadata is available.
- Event detail summary renders format, player count, and team count/names for live doubles/matchplay rounds.
- Live standings render team rows with teammate names beneath the team label when the snapshot is team-based.
- Member dashboard renders a `Live Now & Scorecards` panel and includes public Live Now events before personal active scorecards.
- Public event APIs include `play_format`, course name, and layout name for list/detail payloads.
- Member live round API includes `play_format`, course name, layout name, and division for dashboard cards.
- The member dashboard mobile header/menu no longer behaves as a fixed overlay over scrolled content.
- The site-wide Crotts assistant button is suppressed at the site's mobile/tablet breakpoint so it does not obscure dense live scoring cards or tables.

## Programming And Slop Review

- No `as any`, `@ts-ignore`, or `@ts-expect-error` introduced.
- Production UI changes use existing DOM construction patterns and design tokens.
- Mobile overlay fixes are CSS-only and use the existing 768px breakpoint already used by the site.
- Format logic is in exported pure helpers in `events.js`, with behavior tests in `tests/events.parse.test.mjs`.
- The previous implementation-mirroring `tests/pwa.test.mjs` block for casual scorecard setup was removed.
- Replacement coverage in `tests/events.ui.test.mjs` drives the real browser UI and asserts the `/rounds` POST body contains separate `format: "matchplay"` and `playFormat: "doubles"` values.
- Live Now browser coverage asserts rendered section ordering, displayed doubles/matchplay labels, team/player summary, team column, teammate text, dashboard panel, and dashboard links.

## Known Nonblocking Debt

- `events.html`, `gvdg-members.html`, and `auth-worker/src/db.ts` are oversized legacy files. This recovered goal kept the fix scoped to the live-event workflow rather than splitting legacy surfaces.
- Static smoke tests remain in `tests/pwa.test.mjs` for PWA wiring and app-shell links. They are supplemental smoke checks, not the behavior lock for this live-event goal.

## Verification

- `node --test tests/events.ui.test.mjs tests/pwa.test.mjs`: PASS, 10 tests.
- `npm test`: PASS, 78 tests.
- `npm --prefix auth-worker run typecheck`: PASS.
- `npm --prefix auth-worker test`: PASS, 52 files and 421 tests.
- `node /tmp/gvdg-live-now-visual-qa.mjs`: PASS, 7 fresh captures.
- `git diff --check`: PASS.
