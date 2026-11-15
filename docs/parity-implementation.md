# GVDG implementation milestones

User authorization: build the complete UDisc Pro roadmap, including smartwatch integration, using Sol 6.1 implementation agents. Codex owns coordination, integration, review, and GitHub deployment. Grok is no longer assigned smartwatch work.

Baseline: `e9a9cc7`, including the existing wrist layout, course traffic, and notification rangefinder. Preserve those changes. A browser wrist layout is not evidence of native smartwatch parity.

## Work isolation

The shared checkout stays untouched. Each implementation lane has its own branch and worktree. Only the integration lane edits the worker router, service-worker version, generated bundles, shared deployment configuration, and this status file. No agent pushes or deploys independently. Integration fetches current main and checks the live version and active workflow before each deployment.

| Lane | Branch | Ownership | Migration reservation |
| --- | --- | --- | --- |
| Integration | `codex/parity-platform` | Routing, cross-lane review, builds, CI, deployment | Allocates numbers |
| Round recovery | `codex/round-recovery` | Scorer controller/view, lie identity, durable queues, video drafts, live DO and clip persistence | 0046 |
| Stats and exports | `codex/stats-parity` | Metric definitions, member stats controls, history and own-data export | Request if needed |
| Watches | `codex/watch-parity` | Pairing, scoped watch routes, native clients, wrist/range feature review | 0047 |
| Course quality | `codex/course-quality` | Coverage, freshness, course selection, favorites and offline packs | 0048 |
| Navigation | `codex/app-navigation` | Approved member/admin structure, tool search, contextual navigation and onboarding | None |
| Explicit shots | `codex/explicit-shots` | Private editable shot records and exact-result archives | 0049 |
| Ratings | `codex/rating-reliability` | Chronological layout baselines, retry and source consistency | 0050 |
| Practice | `codex/practice-equipment` | Personal physical bag, putting and measured throws | 0051 |
| Operators | `codex/course-operator` | Course health, maintenance tasks and participation reports | 0052 |
| Offline rounds | `codex/offline-rounds` | New local rounds, completion, owner-safe import and media recovery | 0053 |
| Community | `codex/community-discovery` | Opt-in profiles, friends, progress, reviews and maintained discovery metadata | 0054 |
| Spectators | `codex/spectator-privacy` | Sharing, reconnect recovery and durable video associations | 0055 |
| Native phones | `codex/native-phone` | Private background activity and lock-screen tools | 0056 |
| Archive restore | `codex/archive-roundtrip` | Provenance-preserving personal archive export/reimport | 0057 |
| Visual polish | `codex/member-visual-polish` | Member Home, compact onboarding and cohesive theme-aware UI | None |

Shared scoring and watch commands retain normal actor authorization, validation, card locks, and consensus. Atomic retry/ordering semantics are coordinated between the recovery and watch lanes. Symlinked dependencies are read-only; install new dependencies into separate package directories.

## Delivery ledger

An implementation is not marked verified merely because code exists. Native signing, store publication, physical-device tests, and real course verification require their own evidence.

| Milestone | Required result | Status |
| --- | --- | --- |
| Recoverable rounds | Correct identity isolation; durable scores, marked lies and video; retry visibility; safe finalization | Integrated; combined tests and browser scoring flow passed |
| Analytics and data ownership | C1X, honest coverage, time/course/layout trends, golden fixtures, own-data exports | Integrated; combined unit and Worker checks passed |
| Native watches | Scoped pairing and revocation; safe phone/watch sync; executable clients and platform build checks | Integrated; Wear OS, watchOS Simulator and generic Garmin CI passed; physical/store checks remain |
| Course quality | Complete versus partial mapping; provenance, freshness, revision-safe data, usable discovery | Integrated; favorites routes wired; 484 frontend/776 Worker checks passed |
| Navigation | Approved proposal in navigation-proposal.md; every old destination/action retained | Integrated; desktop/phone navigation and compatibility tests passed |
| Offline course use | Explicit downloadable course packs and local round lifecycle with reconciliation | Packs deployed; fresh offline rounds integrated with migration 0053; real service-worker offline start, score, reload and finish passed |
| Explicit shot records | Outcomes, penalties, make/miss, accuracy and editable classifications | Live in PR93; private archive/recovery tests passed |
| Ratings | Missing-result repair, stable baselines and transparent provisional status | Live in PR93; whole-field/calibration race rejection verified; predictive accuracy remains unknown |
| Personal practice and equipment | Physical disc inventory, putting sessions and measured-throw history | Live in PR93; owner isolation, offline drafts and mobile workflows passed |
| Social and discovery | Favorites, appropriate public profiles, progress milestones and sharing controls | Integrated for expansion release with migration 0054; privacy and discovery tests passed |
| Course operators | Course health, maintenance tasks and honest participation reporting | Integrated for expansion release with migration 0052; admin visual review underway |
| Complete data ownership | Personal export/reimport with original provenance and media manifests | Export implemented; archive reimport remains queued |
| Native phone convenience | Background activity and supported lock-screen tools with explicit permission | Native source integrated with migration 0056; Android APK/lint/unit and iPhone Simulator/ActivityKit tests passed; phone UI integration underway; physical/store verification remains |
| Spectator and video quality | Reconnect recovery, durable history, accessible controls and clear sharing scope | Integrated for expansion release with migration 0055; read-only watch links, revocation, private clip sharing, socket recovery and actual video playback passed |
| Accessibility and performance | Large text, keyboard/screen-reader paths, outdoor readability, slow-network behavior | Continuous verification |
| Field evidence | Real phone/watch rounds, battery, interruptions, and course-data verification | Pending device/data access |

## Release gates

First release: [PR #92](https://github.com/kgbrah/gvdg-club-site/pull/92), commit `9929342`, cache `gvdg-club-v247`. [GitHub deployment 43663733864](https://github.com/kgbrah/gvdg-club-site/actions/runs/43663733864) applied migrations 0046–0048 and deployed Pages, Worker and alert keys. Both post-deployment live-scoring and member-dashboard checks actually ran and passed. Second release: [PR #93](https://github.com/kgbrah/gvdg-club-site/pull/93), commit `6a97728`, cache `gvdg-club-v248`. [Deployment 43666724474](https://github.com/kgbrah/gvdg-club-site/actions/runs/43666724474) applied migrations 0049–0051, deployed Worker and Pages, uploaded alert keys, and ran both post-deploy checks successfully.

The revised Home/Practice direction was explicitly approved for the entire app and released in [PR #95](https://github.com/kgbrah/gvdg-club-site/pull/95), commit `6aeea38`, cache `gvdg-club-v249`. [Deployment 43669165687](https://github.com/kgbrah/gvdg-club-site/actions/runs/43669165687) and both post-deploy checks passed. Current priority: apply that approved direction to every member, admin, scoring and public surface while preserving all functions. The scorecard receives deeper rapid-input, offline/reconnect and finalization verification. See `app-polish-coverage.md` for the route and state inventory. Archive work is preserved and resumes after its builder completes admin polish.

- Unit and integration tests exercise actual failure modes: HTTP 5xx, network failure, reload, actor/round switching, expired authorization, duplicate and stale writes, storage failure, and upload acknowledgement loss.
- Golden statistic fixtures preserve numerators/denominators and label unknown or inferred data.
- Every export is authorized to its owner and avoids spreadsheet formula execution.
- Native clients have compile/build evidence where toolchains are available; unsupported or untested platforms remain explicitly identified.
- Browser verification covers new user flows on desktop and phone widths, with screenshots before publication.
- Production-style GitHub checks, worker migrations, site and worker deployment, and post-deployment scoring/dashboard tests must actually execute and pass.
- Worldwide course coverage and comparative battery/reliability claims require measured evidence; do not manufacture those claims from software completion.
