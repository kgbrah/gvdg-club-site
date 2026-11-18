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
  │  localhost→:8788,  greenvillediscgolf.com→auth.greenvillediscgolf.com,  ELSE→auth.gvdgclub.com
  │  (deployed HTML ships data-*-base="" so the host fallback is what actually selects the Worker)
  ▼
Cloudflare Worker  auth-worker/src/index.ts   (default export { fetch, scheduled })
  ├─ KV  ROSTER      members (member:<id> = source of truth incl. pinHash) + idx:pdga/idx:udisc + wa:creds
  ├─ KV  RATELIMIT   login lockout + generic counters + one-time WebAuthn challenges (wa:chal:*)
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

`auth-worker/migrations/NNNN_*.sql` are **append-only and globally ordered**. Highest is **`0071`; next is
`0072`**. The **`0007` gap is intentional** — never back-fill it. Two branches must not claim the same
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
`test/market-gear-migration.test.ts` for how to replay a rebuild on seeded data), members' PDGA registrations (`0069`), club donations from marketplace sales (`0070`), the round karma watch (`0071`).

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
- **Crotts assistant** (`/assistant`) — provider chain **OpenRouter → Workers AI → dev stub**, prompt built
  with club calendar + courses. **Tee-sign OCR vision** (`vision.ts`) — chain **Gemini → OpenRouter →
  Workers AI → empty**; output is a *suggestion* an admin confirms.
- **Weather** — Open-Meteo (no key), polled by the DO alarm; also feeds the rating engine (wind gust adds
  SSA strokes). **Email** — Resend, best-effort (`waitUntil`), senders on the verified `gvdgclub.com` domain.
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
`src/score-app/main.js`; run `npm run build` before serving or deploying it. The **service worker**
(`sw.js`) is **manually versioned** — bump it on any precached-asset change or
users get stale route bundles such as `admin-app/admin-app.js`, `score.html`, or `score-app/score-app.js`; offline navigation falls back
to `gvdg-members.html`. Current versions: `sw.js` `gvdg-club-v315`, members `?v=208`, public/events `?v=201`, score `?v=241`,
home `?v=192` (tests pin them). `camera.css` is shared by `pro-shop.html`, `lost-found.html` and `gvdg-members.html`. **Add to calendar** everywhere is
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
  or admin approve of an application; all set `mustChangePin:true`.
- **WebAuthn challenges are single-use** (read-and-delete); advance the stored credential counter each auth.
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
- **Session TTL is 12h, not 900s** — `SESSION_TTL_SEC=43200` in `wrangler.toml`; the 900 in `authz.ts` is
  only the unset fallback.
- **`-staging` is production:** deploy the Worker with `--env gvdgclub`; a bare `wrangler deploy` ships to
  the deleted base Worker. `env.staging`/`env.gvdgclub` share one DB/KV/R2 — there is no isolated staging.
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
