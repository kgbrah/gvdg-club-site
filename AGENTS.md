# Agent coordination — gvdg-club-site

Multiple agents/sessions (Claude Code, Codex, humans) work in this repo **at the same time**. This file
is the shared contract that keeps them from stepping on each other. Read it before you deploy, branch, or
run anything that touches the shared dev environment.

---

## The shared resource

**gvdgclub.com is a single, shared dev environment**, made of two pieces that are deployed together:

| Piece | Cloudflare target | Deploy command (do NOT run by hand) |
|-------|-------------------|--------------------------------------|
| Static site | Pages project `gvdg-club-site`, branch `main` → **gvdgclub.com** | `wrangler pages deploy … --project-name gvdg-club-site --branch main` |
| API worker | `gvdg-member-auth-staging`, `--env gvdgclub` → **auth.gvdgclub.com** | `wrangler deploy --env gvdgclub` |

The Cloudflare account owner and account ID are intentionally not committed. Set `CLOUDFLARE_ACCOUNT_ID`
locally or as a GitHub secret before any Pages deploy/list command. D1 `gvdg-staging` is shared too.
Production (greenvillediscgolf.com) is separate (GitHub Pages) and is **not** touched by these commands.

## Why this file exists (the failure it prevents)

Every `wrangler … deploy` to gvdgclub is **last-write-wins with no safety check**. On 2026-07-03 two
sessions were deploying divergent branches to gvdgclub; one deployed a commit **19 commits behind `main`**
over the other's deploy, silently reverting the site to a state that predated the weather feature. Both
sessions thought their work was live; neither was. Nothing warned them.

## The rules

1. **Never `wrangler pages deploy` or `wrangler deploy` by hand.** The normal path is the GitHub Action
   **Deploy to staging (gvdgclub.com)** on `main`: it runs the tests, applies D1 migrations *before* the
   Worker deploy, deploys the Worker and Pages, uploads the GitHub-held keys (Gemini, VAPID, Groq), and
   runs the post-deploy checks. The local alternative is **`./scripts/gvdg-deploy.sh`** (machine-wide lock,
   freshness gate, version marker, Pages + worker together).
   ```bash
   gh workflow run deploy-staging.yml -R kgbrah/gvdg-club-site --ref main   # the normal release
   CLOUDFLARE_ACCOUNT_ID=<private-account-id> GVDG_AGENT=<your-name> ./scripts/gvdg-deploy.sh
   ./scripts/gvdg-deploy.sh --status                          # what's live vs your HEAD (read-only)
   ./scripts/gvdg-deploy.sh --dry-run                         # run all gates, deploy nothing
   ```

2. **Deploy only a clean, committed HEAD.** The guard refuses a dirty tree, so "what's live" is always a
   real commit that everyone can name and reason about.

3. **You may only move the dev env FORWARD.** The guard reads the currently-live commit (from
   `gvdgclub.com/version.json`) and **aborts unless your HEAD contains it** (`git merge-base --is-ancestor`).
   If it aborts, you were about to overwrite work that isn't in your branch — **stop and reconcile**, do
   not `GVDG_FORCE=1` past it without confirming with the human.

4. **`main` is the single integration branch, and the only line that should be live on gvdgclub.**
   Feature branches are fine, but before you deploy, merge/rebase `origin/main` into your branch so your
   HEAD is a strict superset of what's live. **Do not deploy a long-lived fork that has diverged from
   `main`** — reconcile the fork into `main` first. (As of 2026-07-03, `main` and `GVDG-udisc-export` had
   BOTH forked with unique commits; that divergence is exactly what caused the clobber.)

5. **The club owner ships.** A release goes live only after the owner says "ship it" for *that* release.
   Prepare everything first (branch, tests, browser QA, PR), then wait. Approval for one release does not
   carry over to the next.

6. **Merge on proof, not on silence.** Before merging a PR, confirm every check finished and passed (count
   of checks == count with conclusion `SUCCESS`, and more than zero), then merge pinned to that head:
   ```bash
   gh pr view <N> -R kgbrah/gvdg-club-site --json headRefOid,statusCheckRollup
   gh pr merge <N> -R kgbrah/gvdg-club-site --merge --match-head-commit <sha>
   ```

7. **Announce yourself.** Export `GVDG_AGENT=<short-name>` so the lock, `version.json`, and `.deploy-log`
   record who deployed. If you start long shared-repo work, say so (commit message, PR, or a note the
   human can relay to other sessions).

## How to check what's live (anyone, anytime)

```bash
curl -s https://gvdgclub.com/version.json           # {commit, branch, deployedAt, deployer}
./scripts/gvdg-deploy.sh --status                   # compares that to your HEAD
CLOUDFLARE_ACCOUNT_ID=<private-account-id> wrangler pages deployment list --project-name gvdg-club-site
```

## After a deploy: the live QA drive

Every successful "Deploy to staging (gvdgclub.com)" run triggers **Live QA drive** (`.github/workflows/live-qa-drive.yml`).
It signs in as the QA admin (GitHub secrets only) and visits every member and admin destination on the live
site at 390 dark/light, 320 dark + large text and 1280 light, failing on console/page errors, failed requests,
horizontal overflow or clipped labels. It only navigates. Check it before calling a release done:

```bash
gh run list -R kgbrah/gvdg-club-site --workflow "Live QA drive (read-only, gvdgclub.com)" --limit 1
gh run download <run-id> -R kgbrah/gvdg-club-site -n live-drive    # summary.json + screenshots
gh workflow run live-qa-drive.yml -R kgbrah/gvdg-club-site --ref main -f only="admin:courses"   # on demand
```

## Platform limits (decided by the owner; design within them)

- **Cloudflare Workers Free plan.** Every invocation, cron included, gets about **10 ms of CPU**; going over
  kills the whole invocation (uncatchable), including other `waitUntil` work and later cron steps. Never
  decode, resize or re-encode images in the Worker, and avoid big crypto or parsing loops. Resize photos in
  the browser; the Worker only validates, strips metadata at the byte level, stores, and calls AI services
  (network wait is not CPU). Run anything slow or AI-bound **last** in `scheduled()`.
- **Free AI tiers.** Gemini (Lost & Found photo reads and compares, tee-sign OCR) and Groq (Whisper voice
  entry) are free tiers with tight quotas; OpenRouter is the fallback. Keep the daily budgets
  (`LF_DAILY_VISION_BUDGET`, `LF_VISION_PER_MINUTE`, `VOICE_DAILY_BUDGET`) and treat a 429 as "try later".
  Only call the AI when there's something to decide (for example, the marketplace check reads a listing
  photo only when an open lost post of the same mold exists).
- **KV writes are limited on Free** (about 1,000 a day). Prefer D1 for anything written often.

## Conventions that bite if missed

- **Next migration number is `0073`** (`0063` marketplace, `0064` Lost & Found, `0065` Lost & Found weight
  and hole, `0066` My Bag photos and the bag / marketplace cross-checks, `0067` whole-bag and accessory photos,
  `0068` bags and accessories in the marketplace + "Sell this" links, `0069` members' PDGA registrations, `0070` club donations
  from marketplace sales, `0071` the round karma watch: flags and admin karma adjustments, `0072` guest promo spots).
- **A new place that shows a player's name gets their karma chip** (`KarmaChip` from `src/shared/karma.js`, by
  `memberId`, `pdga`, a payload's `karmaKey`, or a marketplace `traderKey`). Name-only payloads add
  `karmaKey: karmaKey(memberId)` (`auth-worker/src/karma-directory.ts`); never send the member id itself.
- **pdga.com:** player pages are behind a Cloudflare challenge (403 to servers); the member JSON API, the event search and
  event pages are not. Keep pdga.com reads bounded per tick (the Free plan allows 50 outside requests a run) and parse with
  plain regular expressions, never a DOM.
- **Changing a CHECK constraint means rebuilding the table.** Do it the way `0068` does: `PRAGMA defer_foreign_keys = on`,
  create the new table, copy every row with its id, drop the old, rename, recreate the indexes, `PRAGMA defer_foreign_keys = off`,
  and replay it on a seeded database inside a transaction with foreign keys on (`auth-worker/test/market-gear-migration.test.ts`).
- **Bump cache versions** when a precached file changes: `sw.js` `CACHE` (now `gvdg-club-v350`), plus the
  `?v=` on the bundle you changed (members `219`, public/events `207`, score `245`, home `195`) and the
  tests that pin them.
- **Generated bundles conflict on merge.** Delete the generated outputs, `npm run build`, then `git add -A`.
- **Private stays private.** Lost & Found writing ("what's written on it"), AI reads, My Bag photos and
  writing, and match reasons never go in a public payload; the Worker tests assert this. Keep it so.
- **Drive it before calling it done.** Unit tests are not enough for anything user-facing: run the browser
  QA for the area (`scripts/qa/*-browser-qa.mjs`; Lost & Found, marketplace and My Bag run against the real
  Worker in-process) and look at the screenshots.

## Branch hygiene

- One integration branch: **`main`**. Rebase feature branches onto it; open PRs; merge back promptly.
- Don't let a branch live long enough to diverge in both directions from `main`. If two branches have each
  gained unique commits, **merge them into `main` and reconcile there** before anything is deployed — never
  resolve the divergence by deploying one over the other.
- Migrations (`auth-worker/migrations/NNNN_*.sql`) are append-only and globally ordered. Coordinate the
  next number; two branches must not both claim the same `NNNN`.

## The lock

Machine-wide at `${TMPDIR:-/tmp}/gvdg-deploy.lock`, auto-reclaimed after 15 min if stale. One deploy at a
time. If the guard says a deploy is in progress, wait — don't work around it.

## The watchdog (backstop)

A systemd `--user` timer (`scripts/gvdg-deploy-watchdog.sh`) polls `gvdgclub.com/version.json` every ~3
min. If it ever sees a live commit that **`origin/main` is not an ancestor of** (a clobber — a deploy
missing main's work), it **re-asserts `origin/main`** from an isolated `git archive` export (never touches
any working tree). This is a safety net, not a license to deploy raw — a clobbered deploy still flaps the
site until the next poll. **Push `main` before deploying it** so the watchdog sees newer main and doesn't
mistake it for a clobber. Manage: `scripts/gvdg-deploy-watchdog.sh --status | --install | --uninstall`;
log at `~/.local/state/gvdg-watchdog.log`.
