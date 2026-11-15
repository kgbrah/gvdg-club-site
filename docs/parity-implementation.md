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

Shared scoring and watch commands retain normal actor authorization, validation, card locks, and consensus. Atomic retry/ordering semantics are coordinated between the recovery and watch lanes. Symlinked dependencies are read-only; install new dependencies into separate package directories.

## Delivery ledger

An implementation is not marked verified merely because code exists. Native signing, store publication, physical-device tests, and real course verification require their own evidence.

| Milestone | Required result | Status |
| --- | --- | --- |
| Recoverable rounds | Correct identity isolation; durable scores, marked lies and video; retry visibility; safe finalization | In implementation |
| Analytics and data ownership | C1X, honest coverage, time/course/layout trends, golden fixtures, own-data exports | Integrated; combined verification pending |
| Native watches | Scoped pairing and revocation; safe phone/watch sync; executable clients and platform build checks | In implementation |
| Course quality | Complete versus partial mapping; provenance, freshness, revision-safe data, usable discovery | In implementation |
| Navigation | Approved proposal in navigation-proposal.md; every old destination/action retained | Assigned next |
| Offline course use | Explicit downloadable course packs and local round lifecycle with reconciliation | Queued |
| Explicit shot records | Outcomes, penalties, make/miss, accuracy and editable classifications | Queued after recovery |
| Ratings | Missing-result repair, stable baselines and transparent provisional status | Queued |
| Personal practice and equipment | Physical disc inventory, putting sessions and measured-throw history | Queued |
| Social and discovery | Favorites, appropriate public profiles, progress milestones and sharing controls | Queued |
| Spectator and video quality | Reconnect recovery, durable history, accessible controls and clear sharing scope | Queued after recovery |
| Accessibility and performance | Large text, keyboard/screen-reader paths, outdoor readability, slow-network behavior | Continuous verification |
| Field evidence | Real phone/watch rounds, battery, interruptions, and course-data verification | Pending device/data access |

## Release gates

- Unit and integration tests exercise actual failure modes: HTTP 5xx, network failure, reload, actor/round switching, expired authorization, duplicate and stale writes, storage failure, and upload acknowledgement loss.
- Golden statistic fixtures preserve numerators/denominators and label unknown or inferred data.
- Every export is authorized to its owner and avoids spreadsheet formula execution.
- Native clients have compile/build evidence where toolchains are available; unsupported or untested platforms remain explicitly identified.
- Browser verification covers new user flows on desktop and phone widths, with screenshots before publication.
- Production-style GitHub checks, worker migrations, site and worker deployment, and post-deployment scoring/dashboard tests must actually execute and pass.
- Worldwide course coverage and comparative battery/reliability claims require measured evidence; do not manufacture those claims from software completion.
