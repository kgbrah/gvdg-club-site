# GVDG Events Live Order And Scoring Notepad

## Recovery Context

Interrupted parent Codex session:

- Session ID: `019f2387-3267-7211-98d9-dc3da478c23c`
- First user request: `continue the admin cleanup work on gvdgclub.com`
- Recovered active slice: move Live Now above Events, correct live doubles/matchplay display, and show Live Now events in member dashboards.

The UI behavior was already passing in the prior session. Final gate rejected because durable evidence artifacts were missing and a source-regex static test was flagged as implementation-mirroring coverage.

## Blockers Closed

- Removed the static source-shape score setup test from `tests/pwa.test.mjs`.
- Added behavior-level Playwright coverage in `tests/events.ui.test.mjs` that uses the rendered score setup flow and checks the posted `/rounds` body.
- Regenerated fresh visual QA captures with `/tmp/gvdg-live-now-visual-qa.mjs`.
- Copied fresh captures under `.omo/evidence/gvdg-events-live-order-scoring/`.
- Added this notepad, manual QA matrix, and code review artifact for final-gate review.
- Fixed the fresh visual-gate mobile blockers:
  - Crotts no longer overlays live scoring content at the mobile/tablet breakpoint.
  - The member dashboard mobile header/menu no longer floats over the Store Credit wallet panel after scrolling.

## Current Verification

- `node --test tests/events.ui.test.mjs tests/pwa.test.mjs`: PASS.
- `npm test`: PASS, 78 tests.
- `npm --prefix auth-worker run typecheck`: PASS.
- `npm --prefix auth-worker test`: PASS, 52 files and 421 tests.
- `node /tmp/gvdg-live-now-visual-qa.mjs`: PASS.
- `git diff --check`: PASS.

## Final Review Inputs

- Code review: `.omo/evidence/gvdg-events-live-order-scoring-code-review.md`
- Manual QA: `.omo/evidence/gvdg-events-live-order-scoring-manual-qa.md`
- Durable screenshots: `.omo/evidence/gvdg-events-live-order-scoring/`
