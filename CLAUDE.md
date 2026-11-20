# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Multi-agent repo. Read [AGENTS.md](AGENTS.md) before you deploy, branch, or run anything that
> touches the shared dev environment — it is the mandatory coordination protocol.** This file is the
> architecture map; AGENTS.md is the deploy contract.

## Deploy safety (the one rule that overrides everything)

`gvdgclub.com` is a **single shared dev environment** that many agent sessions deploy to. Every
`wrangler … deploy` is last-write-wins with no safety check — on 2026-07-03 one session clobbered
another by deploying a commit 19 behind `main`, silently reverting the site.

- **Never `wrangler pages deploy` / `wrangler deploy` by hand.** Release through the GitHub Action
  **Deploy to staging (gvdgclub.com)** on `main` (`gh workflow run deploy-staging.yml -R kgbrah/gvdg-club-site --ref main`;
  migrations, Worker, Pages, keys, post-deploy checks), or locally through `./scripts/gvdg-deploy.sh`
  (machine-wide lock + freshness gate + `version.json` marker).
- **The club owner ships.** Nothing goes live without the owner's explicit "ship it" for *that* release, and
  a PR merges only when every check has passed (count == `SUCCESS` count, > 0), pinned with
  `--match-head-commit`. See [AGENTS.md](AGENTS.md).
- **Forward-only:** the gate aborts unless your clean, committed `HEAD` *contains* the currently-live
  commit (`gvdgclub.com/version.json`). If it aborts, **reconcile with `origin/main`** — don't
  `GVDG_FORCE=1` past it without human sign-off.
- **`main` is the single integration branch** and the only line that should be live on gvdgclub. Merge
  diverged forks *into* main; never resolve divergence by deploying one branch over another.
- Check what's live: `./scripts/gvdg-deploy.sh --status` or `curl -s https://gvdgclub.com/version.json`.

Production `www.greenvillediscgolf.com` (GitHub Pages, pinned by the `CNAME` file) is **separate** and is
**not** touched by any dev-deploy command.

## What this is

The website for the **Greenville Disc Golf Club**. Two halves in one repo, deployed together:

1. **A static frontend** — root HTML shells plus page-owned helper files, with generated Vite/React route
   bundles for the home, public/events, admin, members, live-scoring, and tee-sign preview surfaces.
2. **A Cloudflare Worker** in `auth-worker/` (TypeScript, ~200 modules). The **only** server-side code:
   member auth, the club-operations API, live scoring, pro-shop, the used-disc marketplace, Lost & Found,
   My Bag extras, voice entry, ratings, and the "Crotts" AI assistant. The static pages reach all dynamic
   data through it over HTTPS.

**Hosting is the Cloudflare Workers _Free_ plan, by the owner's choice:** about **10 ms of CPU** per
invocation (cron included); going over kills the invocation. Images are never decoded or re-encoded in the
Worker (the browser resizes; the Worker validates, strips metadata at the byte level, stores, and calls AI
services). AI keys are free tiers too (Gemini, Groq). See "Runtime gotchas".

There is **no traditional backend or database server to boot** for the site itself — pages are static.

### Two environments (and the naming trap)

| | Static site | Worker (API) | Line |
|---|---|---|---|
| **Production** | `www.greenvillediscgolf.com` (GitHub Pages) | `auth.greenvillediscgolf.com` | separate, hands-off |
| **Shared dev** | `gvdgclub.com` — CF Pages project `gvdg-club-site`, branch `main` | `auth.gvdgclub.com` | what we deploy |

- ⚠️ The Worker named **`gvdg-member-auth-staging` IS the live dev Worker** — `auth.gvdgclub.com` is
  attached to it. `[env.staging]` and `[env.gvdgclub]` in `wrangler.toml` are **identical aliases to the
  same Worker**, sharing one D1 (`gvdg-staging`), KV, and R2. "Staging" and "gvdgclub" read the **same
  data**; there is no separate staging DB.
- The base `[name] = gvdg-member-auth` block is a **dead placeholder** (its Worker owned no domain and was
  deleted). A bare `wrangler deploy` (no `--env`) ships **nothing live** — always use `--env gvdgclub`.
- Cloudflare account owner/id are private operational details. Set `CLOUDFLARE_ACCOUNT_ID` locally or as a
  GitHub secret before Pages deploy/list commands.

## Commands

### Worker (`auth-worker/` — run from inside that directory)

```bash
cd auth-worker
npm test                              # vitest run — full unit/integration suite (static only)
npx vitest run test/live.test.ts      # one test file
npx vitest run -t "lockout"           # tests matching a name
npm run typecheck                     # tsc --noEmit
npm run typegen:check                 # wrangler types --check (CI gate; regen with `npm run typegen`)
npm run audit                         # npm audit --audit-level=moderate
npm run dev                           # wrangler dev (local Worker)
npm run migrate:staging               # wrangler d1 migrations apply DB --env staging --remote
npm run deploy:staging:dry-run        # validate config + wrangler deploy --dry-run
node scripts/provision.mjs --roster roster.json --out-dir ./out   # seed members (see PBKDF2 gotcha!)
```

### Static frontend tests (repo root — pure-helper tests, no DOM)

```bash
npm run build            # builds all generated Vite route bundles
npm test                 # node --test tests/*.test.mjs (events/ryder-cup/feed/safe-url/pwa/… parsers)
npm run qa:react         # react-doctor project scan; generated app bundles are ignored
npm run qa:site-smoke    # Playwright browser smoke for migrated route bundles
npm run qa:live-scoring  # Playwright live-scoring browser QA
npm run qa:staging-live-scoring  # live gvdgclub.com scoring E2E; needs private QA credentials
```

### Deploy (the ONLY sanctioned paths — see AGENTS.md)

```bash
gh workflow run deploy-staging.yml -R kgbrah/gvdg-club-site --ref main   # the normal release (owner-approved)
curl -s https://gvdgclub.com/version.json                                 # what's live
GVDG_AGENT=<name> ./scripts/gvdg-deploy.sh          # Pages + worker (also --pages-only / --worker-only)
./scripts/gvdg-deploy.sh --status                   # what's live vs your HEAD (read-only)
./scripts/gvdg-deploy.sh --dry-run                  # run every gate, deploy nothing
scripts/gvdg-deploy-watchdog.sh --status|--install  # systemd --user backstop that re-asserts origin/main
```

`gvdg-deploy.sh` runs `npm run qa:staging-live-scoring` after deploy when `GVDG_STAGING_QA_TOKEN` is set, or
when `GVDG_STAGING_QA_IDENTIFIER` + `GVDG_STAGING_QA_PIN` are set. The QA member must be an admin so the test
can cancel its temporary casual round. `GVDG_SKIP_STAGING_QA=1` skips only that post-deploy smoke.

Every successful deploy triggers the read-only **Live QA drive** (`.github/workflows/live-qa-drive.yml`), which
visits every member and admin screen on the live site at four sizes; check its `summary.json` (0 findings)
before calling a release done.

`.github/workflows/deploy-worker.yml` (push to `main` touching `auth-worker/**`) only **tests** — its
deploy step is skipped while the top-level config holds `REPLACE_WITH_*` placeholders. The actual gvdgclub
deploy is `deploy-staging.yml` (manual `workflow_dispatch`) or `gvdg-deploy.sh`. **A push to main does not
auto-deploy.**

## Architecture

### Request flow

```
Browser (static page)
  │  resolves the API base through src/shared/api-base.js:
  │  explicit data-api-base/data-auth-base attr wins; else by host —
  │  localhost→:8788,  greenvillediscgolf.com→auth.greenvillediscgolf.com,  gvdgclub.com→gvdgclub.com/api
  │  (same-origin: a Cloudflare Worker route gvdgclub.com/api/* → this Worker, prefix stripped in index.ts
  │  withoutApiPrefix),  ELSE→auth.gvdgclub.com
  │  (deployed HTML ships data-*-base="" so the host fallback is what actually selects the Worker)
  ▼
Cloudflare Worker  auth-worker/src/index.ts   (default export { fetch, scheduled })
  ├─ KV  ROSTER      members (member:<id> = source of truth incl. pinHash) + idx:pdga/idx:udisc + wa:creds
  ├─ D1  kv_store ns "ratelimit" (RATELIMIT_BACKEND = "d1"): login lockout + generic counters + one-time WebAuthn
  │                  challenges (wa:chal:*) + emailed codes; the KV RATELIMIT binding stays for "kv" (the way back)
  ├─ D1  DB          club data: events, courses/layouts, registration, results, board, pro-shop/wallet,
  │                  ratings, casual rounds, messages, practice + My Bag, marketplace, Lost & Found
  │                  (gvdg-staging; all queries parameterized)
  ├─ DO  LIVE        LiveEventDO — live scorecard state + WebSocket; writes to D1 only on finalize
  ├─ R2  PHOTOS      tee-sign images, marketplace listing photos, Lost & Found photos, private bag photos
  │                  (gvdg-photos-staging)
  └─ AI  + OpenRouter/Gemini/Groq  Crotts assistant, tee-sign OCR, Lost & Found reads + photo compares,
                                   Whisper voice entry
  scheduled()  (never on the fetch path)
    "17 8 * * *"    → daily ratings recompute + the Dec 1 membership reminder
    "*/15 * * * *"  → marketplace withdrawal sweep, UDisc layout import, then the Lost & Found tick LAST
                      (expiry, photo purge, due AI reads, matching incl. bags, bag-photo cleanup)
    "7 * * * *"     → hourly PDGA events (+ layout baselines, + members' PDGA registrations in NC / VA / SC:
                      pdga-registrations.ts reads one state's event search and up to 16 event pages a run, events
                      within two weeks every hour, and matches registered PDGA numbers against the roster's
                      idx:pdga:<n> keys -> pdga_watch_events / pdga_registrations, 0069; GET /pdga-registrations);
                      the Sunday UDisc league refresh rides it
```

### The split router (`src/index.ts` + `club-api.ts`)

Two-tier, no framework. `index.ts` `fetch()` runs a fixed pipeline — `withKvFallback` → resolve `origin`
→ CORS/OPTIONS → **fail-closed secret gate** → top-level `if`-chain (member/auth/webauthn/tee-sign/pdga)
→ `POST /voice/disc` → `handleBag` (`/me/bag/*`) → `handleMarket` (`/market/*`, `/admin/market/*`) →
`handleLostFound` (`/lost-found/*`, `/admin/lost-found/*`) → `clubApi()` → 404, all wrapped in a `try/catch` that returns a **CORS-bearing** 413/500 (so the browser
sees the real error, not a CORS failure). `clubApi()` tries domain handlers in **fixed order, first
non-null Response wins**: `handleClubPublic → handleClubLive → handleCasualRoundRequests →
handleCasualRounds → handleClubShop → handleClubRegistration → handleClubAdmin`. Each self-guards on the
path `seg[]` shape and returns `null` to pass. **Dispatch is order-sensitive** — a new `/events/:id/…`
route can be shadowed by an earlier handler.

Three gate helpers in **`authz.ts`** (all authz is re-checked server-side):
- `requireAuth` — verify the Bearer JWT; **returns null if `mustChangePin`** (forced-change users are
  locked out of every gated route *except* `/me` and `/set-pin`, which call `verifySession` directly).
- `requireMember` — `requireAuth` → `{sub}` or 401.
- `adminGate` — `requireAuth` **plus** re-read the roster and require `member.isAdmin===true` (403).
  `isAdmin` is **never** trusted from the JWT; it comes from ROSTER KV on every request.

Route groups: **Public** (no auth): `POST /login`, `POST /assistant`, `POST /webauthn/auth/*`, `GET
/pdga-stats`, and public reads (`/events`, `/courses`, `/leagues`, results, live/round snapshots + `/ws`).
Several routes are **optional-auth** (guests via a `g_<token>`, members via JWT) — registration, shop,
`/courses/:id/tee-signs`. **Member-authed**: `/me`, `/set-pin`, `/profile`, `/my-*`, `/board*`, passkey
register, live score/card writes. **Admin-gated**: all `/admin/*` + event live-scoring lifecycle
(`start`/`finalize`).

### Worker domain map (`auth-worker/src/`)

| Domain | Key modules | Notes |
|---|---|---|
| Auth / authz | `index.ts`, `authz.ts`, `crypto.ts`, `jwt.ts`, `roster.ts`, `webauthn*.ts`, `ratelimit.ts`, `kv-rate-limit.ts` | PIN = PBKDF2-HMAC-SHA256 **100k** iters; JWT = HS256 via `jose`; passwordless passkeys via `@simplewebauthn/server` |
| HTTP core | `http.ts`, `input.ts`, `env.ts` | exact-match CORS, capped `readJson`, all request validation in `input.ts` |
| Club data (D1) | `db.ts` (barrel) → `db-events/-courses/-leagues/-registration/-results/-content/-export/-tee-signs/-event-awards`, `db-types.ts`, `d1kv.ts` | all SQL parameterized; `d1kv.ts` = D1-backed KV fallback |
| Admin surface | `club-admin-routes.ts` → `club-admin-{events,courses,layouts,members,imports,content,shop,tee-signs,export}.ts` | every handler behind `adminGate` |
| Registration | `club-registration-routes.ts`, `event-deadlines.ts`, `payments.ts` | guest + member; PayPal reserve-before-charge |
| Live scoring | `live.ts` (the DO) + `live-{state,scoring,snapshot,finalize,format,pairs,consensus,target-consensus,types}.ts`, `scoring.ts`, `matchplay-scoring.ts`, `score-breakdown.ts` | consensus model — see below |
| Courses / imports | `layouts.ts`, `distance.ts`, `assign.ts`, `imports.ts` + `imports/{fetch,csv,events,udisc}.ts`, `tee-sign-routes.ts` | SSRF-guarded imports; tee-signs → R2 |
| Pro-shop / wallet | `shop-db.ts`, `club-shop-routes.ts`, `club-admin-shop.ts`, `order-notify.ts`, `wallet-idempotency.ts` | wallet = append-only ledger |
| Used-disc marketplace | `market-routes.ts` → `market-{listings,deals,wanted,guest,admin,store,input,photos,notify,crypto,sweep,http}.ts` | `/market/*` + `/admin/market/*`; tables from `0063` |
| Lost & Found | `lf-routes.ts` → `lf-{posts,photos,claims,social,admin,store,input,process,vision,match,notify}.ts` | `/lost-found/*` + `/admin/lost-found/*`; tables from `0064` (+`0065` weight/hole); photos public as uploaded; `lf-process.ts` also runs the bag matcher (`matchBags`) |
| My Bag extras | `bag-routes.ts` (disc / whole-bag / accessory photos, accessories, switch, lost links); bag discs themselves are practice records (`practice-{input,store,routes}.ts`) | `/me/bag/*`, member only; tables from `0066`-`0067` (`bag_photos.subject` = disc / bag / accessory); photos owner-only |
| Listing ↔ lost check | `market-lost-check.ts` | runs on list / edit / relist and on a new lost post; strong only → seller (`deliverLfNote`) + admins (`notifyAdmins`, review list in `market-admin.ts`) |
| Voice entry | `voice-disc-route.ts` | `POST /voice/disc`: Whisper on Groq (free) → OpenRouter backup; transcript only, audio never stored. Clients (`src/shared/voice-clip.js`: My Bag "Add by voice", "Say it") record until Stop, up to 30 s, never on a pause; admin voice fill (`/admin/voice-fill`, Workers AI Whisper) up to 45 s |
| Ratings | `ratings.ts` (display), `rating-engine.ts` + `rating-store.ts` + `ratings-recompute*.ts` (PDGA SSA), `pdga.ts` | **two** distinct systems |
| Integrations | `assistant.ts`+`assistant-route.ts`, `vision.ts`, `photos.ts`, `weather.ts`, `feeds.ts`, `register-notify.ts` | AI, OCR, weather, email, Google-Sheet feeds |

### Live scoring & the consensus model (`live.ts`)

One Durable Object class `LiveEventDO` serves both **event** live-scoring (`idFromName("event:"+id)`) and
**casual rounds** (`idFromName("round:"+CODE)`). State (`meta` + `players`) lives **in DO storage, not
D1**, until finalize; `meta.rev` bumps once per mutation and drives client re-render; `/ws` is a
hibernatable WebSocket that broadcasts a snapshot on every change. On finalize (`live-finalize.ts`),
standings are written to D1 (`results` for events, `casual_rounds`/`casual_results` for casual) and
`meta.status` rolls back to `live` if any persist throws.

- **Consensus:** every hole score is a *map of votes* keyed by scorer. The official `scores[hole]` is
  **derived** — set only when active scorers agree; disagreement blanks the hole and blocks finalize.
  Departed scorers' stale votes self-heal (only currently-carded scorers count). **Never write
  `scores[hole]` directly** — go through `recordScoreTargetVote`. Doubles share one vote across the pair.
- **DO auth:** the DO trusts **only** the Worker-injected `X-Auth-Member` / `X-Auth-Admin` headers, never
  the request body. A member may only score their **own card** (`cardId` is the authz boundary); admins
  score anyone. Event `start`/`finalize` are admin-gated at the Worker; casual finalize is any cardmate,
  force-past-conflict is admin-only.
- **Removal tombstones, never splices** — the array index *is* the scorer/target key, so splicing would
  silently re-point later scores.
- **Google Sheets import + held accounts + tiers:** `sheet-import.ts` (`POST /admin/sheet-import/plan|apply`, kinds
  `people` / `balances` / `dues` / `tags`; the browser reads and maps the sheet with `src/shared/sheet-import.js`). The sheets
  are canon. Match order: PDGA #, UDisc, normalized name (`normalizePersonName`; same name with a different PDGA/UDisc is
  someone else). Unmatched rows become **held accounts** (`roster.createHeldMember`: `held: true`, no PIN, no login index,
  deterministic id `m_h_p<pdga>` / `m_h_u<udisc>` / `m_h_n<hash(name)>`), skipped by messaging search, renewal reminders,
  Lost & Found name matching and PDGA/rating scans. `held-accounts.ts` carries a held account onto a new account at
  creation (admin add, application approve) or by `POST /admin/members/link-held` (wallet rows, bag tags, dues, tier).
  Balances apply as one compare-and-set wallet entry (`source='sheet_import'`); tags replace the series in one batch; apply
  takes 25 rows a call (D1/KV per-request limits). **Tiers:** `memberTier()` = admin (`isAdmin`) / guest (`guest: true`) /
  member; `POST /admin/members/set-tier` (last-admin guarded), `POST /admin/members/lapsed-to-guest`. Guests: membership
  view `guest: true` (never lapsed), registration not blocked, and `requireListingSeller` refuses new listings, relists and
  Wanted offers (`guests_cannot_list`; the market viewer carries `canList`).
- **Page weight:** Home's hero slides are AVIF → WebP → JPEG via `image-set()` (index.html), the slide in view is
  preloaded and the others get their picture after `load` (`carousel-slide-later`, hero-about-app.js). Archivo is two
  files whose `unicode-range`s come from the fonts' own character maps (tokens.css): `archivo-latin-2.woff2` (Latin +
  arrows) and `archivo.woff2` only for characters it has — a glyph Archivo lacks (✦ ✓ ★) no longer downloads 185 KB.
  `/courses`, `/courses/:id/layouts|positions` are edge-cached (fresh 60 s; past that served at once and rebuilt in
  `ctx.waitUntil`, so no visitor waits on the bulk D1 read).
- **Satellite maps load from tiles** (`hole-map-model.js` `satelliteTileLayers` / `satelliteTileZoom`, `hole-map.js`
  `SatelliteLayer`): Esri World_Imagery **tiles** first (CDN-cached, parallel, ~0.6 s for a map vs 3–5 s for the on-demand
  `export` render), the export picture only if a tile fails, and a previously saved export as the offline backup. The tile
  zoom depends on the place, not the screen (the sharpest ≤ 19 that fits `SATELLITE_MAX_TILES` = 24), so the scorecard,
  replay and preloads share tiles. `sw.js` serves `gvdg-maps-v2` **cache-first** (refreshed in the background after 30
  days, trimmed past 3000 entries); `satellite-preload.js` warms tiles, the whole round only without Data Saver.
- **PayPal from in-app browsers** (`src/shared/paypal-link.js`, installed by the home, public and members bundles): in
  Facebook / Messenger / Instagram / TikTok's own browser a paypal.me / paypal.com link is handed off (Android: an
  `intent://` link so the PayPal app or the real browser opens it; iOS 17+: `x-safari-https://`, falling back to the plain
  link if nothing happens). Normal browsers are untouched (they already open the PayPal app).
- **Guests verify once** (`guest-link.ts`): every email to a marketplace / Lost & Found guest carries a sign-in link
  (`?gl=` a 14-day `glink` JWT, marked `mkt` + `glink` so it is never a member or guest session). The page exchanges it
  once (`POST /market/guest/link` → a guest session, `consumeGuestLink` in `market-api.js`) and drops it from the address,
  so a link opened in the mail app or on another device doesn't ask for a second code. **Lost a disc from your bag**:
  `lf-form.js` shows a signed-in member "Which disc did you lose?" from `GET /me/practice` + `/me/bag` (bag discs first;
  archived and already-reported discs left out); a pick fills the post like My Bag's "I lost this disc" (`bagDiscId`).
- **Guest accounts** (`guest-accounts.ts`): `POST /membership/apply` with `kind: "guest"` needs a valid email and phone
  (`parsePhone` → `+1…`), PDGA/UDisc optional; approval creates `guest: true` with `email`/`phone` on the record and an
  `idx:email:` login index (`resolveMember` checks `@` first, so an email is never read as a PDGA #; member id
  `m_e_<hash>` when there's no PDGA/UDisc). The first `GUEST_PROMO_LIMIT` (100) approved guests get `guestPromo`
  (atomic `INSERT … WHERE COUNT < 100` into `guest_promo`, `0072`); `hasHistoryAccess()` / `historyGate` answer
  `membership_required` on `/my-results`, `/my-play-history`, `/my-play-export`, `/my-ratings` for other guests, and
  `membership.history` tells the app (members-app `MembershipNeeded`). `GET /membership/guest-spots` → `{ limit, left }`.
- **Live casual rounds (admin):** `GET /admin/rounds/active` (`active-rounds.ts`) lists every casual round still live by
  code: candidates from `live_round_index` plus member-started rounds never saved (`casual_round_sharing` rows with no
  `casual_rounds` row; ghosts can fall out of the index), each confirmed by the DO's Worker-only `GET do/summary` (names,
  holes scored, last activity = `meta.updatedAt`; no ids or scores), capped at 35 DO reads. Admin › Scoring shows them with
  Watch / End round (`POST /rounds/:code/cancel`). Course traffic now *skips* index rows older than 14 h instead of deleting
  them, so a ghost stays findable until it is ended.
- **Casual-round *requests*** (`casual-round-requests.ts`, tables from `0014`) are a separate RSVP/planning
  board and are **not** wired to start a live round — don't assume joining one creates a round.

### Data layer & migrations

All D1 access is **parameterized** (`.bind()` with `?`); the only dynamic SQL is IN-clause placeholder
lists and SET/table fragments built from **hardcoded** column literals — never request data. Raw
`.prepare()` also lives outside `db*.ts` (e.g. `shop-db.ts`, `ratings*.ts`, `wallet-idempotency.ts`) —
keep any new one parameterized.

`auth-worker/migrations/NNNN_*.sql` are **append-only and globally ordered**. Highest is **`0073`; next is
`0074`**. The **`0007` gap is intentional** — never back-fill it. Two branches must not claim the same
number. Domains: core courses/events/results (`0001-0003`), board (`0004`), registration/ctps/ace-pots
(`0005-0006`), tee-signs (`0008`), pro-shop + wallet (`0009`, `0012`, `0017`, `0023`), KV fallback
(`0010`), PDGA cache (`0011`), guest reg (`0013`), casual-round requests/rounds (`0014`, `0016`), UDisc
export (`0015`), live-scoring metadata (`0018`), scale indexes (`0019-0020`), export endpoints (`0021`),
ratings (`0022`), event schedule/deadlines (`0024`), event course/layout assignments (`0025`), course
conditions / event chat / map marks / nearby + NC + 250-mile course catalogs / UDisc imports + history
(`0026-0038`), throw clips + recovery (`0039`, `0046`), round messages (`0040`), event teams (`0041`), bag tags +
requests + league challenges (`0042-0043`, `0059`), admin push (`0044`), live round index (`0045`), watch pairing
(`0047`), course discovery / maintenance / community discovery (`0048`, `0052`, `0054`), private shot ledgers
(`0049`), rating repair (`0050`), member practice + My Bag discs (`0051`), offline rounds (`0053`), spectator
privacy (`0055`), phone activity (`0056`), personal data archive (`0057`), membership dues (`0058`), member push
(`0060`), member messages + notices (`0061`), PDGA layout baselines (`0062`), **used-disc marketplace (`0063`)**,
**Lost & Found (`0064`)**, Lost & Found weight + hole (`0065`), **My Bag photos + bag / listing cross-checks (`0066`)**, whole-bag + accessory photos (`0067`), bags + accessories in the
marketplace and "Sell this" links (`0068`: `market_listings` rebuilt with the same ids under `PRAGMA defer_foreign_keys`; see
`test/market-gear-migration.test.ts` for how to replay a rebuild on seeded data), members' PDGA registrations (`0069`), club donations from marketplace sales (`0070`), the round karma watch (`0071`), guest promo spots (`0072`).

`events.course_id` / `events.layout_id` remain the primary legacy/scoring fields, but multi-course events
must also be represented in `event_courses` (migration `0025`). Admin create/edit payloads may include
`event_courses: [{ course_id, layout_id?, label?, sort_order? }]`; public event models attach those rows
and summarize each course/layout from the structured table. Do not encode multi-course tournaments only in
freeform notes.

### Feature domains

- **Pro-shop / wallet** — the member wallet is an **append-only ledger** (`wallet_transactions`; balance
  is `SUM(amount_cents)`, no balance column). The debit is **atomic + idempotent** in one
  `INSERT…SELECT…WHERE SUM+amount>=0` (`wallet-idempotency.ts`) so concurrent debits can't overdraw.
  Three checkout paths: `paypal.me` redirect (manual reconcile, no stock decrement), PayPal Orders v2
  auto-capture, and store-credit debit; only the latter two decrement stock and email.
- **Used-disc marketplace** (Pro Shop → Marketplace / WANTED / My marketplace; lazy chunk
  `public-app/chunks/market-app-*.js`). Anyone browses; members **and email-verified guests** buy, propose
  trades, post WANTED, leave feedback and report; **only members list** (and must first save a buyer-alert
  email, `seller_email_required`). Guest identity = 6-digit emailed code (hashed, 10 min, single use, rate-
  limited) → an `mkt` JWT that `verifySession` **rejects** everywhere else; guest emails are stored only as an
  HMAC + AES-GCM copy (keys derived from `JWT_SECRET`). Public payloads use opaque `market_traders.trader_key`,
  never member ids or emails. Listing state is compare-and-set: `active → pending` (one buyer; unique partial
  index) `→ sold|traded`, or released/cancelled back to active; `withdrawn` can be **relisted for 24 h**, then
  the */15 cron (`finalizeWithdrawals`) makes it final and deletes the R2 photos. Pay links (paypal.me / cash.app)
  are built server-side from validated handles and shown only to members and verified guests; there is no
  in-app payment. Feedback: once per party per completed deal, 60-day window, one edit in 7 days, one reply.
  Admin moderation actions all require a logged reason. Listings sell a **disc, a bag or an accessory**
  (`item_kind`; `gear_type` = the My Bag accessory kinds; disc type, plastic, weight and flight are disc-only, enforced by
  CHECKs and `parseListing`; browse `?kind=`); the kind is fixed once listed. **Club donations** (`market-donations.ts`, `0070`):
  a listing may pledge `donate_percent` or `donate_cents` (price required; shown as `clubShare`); after a completed *sale* the
  seller sends it to paypal.me/greenvillediscgolf and `POST /market/deals/:id/donation` records it `sent`; an admin marks it
  `confirmed` (karma = whole dollars, fixed then) or `not_received` (reason; the seller can send again). `karmaOf`
  (`lf-store.ts`) adds confirmed donation karma to the Lost & Found ledger's sum; amounts are never in a public payload. Bags and accessories are never checked against
  lost discs. Root QA: `scripts/qa/marketplace-browser-qa.mjs` runs the real Worker in-process.
- **Lost & Found** (`lost-found.html`, lazy chunk `public-app/chunks/lf-app-*.js`; member tab `lost-found`, admin tab
  `lost-found`). Anyone posts found/lost discs; non-members use the **marketplace's guest identity** (`market_guests`, `mkt`
  token; `/lost-found/guest/*` and `/market/guest/*` are the same identity). **Photos are public as uploaded** (magic bytes, size
  cap, EXIF/XMP stripped at the byte level; the Worker never decodes an image) and the forms ask posters to cover names and phone
  numbers. `lf-process.ts` (waitUntil after a post, then the */15 cron with backoff; 429 = try later; daily budget
  `LF_DAILY_VISION_BUDGET`, per-minute `LF_VISION_PER_MINUTE`) asks Gemini once per photo for disc details + ink (`lf-vision.ts`);
  the read feeds details, matching and an **uploader-only nudge** (`lf_photos.nudge`: "may show a name or phone number" with
  Replace photo / Keep it, `lf-photos.ts`; never the text, never anyone else). Privacy invariants: ink text, `lf_posts.private_ink`,
  R2 keys and nudges never appear in another party's payload (`lf-store.ts` builds every shape from an
  allow-list; `test/lost-found.test.ts` greps every public payload). Matching (`lf-match.ts`, pure) scores ink phone/name vs the
  lost post's private text or the member's roster name first, then details, course/nearby, date; a roster member whose full name
  is on a disc is told directly. Claims: `open → returned → confirmed`; karma is an **append-only ledger** (`lf_karma`, triggers
  block UPDATE/DELETE; `UNIQUE(claim_id, reason)` = +10 once per return, one admin reversal). The member inbox summary carries
  `lostFound` (waiting count + recent returns) so Home needs no extra request. Posts carry structured `weight_g` and `hole`
  (pick-lists; `area` reads "Hole 7 · by the pond"); same course + same hole and close weights add to the score. The post
  forms use **one-thumb disc entry** (`src/public-app/disc-fields.js` + `src/shared/disc-catalog.js`: brand → its plastics,
  colour, weight, hole pick-lists with *Other…*; "Say it" → `POST /voice/disc` → transcript parsed on the page, including the
  course and "where exactly"), the **in-app camera** (`camera-sheet.js`, `photo-add.js`, `camera.css`), and **course search +
  location** (`course-picker.js`, `src/shared/course-geo.js`: nearest course within 2 km, the hole whose tee-to-basket line is
  within 150 m; position never leaves the phone). The scoring app's round Tools link to `#new/found|lost?course=&hole=&from=score
  &return=`; `live-round.js` pins **Return to round** while the viewer is on a live card. QA: `scripts/qa/lost-found-browser-qa.mjs`
  (real Worker in-process; mocked Gemini / Groq / OpenRouter; Chromium fake camera, mic and geolocation). Posters edit their own
  open/claimed post (`PATCH /lost-found/posts/:id`, kind fixed, an unchanged old date kept; `POST …/photos` adds one) from
  `#edit/<id>` (the same form, `EditPost` in `lf-form.js`); every edit re-runs matching (and the lost-disc listing check).
- **My Bag ↔ Lost & Found.** Bag discs are practice records (`member_practice_records`, kind `disc`; optional `color` and
  private `ink` fields, omitted when blank so old payloads are unchanged). Up to 3 **owner-only** photos per disc
  (`bag_photos`, R2 `bag/<owner>/…`, `Cache-Control: private, no-store`; orphans swept by the cron). "I lost this disc" hands the
  disc to the lost-post form via `sessionStorage` (`gvdg_lf_bag_handoff`, never the URL); the bag photos start ticked (up to the
  post's two), are copied server-side onto the post, and `lf_posts.bag_disc_id` links them. **Sell this** (a disc, *Sell my bag*,
  an accessory) does the same for the marketplace (`gvdg_market_bag_handoff`, `src/public-app/market-bag.js` →
  `pro-shop.html#market/sell?from=bag`): the listing POST carries `bagRef` (`disc:<id>` | `bag` | `accessory:<id>`, checked to be
  the seller's and to match the listing's kind) and `bagPhotoIds` (that item's own bag photos, copied from R2; never the private
  writing); `market_listings.bag_ref` stays private and `GET /me/bag` lists active/pending ones so the item shows *For sale*. `matchBags` compares a found disc with same-mold bag discs of
  members whose `bag_settings.match_found` is on (default) and stores **only strong** matches (ink identity / initials with
  agreeing details, or a Gemini "same disc" on a bag photo) as `lf_matches` rows with `bag_disc_id` → the usual strong-match
  notices ("… in your bag"). The finder never learns whose bag.
- **Marketplace ↔ Lost & Found.** `market-lost-check.ts` pairs active listings and open lost posts of the same mold
  (`market_lost_checks`, decided once per pair; the listing photo's ink read once into `market_listing_reads`, only when such a
  lost post exists). Strong only → the **seller** gets a private note linking the public lost post, and **admins** get a push,
  the nav badge (`/admin/market/summary` counts unreviewed ones) and Admin → Marketplace → *Possible lost discs for sale*
  (Hide listing / `POST /admin/market/lost-matches/:listingId/:lostId/review`). No AI budget → left undecided for the next
  trigger.
- **PayPal** (`payments.ts`) — server-trust: amount always priced server-side, capture trusted only when
  `order.status==COMPLETED && capture.status==COMPLETED && USD && amount>=owed`; registration reserves the
  slot *before* charging and releases on failure.
- **Ratings — two systems that can disagree:** `ratings.ts` is a simple display estimate (base 900) for
  the member dashboard; the leaderboard/`round_ratings` use the real **PDGA SSA engine** (`rating-engine.ts`,
  base 1000, iterative propagator drop) written at finalize and re-solved by the daily cron. Don't conflate.
- **Showing ratings re-checks them** (`makeRatingValidator` in `ratings.ts`; also `/my-results` lists) — and must
  stay within D1's 50 queries/request. It checks **whole batches**, never one query per rating:
  - PDGA-based ratings are **checked when written**: `round_ratings.rated_at` (D1 clock) vs migration 0073's
    triggers, which record every change to the PDGA evidence (`pdga_rated_rounds`, `pdga_layout_matches`) per club
    layout and PDGA round date (`''` = all dates) in `pdga_evidence_changes`. A rating written after every change in
    its baseline window is trusted (`pdgaEvidenceUnchanged`); the rest are re-derived in one read per layout
    (`pdgaBaselinesForPlayed`). **Changing `pdgaBaselineFor`, its window, or the PDGA rating math? Move
    `PDGA_RATINGS_TRUSTED_SINCE` to the deploy time** so ratings written under the old rules are re-checked.
  - Club-calibrated (`layout`) ratings depend on earlier ratings (a chain triggers can't follow), so they are
    re-verified on read, batched: `getSourceRatingBaselines` reads calibrations, fields and prior anchors in one
    pass each (selection identical to `priorRatingAnchors`).
  - Rows equal in everything the check reads share one verdict (the list and the 12-month rating overlap).
- **Crotts assistant** (`/assistant`) — provider chain **OpenRouter → Workers AI → dev stub**, prompt built
  with club calendar + courses. **Tee-sign OCR vision** (`vision.ts`) — chain **Gemini → OpenRouter →
  Workers AI → empty**; output is a *suggestion* an admin confirms.
- **Weather** — Open-Meteo (no key), polled by the DO alarm; also feeds the rating engine (wind gust adds
  SSA strokes). **Email** — Resend, best-effort (`waitUntil`), senders on the verified `gvdgclub.com` domain.
- **Club-run PDGA events register on the club site** (no Disc Golf Scene fee): a club event with
  `event_config.pdga_event_id` (admin › Registration › "PDGA event registration", `src/admin-app/tournament-panel.js`,
  `PUT /admin/events/:id/tournament`) takes sign-ups on its event page (`/events#event/<id>`, the link the TD puts on
  PDGA; `src/public-app/tournament-registration.js`). Server: `tournament-routes.ts` (routes), `tournament.ts` (rules,
  fees, quotes; pure), `db-tournament.ts` (field/claims/waitlist SQL), migration 0075. PDGA Competition Manual 1.02/1.03
  rules it follows: entered only once paid (`paid_at` = field order; ties lowest PDGA #), cap counts paid + PayPal
  claims (15 min) + waitlist offers (48 h), the last spot is claimed in one statement before PayPal is charged, only
  paid players are listed, the waitlist shows on the page, withdrawals go to the TD's email, refunds per PDGA's policy.
  Players can cover PayPal's fee (`PAYPAL_FEE_PERCENT`/`PAYPAL_FEE_FIXED_CENTS`), pay by Zelle (admin confirms with
  the arrival time), and give the club what Disc Golf Scene would have charged (`DGS_FEE`). Regular club events keep
  the old flow; the member app sends PDGA events to the event page.
- **PDGA membership join/renew + the club's PDGA discount code:** admins set the code (Admin › More, stored in
  `club_settings`, migration 0076; `pdga-membership-routes.ts`). `GET /pdga/membership` gives the signed-in member's
  PDGA status/expiry (official API), join/renew links, and the code **only for current club members and admins** —
  PDGA asks clubs not to share it outside the club, so guests, lapsed members and the public never get it. PDGA's
  checkout can't take the code from a link, so the card shows it with "Copy code" (`src/shared/pdga-membership.js`;
  More page always, Home when lapsed/ending within 45 days; PDGA event pages link renewal for expired numbers).
- **PDGA data (Developer Program terms).** The official REST API client is `auth-worker/src/pdga-api.ts`
  (secrets `PDGA_API_USERNAME` / `PDGA_API_PASSWORD`, uploaded by `deploy-staging.yml` when the GitHub secrets exist;
  login session reused, players cached 6 h in `pdga_api_players`, limit 70 requests / 10 s per IP). With the login set,
  rating anchors, the Stats panel's official rating, the clubmates' PDGA event list and nearby PDGA events come from
  the API; without it each falls back to its earlier source. Round history, who's registered for an event and
  rated rounds for PDGA baselines are not in the API and still come from pdga.com (owner's call, pending PDGA).
  **Every screen that shows PDGA data renders `PdgaCredit` ("Player, event, and course data provided by PDGA.") and
  links PDGA player/event names with `PdgaLink` (`src/shared/pdga-credit.js`)** — `tests/pdga-credit.test.mjs`
  lists those screens; add any new one there. Clubmates' PDGA numbers stay private (names aren't linked).
- **Feature-gating is by credential presence, at runtime, and fails *soft*:** PayPal auto-checkout needs
  both `PAYPAL_CLIENT_ID`+`PAYPAL_SECRET` (else 503 → manual flag); Crotts/vision degrade down their chains;
  email is a no-op without `RESEND_API_KEY`. A missing credential looks like "nothing happened," not an error.

### Ryder Cup / matchplay leagues

Matchplay league scoring is **team-based Ryder Cup style**, not stroke place-points:

- **Points (`scoring.ts`):** a match is worth **2 to the winner / 1 to each side on a tie / 0 to the loser**,
  by `match_result.outcome`. `computeLeagueStandings` is the per-player view; `computeTeamStandings` is the
  Red-vs-Blue team view, counting each match **once per `(event_id, team)`** so a doubles match's several
  result rows don't double-count; `computeRoundWinners` gives each round's winning side. `GET /leagues/:id`
  returns `standings` + `teamStandings` + `roundWinners`; `GET /leagues/active` (member dashboards) returns
  active leagues (a live or last-60-day round) + live events.
- **Winner coloring (`src/shared/matchplay-colors.js` — pure, node-tested `tests/matchplay-colors.test.mjs`):**
  `holeWinners()` decides each hole by comparing the two teams' scores (doubles alt-shot = the pair's shared
  score; equal = tie; unscored = `null` → uncolored). Colors: Red `#dc3545`, Blue `#2f6fd0`, tie `#e6b400`.
  Applied to the scoring app (current hole's tee sign; halves left **as-is**), the event scoreboard + round-
  results tee signs (halves = **yellow**), and the league rounds list (round winner). App bundles import the
  shared module directly; there is no root `matchplay-colors.js` compatibility shim.
- **Ryder Cup data (league_id 4):** Red = *Juan Team*, Blue = *Jesus Team*. The season was **backfilled from
  the `ryder-cup.html` Google Sheet** — winners are read from the **rendered green-highlighted page** (the CSV
  drops the highlight), imported as one event per match with `source='ryder-import'` (idempotent: re-import
  DELETEs by that source, event 6 is `source='manual'`). ⚠️ **Event 6 (the app-scored alt-shot round) IS the
  sheet's Week 3 #5** — skip it in any re-import to avoid a duplicate. Non-member sheet players are recorded
  name-only (`member_id` null); linking them to member accounts is a manual admin step.

### Frontend & PWA

Pages find the API via the shared `src/shared/api-base.js` host-fallback helper. Data
rendering is **XSS-safe by construction**: live/API data is built with `createElement`/`textContent`,
**never `innerHTML`**; external hrefs pass the pure `src/shared/safe-url.js` helper; tee-sign SVG is parsed inert via `DOMParser`.
(The one `innerHTML`-with-data is `gvdg-members.html`'s doubles league, whose source is build-time-trusted
`DOUBLES_DATA_EMBEDDED` JSON, still run through `escHtml()`.) **Legacy Google-Sheet published-CSV rails**
still power the homepage feeds and Ryder Cup (gviz has no CORS → the sheet must be publish-to-web;
overridable via `data-grid-csv`/`data-scoreboard-csv`). `score.html` is a thin shell mounted by
`src/score-app/main.js`; run `npm run build` before serving or deploying it. **Pages answers a missing file with the site HTML and a 200**, so `sw.js` caches a script/stylesheet only if its
content-type says so (`rightType`), skips and deletes a wrong-typed saved copy, and sweeps them on install/activate
(`dropWrongTypes`); otherwise a deploy-time miss is saved as a member chunk and that screen never loads again
(`scripts/qa/sw-bad-copy-browser-qa.mjs`). The **service worker**
(`sw.js`) is **manually versioned** — bump it on any precached-asset change or
users get stale route bundles such as `admin-app/admin-app.js`, `score.html`, or `score-app/score-app.js`; offline navigation falls back
to `gvdg-members.html`. Current versions: `sw.js` `gvdg-club-v345`, members `?v=229`, public/events `?v=212`, score `?v=247`,
home `?v=198` (tests pin them). `camera.css` is shared by `pro-shop.html`, `lost-found.html` and `gvdg-members.html`. **Add to calendar** everywhere is
`src/shared/add-to-calendar.js`: a menu (portalled to `<body>`, styled by `.cal-menu` in `tokens.css`) offering Google Calendar /
Outlook template links or the .ics download (`event-calendar.js`), Apple's first on Apple devices. **Karma chips** (`src/shared/karma.js`,
`.karma-chip` in `tokens.css`): every rendered player name gets `KarmaChip` (by `memberId` / `pdga` / payload `karmaKey` /
`traderKey`), fed by one public `GET /karma` (`auth-worker/src/karma-directory.ts`: Lost & Found ledger + confirmed donations,
keyed by `handicapKey(memberId)` like live scoring's `handicapKeys`, or the opaque trader key; cached 5 min per tab).
Name-only payloads (live snapshot players / cardmates, event field, public bag tags, event chat, course conditions, PDGA
going, community) carry `karmaKey`; community adds it only where the name itself is visible. **Round karma**: +1 per round a
member finished in the app, counted live from stored rounds (`roundKarmaSql`: finalized casual results with a place, finished
results of final events not imported (`source` not `udisc` / `ryder-import`), member-owned offline rounds; never imports, guests or DNFs; nothing to backfill).
**Karma watch** (`karma-watch.ts`, `0071`, 15-minute cron): more than 3 finished rounds in one club day (America/New_York)
opens one `karma_flags` row and pushes the admins; Admin › Lost & Found › Unusual karma either clears it or takes that day's
round karma back plus 3x as a penalty (append-only `karma_adjustments`), and tells the member. A penalty stays listed
for 60 days with **Undo penalty** (one `penalty_undone` entry gives it all back; the flag closes as `undone`). Totals can go below zero
(chip "✦ −15", outlined). The **member app is code-split**: Home, the shell and the nav are the entry
(`members-app/members-app.js`); every other screen is a content-hashed `members-app/chunks/*.js` loaded on first
open (`src/members-app/lazy-panel.js`). The members build writes `members-app/sw-chunks.js`, which `sw.js` imports to
precache every chunk (kept in `gvdg-member-chunks` for the current and previous release). Chunks import the entry
with the same `?v=` as `gvdg-members.html`, so **bump `?v` in the HTML (script + modulepreload) before `npm run build`**,
never after; `tests/service-worker-chunks.test.mjs` fails if they drift. `scripts/qa/member-load-perf.mjs` measures
first load on a throttled phone profile.

## Security & correctness invariants (uphold in any change)

- **Fail-closed secret gate:** the Worker 500s before any routing unless `JWT_SECRET` is a string ≥32
  chars. Thread `origin` into every early return so error responses keep CORS headers.
- **CORS is an exact-match allowlist** over `ALLOWED_ORIGINS` — no wildcard/subdomain matching.
- **`adminGate` is the only admin authority** (server-side `isAdmin` from ROSTER, not the JWT).
- **Anti-enumeration:** unknown login identifiers still run a real PBKDF2 against `DUMMY_HASH`; lockout is
  keyed by `canonicalLoginKey()` (normalizes PDGA/UDisc) so mutating the raw identifier can't reset it.
- **Closed roster writes:** public `POST /membership/apply` only stores a pending application (rate-limited,
  never `isAdmin`). Roster records still come from `provision.mjs`, admin-gated `POST /admin/members`,
  or admin approve of an application. Admin-issued temporary PINs set `mustChangePin:true`; an approved
  application keeps the PIN the applicant chose and confirmed (`mustChangePin:false`, no second "choose a PIN").
- **Sign-in names:** `isEmail` needs text on both sides of the "@" ("@name" is a UDisc name, as UDisc shows it);
  `pdgaOf` reads only digit-shaped input ("80024", "#80024", "PDGA 80024") as a PDGA # — a UDisc name with digits
  ("discgolfer2019") is never PDGA #2019. `canonicalLoginKey` and `resolveMember` share both rules, so every
  form that reaches an account counts against that account's lockout. `test/auth-flows.test.ts` drives every
  way in (PIN by PDGA/UDisc/email, temp PIN, PIN change/reset, passkeys, applications, guests, open play, admin).
- **WebAuthn challenges are single-use** (read-and-delete); advance the stored credential counter each auth.
- **Every account has an email (the self-service way back in)** — applications require one (members too); a
  member or guest without one gets an "Add your email" step after signing in (admins get a Home reminder instead,
  since another admin can reset them, and so the QA admin isn't stopped). `account-recovery.ts`: `POST
  /me/email/start|verify` (6-digit code to the new address, 15 min, 5 guesses; the old address is told; a first
  email never asks for the PIN) and "Forgot
  PIN?" `POST /pin-reset/start|verify` (code to the email on file; the same answer whether or not the account exists
  or has an email; a reset bumps `pinVer`, clears every lockout key of the account and signs them in). A wrong PIN on
  the email step answers 403 `wrong_pin`, never 401 (the apps read 401 as "signed out").
- **Screens drawn over the signed-in app** (Edit profile, "Your email", Forgot PIN from sign-in) push one history
  entry (`openOverlay` in `member-auth-controller.js`); a back swipe closes them and returns to the app instead of
  leaving the page, and closing them normally pops that entry. The required email step after sign-in pushes none.
- **Admin › Members rows**: the main action full width (Renew when due, or Link for a held account), then Tier ·
  Wallet · More; Reissue PIN, Clear lockouts and Remove member live in More. The list and applications load side by
  side, and the Worker reads member/application records in batches of 25 (`readInBatches`), not one after another.
- **Google Sheets imports** (`sheet-import.ts`, `scripts/qa/sheet-import-e2e-qa.mjs` drives every kind through the
  built admin app against the real Worker): a value the app can't use (over $10,000, a dues year past next year, tag
  #0) skips that row with a note instead of refusing the sheet; an admin linking a misspelled row to a member saves the
  sheet's spelling on them (`sheetNames`) so the next check matches; new-name suggestions only compare names with the
  same last name or the same first letter and a length within 2 (a 200-new-name check was ~50ms of CPU, over the free
  plan's ~10ms); a sheet link must answer with CSV (an unshared sheet answers with Google's sign-in page). A first
  import costs one KV write per new person (held account) and per changed tier or dues year.
- **Speed (owner's sweep, Nov 2026)** — measure with `scripts/qa/member-load-perf.mjs` (phone profile; `--scenario
  stats|signed-in|signed-out --waterfall`). What's in place:
  - The 2026 Ryder Cup is over: its official tally is saved in `src/shared/ryder-cup-2026-final.js` (the Google Sheet
    had all 66 matches; the app's own results only the 22 imported, Blue 23-21 vs the sheet's 109-99), so nothing
    downloads the sheet; `fetchMergedRyderData` is one shared load per visit (5 min).
  - Stats shows when the club's own data is in (the Ryder tally is applied when ready); Stats and the ratings list use
    the identical `/my-ratings` URL so `api.js` shares the request; Home is built when first shown (opening Stats or
    Events directly no longer fetches Home's data); members-app `modulePreload` is on (a screen's chunk and its
    shared pieces download together); background polls check `dashboardShowing(...)` (app in front and that tab open).
  - Admin: the three 60-s polls wait while the tab is hidden (each needs check lists applications; KV allows 1,000
    lists/day free) and catch up on return; Today's shelf uses `GET /admin/shop/low-stock` (a count, not every
    product with its photo); the orders badge keeps its count while checking and clears only on a failed check.
  - Scoring: a saved card (`readMineCache`) shows at once as a preview (`applyMinePayload(..., { cached: true })`
    draws only; the server's card always replaces it and starts the socket/location/saving); round chat polls every
    4 s and never while hidden; `overlayLiveSnapshot` reads pins/positions/consensus in parallel.
  - Live rounds send a member's photo as a signed link (`memberPhotoLink` in profile-photo.ts; `photoRef` kept on
    each player, refreshed in `persist()`/`load()`), served once by `GET /member-photos/:memberId/:sig?v=` with
    `immutable` caching; `playerPhotoSrc` resolves it against the API host. Without `JWT_SECRET` (some tests) or for
    guests/PDGA photos the photo stays inline.
  - `score.html` and `gvdg-members.html` preconnect to the API host from an inline head script (admin.html uses a
    static link: its tests forbid DOM calls in the page).
  - Not done yet (bigger changes, proposed separately): ratings validated on every read (`makeRatingValidator`;
    hashing + baseline queries per row behind `/my-ratings` and `/my-results`), same-origin API (no CORS preflights),
    photos in snapshots, splitting the scorer and admin bundles.
- **Admin top bar** shows the member app's envelope and bell with the same counts (`/me/messages/summary`), opening
  Messages in the member app.
- **Admin › Members › Clear lockouts** (`POST /admin/members/clear-locks`, `clearAccountLocks`) lifts every counter that
  can keep a member out: wrong-PIN lockouts on each sign-in name, the email step's PIN check and code sends (only real
  sends count, 6/hour), Forgot PIN requests, PIN changes. `clearAttempts` deletes only when a count exists and never
  fails a correct sign-in (KV deletes are daily-capped on the free plan).
- **Every session mint stamps the member's `pinVer`** (PIN login, `/set-pin`, passkey `/webauthn/auth/verify`, PIN reset).
  `requireAuth` and `/me` both reject a token whose `pinVer` differs from the record's (a PIN change/reset revokes
  older sessions). A passkey session without it read as revoked on every member route while `/me` said signed in
  (test/passkey-session.test.ts).
- **Imports go through `safeFetch`** with a per-kind host allowlist (https-only, reject userinfo /
  IP-literal / IPv6, `redirect:manual` re-validating every hop, byte/time caps). ⚠️ There is **no
  private-CIDR filter** — SSRF safety rests entirely on the fixed public-host allowlist; never add an
  attacker-controllable host.
- **Verified (tee-sign) par/distance is server-authoritative and sticky** — clients can't forge it.
- **Tee-sign R2 blobs** are reclaimed on reject/delete/demote; rejected images 404 (no IDOR enumeration).
- **Private stays private (marketplace, Lost & Found, My Bag).** Lost-post "what's written on it", AI ink reads, bag
  photos and bag writing, match reasons tied to someone's bag or lost post, guest emails and member ids never appear in
  another party's payload; public shapes are built from allow-lists and `test/lost-found.test.ts` greps them. Uploaded
  photos have EXIF/XMP stripped at the byte level (browsers also re-encode through a canvas). Bag photos are served only
  to their owner. Strong-match alerts go to the likely owner (bag / lost post) or the seller and admins (listings),
  never to the finder or the public.

## Runtime gotchas (fail live, invisible to unit tests)

Per the parent `CLAUDE.md`, **nothing is "done" until it runs in the real app.** These bite at runtime only:

- **PBKDF2 is capped at 100k by workerd — it *throws* above it.** `crypto.ts` and
  `scripts/provision.mjs` both use `ITERATIONS=100_000`. Do not raise this in either place; bulk-seeded
  members would fail `verifyPin` on the deployed Worker.
- **Sessions last 30 days and renew while the app is used** — `SESSION_TTL_SEC=2592000` in `wrangler.toml` (the
  900 in `authz.ts` is only the unset fallback). `GET /me` hands back a fresh session (`token`) once the presented one
  is a day old; the members app stores it from its `/me` check and the score/admin/public/home apps call
  `renewMemberSession` (`src/shared/member-session.js`) on start. A member is signed out only after 30 days without
  opening an app, or at once by a PIN change/reset (`pinVer`). Tokens carry `at` (the real sign-in time, kept across
  renewals): adding a first email needs nothing more than being signed in; changing an existing one needs the PIN,
  or "Use my passkey instead" (a passkey check is a fresh sign-in), unless they signed in within 15 minutes.
- **`-staging` is production:** deploy the Worker with `--env gvdgclub`; a bare `wrangler deploy` ships to
  the deleted base Worker. `env.staging`/`env.gvdgclub` share one DB/KV/R2 — there is no isolated staging.
- **Sign-in counters are in D1, not KV** (`RATELIMIT_BACKEND = "d1"` in every env, `limitsInD1` in index.ts): KV's
  free plan allows 1,000 writes a day and every sign-in attempt writes a counter, so a busy day (a Sheets import also
  writes member records to KV) could stop sign-in; D1 allows 100,000 row writes and reads its own writes at once. The
  15-minute cron deletes expired rows (`purgeExpired`). `"kv"` switches back. Tests that build a full env set it.
- **`kvRateLimited` is a non-atomic GET-then-PUT** (backs login/board/setpin/webauthn) — a concurrent burst
  can slip past. Only `/assistant` uses the atomic `ASSISTANT_RL` binding, and only on the deployed Worker.
- `asIsoTimestamp` **rejects zone-less `YYYY-MM-DDTHH:MM`** (Worker runs UTC) → deadline PATCHes silently 400.
- **UDisc/PDGA importers are brittle scrapers** — a markup change degrades to name-only / blank rather than
  erroring; `safeFetch` sends a real-browser UA on purpose (removing it breaks imports).
- **CF Pages caches JS/CSS ~4h**; `_headers` (`must-revalidate`) is required or code changes look "not
  deployed" until the browser cache expires.
- **Workers Free = ~10 ms CPU per invocation, uncatchable when exceeded.** It kills the whole invocation, including other
  `waitUntil` work and later cron steps. Keep image work in the browser, run AI-bound jobs last in `scheduled()`, and
  never add per-request heavy parsing or crypto loops. Network waits (D1, R2, AI calls) are not CPU.
- **Free AI tiers:** Gemini answers 429 when over quota (treat as "try later"; Lost & Found reads back off on the cron);
  Groq's free Whisper has per-minute / per-day caps (the route falls back to OpenRouter). Keep `LF_DAILY_VISION_BUDGET`,
  `LF_VISION_PER_MINUTE` (default 4) and `VOICE_DAILY_BUDGET`; tests that make several AI calls raise the per-minute cap.
- **KV free tier allows ~1,000 writes a day**, and `kvRateLimited` writes on every call — prefer D1 for anything
  written often.

## Config & secrets (`auth-worker/wrangler.toml`)

Bindings (per env — Wrangler does **not** inherit top-level into named envs, so each block redeclares):
`ROSTER`+`RATELIMIT` (KV), `DB` (D1 `gvdg-staging`), `PHOTOS` (R2), `AI` (Workers AI), `LIVE` (Durable
Object `LiveEventDO`), `ASSISTANT_RL` (unsafe ratelimit, 20/60s), `[triggers] crons=["17 8 * * *", "*/15 * * * *", "7 * * * *"]`
(Cloudflare has rejected extra cron triggers; new periodic work rides an existing tick).
`[vars]` per env: `ALLOWED_ORIGINS`, `SESSION_TTL_SEC`, model ids, `PAYPAL_ENV`, WebAuthn `RP_ID`/
`EXPECTED_ORIGIN` (dev `gvdgclub.com` vs prod `greenvillediscgolf.com`), Resend senders. **Secrets** (never
committed, set via `wrangler secret put` / synced by CI): `JWT_SECRET`, `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY`, `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET`, `RESEND_API_KEY`, `PIN_PEPPER`,
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`. The deploy workflow uploads `GEMINI_API_KEY`, the VAPID keys and
`GROQ_API_KEY` from GitHub secrets (logging only Groq's HTTP status for the key). Optional vars read with a cast
(not in `wrangler.toml`, so typegen is unaffected): `LF_DAILY_VISION_BUDGET`, `LF_VISION_PER_MINUTE`,
`VOICE_DAILY_BUDGET`, `OPENROUTER_WHISPER_MODEL`.
`validate-wrangler-config.mjs`
gates every deploy, aborting on any `REPLACE_WITH_*` in the targeted env.
