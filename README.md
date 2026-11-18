# GVDG — club site, member home, and live scoring

The app behind [gvdgclub.com](https://gvdgclub.com) for the **Greenville Disc Golf Club** (Greenville, North Carolina).

It is the public club site, a signed-in player dashboard, and a phone scorecard other people can watch. A round is a satellite hole map, a live scoring mix, and a leaderboard that opens into each player's holes. Members see their PDGA rating, their theme, their messages, and what's next. Anyone can start a casual card or follow one that is already going. Club membership is a calendar year: people apply, pay dues, and an admin renews them for the next January 1.

The Pro Shop also runs a **used-disc and gear marketplace** (discs, bags and accessories: buy, sell, trade, WANTED posts), and the club runs a **Lost & Found** that reads the writing on found discs privately, matches them to lost posts and to players' bags, and rewards finders with karma when a disc goes home.

It is two things in one repository, deployed together:

1. **A static frontend** — hand-written HTML shells at the repo root, with Vite/React bundles for the home, public/events, admin, members, live-scoring, and tee-sign preview surfaces.
2. **A Cloudflare Worker** (`auth-worker/`, TypeScript) — the only server-side code. It handles member authentication, the club-operations API, live scoring, the pro shop, ratings, and the "Crotts" AI assistant. Every dynamic thing the pages show comes from this Worker over HTTPS.

There is **no traditional backend or database server to boot** for the site itself — the pages are static files, and all data flows through the Worker.

> **New here and just want to _use_ the site?** Read **[USER-GUIDE.md](USER-GUIDE.md)** — it explains how to do every single thing on the site in plain, simple language.

---

## Table of contents

- [Live sites & environments](#live-sites--environments)
- [Current state](#current-state)
- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Configuration & secrets](#configuration--secrets)
- [API reference](#api-reference)
- [Security model](#security-model)
- [Further documentation](#further-documentation)

---

## Live sites & environments

There are **two separate environments**, and it is important not to confuse them:

| | Static site | Worker (API) | Notes |
|---|---|---|---|
| **Production** | `www.greenvillediscgolf.com` (GitHub Pages) | `auth.greenvillediscgolf.com` | The public club site. Hands-off; **not** touched by any dev-deploy command. Pinned by the `CNAME` file. |
| **Shared dev** | `gvdgclub.com` (Cloudflare Pages project `gvdg-club-site`, branch `main`) | `auth.gvdgclub.com` | The live club app while it is in active development. Published by the **Deploy to staging (gvdgclub.com)** GitHub Action, or by `./scripts/gvdg-deploy.sh`. |

The Cloudflare Worker for the dev environment is named `gvdg-member-auth-staging` — despite the "staging" name, **it is the live dev Worker** attached to `auth.gvdgclub.com`. The `staging` and `gvdgclub` config environments are aliases to the same Worker and share one D1 database, KV, and R2 bucket.

The frontend picks its API base automatically through `src/shared/api-base.js`: an explicit `data-api-base` / `data-auth-base` attribute wins; otherwise it resolves by host (`greenvillediscgolf.com → auth.greenvillediscgolf.com`, everything else → `auth.gvdgclub.com`, `localhost → :8788`).

---

## Current state

*As of November 18, 2026.* `main` is live on `gvdgclub.com`; check the exact commit with `curl -s https://gvdgclub.com/version.json`.

- **Shipped in November 2026:** the used-disc marketplace (0063), Lost & Found (0064), the in-app camera, one-thumb disc pick-lists and "Say it" voice entry, Lost & Found weight and hole (0065), course search with the course and hole filled in from the phone's location, "Return to round", Lost & Found from the scoring app's Tools, and My Bag photos with bag and marketplace cross-checks against Lost & Found (0066), whole-bag and accessory photos (0067), voice entry that records until you tap Stop (up to 30 seconds) everywhere, **Sell this** from My Bag with bags and accessories in the marketplace (0068), editing your own Lost & Found posts, members' PDGA registrations in NC / VA / SC found every hour (0069), an "Add to calendar" menu (Google, Outlook or the .ics file), sellers giving part of a sale to the club for karma (0070), **karma next to every player's name** across the app and site, and **+1 karma for every round finished in the app**, with an admin alert past 3 rounds in a day (0071).
- **Cache versions** (bump on any change to a precached file): service worker `gvdg-club-v317`, members bundle `?v=209`, public/events bundle `?v=201`, score bundle `?v=241`, home bundle `?v=192`.
- **Hosting plan: Cloudflare Workers Free, by the owner's choice.** Every Worker invocation (cron included) gets about 10 ms of CPU, and going over kills the whole invocation. Keep image decoding, re-encoding and heavy loops off the Worker: photos are resized in the browser, and the Worker only copies bytes and calls AI services. AI keys are free tiers too (Gemini for photo reads, Groq for Whisper), with daily budgets in the Worker.
- **Waiting on the owner:** PayPal live credentials for automatic checkout of dues, event entry and the club shop (until then: store credit, pay at the event, or an admin marks it paid). Marketplace buyers always pay sellers directly (PayPal.me, Cash App or Zelle), so the marketplace doesn't wait on this.
- **After every deploy** the read-only *Live QA drive* visits every member and admin screen on the live site (see [AGENTS.md](AGENTS.md)); the last runs found nothing.

---

## Feature overview

### Public (no login required)
- **Home page** (`index.html`) — club identity, upcoming tournaments (auto-loaded from a published Google Sheet CSV and Disc Golf Scene), a course browser with a details modal (UDisc, directions, course-preview video), membership call-to-action, and contact info.
- **Keep score** from the home page and nav. Park players start or join a casual card with a name. No club login.
- **Scoring app** (`scoring-app.html`) — what the phone app actually does: wallpaper, color, and glass themes (shots of the real member Home), saved throw clips, live watch links, and the shot stats behind a score.
- **Events hub** (`events.html`) — live / upcoming / past events, event detail pages (roster, multi-course / multi-layout venue summaries, live-scoring banner, results, CTPs, ace pots), leagues & standings. The member Events tab also lists PDGA events within 100 miles, closest first, with Disc Golf Scene registration links. **PDGA registrations:** every hour the Worker reads PDGA's registration lists for upcoming events in North Carolina, Virginia and South Carolina; a member's own events join *My events* (with their division, who else from the club is going, and a PDGA link) and Home's *Next PDGA*, and *Clubmates at PDGA events* shows signed-in members which events other members are registered for. **Add to calendar** opens a menu everywhere: Google Calendar or Outlook (their own "new event" page, filled in) or the .ics file for Apple Calendar and other apps (Apple's first on iPhone / Mac, Google's first elsewhere).
- **Ryder Cup** (`ryder-cup.html`) — Red vs. Blue team match-play standings and weekly results.
- **Blog** (`gvdg-blog.html`) and **Results archive** (`archive.html`).
- **Crotts** — a floating AI assistant (named after club officer Max Crotts) available on public pages, grounded in the club's live calendar and courses.
- **Watch a round** — a public link follows the card live. No join, no login.
- **Used-disc marketplace** (Pro Shop → Marketplace) — browse used discs, bags and accessories with photos, condition and (discs) flight numbers, and filter by what's for sale; sell, trade or post a WANTED. Members list discs (after saving a buyer-alert email); members and email-verified guests buy, offer trades, post WANTED, leave feedback and report. Buyers pay sellers directly (PayPal.me, Cash App, Zelle); admins handle reports and seller suspensions. When a listing strongly matches a disc someone reported lost, only its seller is told (privately) and the admins get it to review. **Give part of the sale to the club:** a seller can pledge 10%, 25%, 50%, all of it or a set amount on the listing (buyers see "25% to the club"); once it's sold, My marketplace → *Club donations* opens the club's PayPal (paypal.me/greenvillediscgolf) with the amount filled in and the seller taps *I sent it*. An admin checks the club PayPal and marks it **Received** (or *Not received*, with a reason) in Admin → Marketplace → *Donations to confirm*; only then does the seller get **+1 karma for every whole dollar**, added to their karma (how much someone gave is never published).
- **Karma everywhere** — a small chip (✦ 40, read as "40 karma") follows a player's name wherever it appears: the live scorecard, leaderboards and watch view, round talk, event results, the event field, CTP and ace-pot winners, league and bag-tag standings, the board, messages, community profiles and the directory, course conditions, event chat, PDGA "going", the marketplace and admin lists. Players with no karma show nothing. One public directory (`GET /karma`) is keyed by the anonymous player key live scoring already uses (`handicapKey`), never by member id.
- **The club's Google Sheets (admin)** — Admin › Import reads a sheet (any Google Sheets link, or pasted cells) of **people and account tiers**, **store credit balances**, **membership dues** or **bag tag standings**, guesses the columns, shows every change, then applies it. The sheets are canon: balances, dues and tag standings are set to match (tags not on the sheet are released). Rows match by PDGA #, UDisc name or name (close names are offered as suggestions). Anyone not in the app gets a **held account** (no sign-in) that holds their data; when that player sets up their account (an approved application or an admin adding them) it's matched and carried over. Re-applying the same sheet changes nothing. A real account's sign-in identifiers and name are never overwritten.
- **Guest accounts** — "Apply for a club login" offers **Club member** or **Guest account**. A guest gives a valid email (they sign in with it, as well as a PDGA # / UDisc if they have one) and phone number; an admin approves. Guests get everything but marketplace listing. As a promotion the first 100 approved guests (migration 0072, `guest_promo`) also get round history and stats; after that a guest sees "Round history and stats come with a club membership" (`/my-results`, `/my-play-history`, `/my-play-export`, `/my-ratings` answer `membership_required`). The form shows the spots left (`GET /membership/guest-spots`).
- **Account tiers** — Admin, Member, Guest, assigned in Admin › Members (imports set Member/Guest, never Admin). Guests sign in, play, register and buy, but don't list in the marketplace and don't pay dues; "Move N lapsed members to Guest" does it in one go.
- **Live casual rounds (admin)** — Admin › Scoring lists every casual round still open by its round code (course, players, holes scored, last activity; "No activity for over an hour" marks a likely ghost), with **Watch** and **End round** (the admin cancel). `GET /admin/rounds/active` finds rounds from the live index and from member-started rounds that were never saved, and asks each round's Durable Object (`GET do/summary`, names only) whether it is still live.
- **Round karma** — +1 for every round a member finishes in the scoring app (casual rounds, club events scored live, offline rounds; past rounds count, imports and guests don't). More than 3 rounds in one day alerts the admins (push + the Needs you badge); in Admin › Lost & Found › **Unusual karma** an admin either marks it fine or takes that day's round karma back and gives 3x as a penalty (which can be undone for 60 days). The member is told, and a total below zero shows as "✦ −15".
- **Lost & Found** (`lost-found.html`, top-level menu) — post a found disc (1–3 photos) or a lost one; anyone can post after an email check. Posters **edit their own post** while it's up (the details, where and when, the reward or which bin, what's written on it, and its photos); matching runs again on the new details. A private AI read of the photo (Gemini) fills in brand, mold, plastic and colour and reads any writing **privately** (never shown; used only to find the owner); the poster alone is nudged when a photo may show a name or phone number. Found and lost posts are matched (writing, details, course, hole, weight, dates, photo comparison) and likely owners are told. "Is this yours?" → That's mine → contact through the club → Returned → the owner confirms → the finder earns **+10 karma** and can post a celebration on the **Returned** wall, member Home and the homepage strip.
- **One-thumb disc entry** (Marketplace and Lost & Found) — **Take photo** opens an in-app camera (several shots in a row; falls back to the phone's camera app); pick-lists for brand, plastic (the brand's own), colour, weight and hole with *Other…* for anything unlisted; **Say it** records until you tap Stop (up to 30 seconds; it never cuts off on a pause) and Whisper turns it into the lists, the course and "where exactly".
- **Course and hole from location** (Lost & Found) — search courses by name or town, or *Use my location*; when location is already allowed the course you're at and the hole whose tee-to-basket line is closest fill in by themselves. The position never leaves the phone.
- **Return to round** — a pinned button on every Lost & Found screen while you're on a live card.

### Members (PDGA # or UDisc username + PIN)
- **Login** with PDGA number **or** UDisc username + a 4-digit PIN; **forced PIN change** on first login; optional **passkeys / WebAuthn** for passwordless login afterward.
- **Apply** from the login page. An admin approves the application and the chosen PIN becomes the login. Annual dues are $15 (PayPal when it is configured, or cash/other that an admin marks paid).
- **Membership year.** A membership covers January 1 through December 31, Eastern. The roster that existed when this started stays current through 2026. After dues are in, an admin marks **Renew for** the next year. On January 1, anyone not renewed lapses: they can still sign in, but they cannot register for a new event until renewed. Removing a member drops the login and leaves past scores.
- **December 1 reminder.** Members who are not yet renewed for the coming year get a push that morning if notifications are on. A missed December 1 still sends on the next morning through December 7. Account shows the same reminder all December.
- **Member dashboard** (`gvdg-members.html`). The phone bar is **Home, Play, Events, Stats, Club**. Header icons, when signed in: theme, Help, Account, mail, bell. Mail is unread direct messages. The bell is other unseen notices. Both open Messages.
- **Home** — rating, the last round, what is next, bag tags, and a membership line.
- **Play** — start or join a card, watch, replay, film a throw, practice, my bag, and course discovery.
- **My bag** — your discs (brand, mold, plastic, weight, colour), works offline. **Add by voice** records until you tap Stop (up to 30 seconds) and fills the form after you check it. **Photos of my bag** (the whole bag, up to six) and **Accessories** (cart, towel, minis, rangefinder…, each with up to three photos) are private too. Each disc can carry up to three **private** photos (the in-app camera or the photo picker) and a private "what's written on it". **I lost this disc** opens a Lost & Found lost post filled in from the bag, with its bag photos already on (untick any to keep it private). **Sell this** on a disc, **Sell my bag** and **Sell this** on an accessory open a marketplace listing filled in from the bag with its photos on (copied; the bag keeps its own); once it's up the item shows *For sale · View listing*. **Check found discs against my bag** (on by default) privately compares new found discs with your bag and tells you only on a strong match: your name, number or initials on the disc, or the AI says your bag photo shows the same disc.
- **Events** — register, withdraw, pick a division, add CTP / ace-pot entries, check in. Club rounds you are already in sit above open club events. Pay entry with PayPal (when enabled) or store credit, or pay at the event.
- **Stats** — season numbers, and a separate UDisc CSV import that does not mix into club ranks.
- **Club** — directory, message board, bag tags and challenges, standings, tee-sign photos, meeting minutes, and the **Marketplace** and **Lost & Found** hubs (what's waiting on you, links in).
- **Messages** — one-to-one member messages. No group chat and no admin moderation queue.
- **Account** — profile (PDGA #, UDisc, photo), wallet, Appearance, install, and notification prefs.
- **Appearance** — drop a wallpaper, pick a color preset or tune a palette, set glass to Off, Frosted, Clear, or custom, and choose the disc color on the scoring map. Light and dark do not wipe a custom theme.
- **Notifications** — Web Push for bag-tag challenges and direct messages, plus the annual renewal reminder. Times in the app are Eastern.
- **Pro shop** (`pro-shop.html`) — browse products, buy with PayPal or store credit; a **member wallet** (append-only store-credit ledger).

### Live scoring (`score.html`)
- **Phone scorecard.** The satellite map is the hero: tee, basket, marked lies, and the disc in flight. Weather sits on the card. The map grows into leftover space instead of leaving a blank well.
- **One-row live stats.** Ace, eagle, birdie, par, bogey, and double-plus fill a bar as holes are scored. Expand for fairway, circle, and putting. On a phone the extra stats open as a sheet so they do not cover the map.
- **Hole rail.** All 18 holes sit on one sideways-scrolling row. Group cards stack every player (room for four) instead of hiding them on a rail.
- **Leaderboard.** Tap a name to open that player's hole card. Tap a hole to jump the scorer's map to it. On the watch page every card starts open, and a hole tap follows that player.
- **Playing rating.** Once the layout has a scratch score, the stats strip shows what this round is playing like, and how far that is from the player's official PDGA rating when the account has a PDGA number.
- **Throw clips.** Film up to 15 seconds and attach it to a player and hole. It stays private until it is shared with round viewers.
- **Watch link.** Casual rounds start as card-only. The round creator can share a watch link for scores, maps, marked positions, and shared clips. The same link opens the replay after the round.
- **Share card.** When the card locks, one image carries the hole scores, to-par, and the scoring mix. Watch links copy in one tap.
- **Course pick.** GPS, nearest mapped layouts first, search across the North Carolina catalog and nearby courses, directions, and a path to photograph a tee sign when a course is still unmapped. A Worker cron fills unmapped layouts from UDisc.
- **Offline.** Prepare a course pack, then score a saved layout without a connection. Joining a live card still needs one.
- **Wrist layout.** A large-target layout for a watch or a small screen, with the screen kept awake. Native watch apps are in device testing and are not in the stores yet.
- **Casual rounds and event cards**, one card or many. **Any cardmate keeps score**; members may only score **their own card**; admins can score anyone.
- **Consensus scoring** — a hole's official score is set only when the active scorers agree; disagreement blanks the hole and blocks finishing until resolved.
- **Singles, doubles, and match play**, including Ryder Cup coloring. Add guests, manage the card, and finish the round from the phone.
- **Tools → Found a disc / Lost a disc** opens the Lost & Found form with the course and current hole filled in, and *Return to round* brings the player back to the card.

### Admin (`admin.html`)
Five groups, not a long tab strip: **Today**, **Events**, **Members**, **Money**, **Tools**.

- **Today** — what needs a person right now.
- **Events** — list, new event (including multiple course/layout assignments), import (Disc Golf Scene / CSV / UDisc), league seasons, registration (fees, divisions, CTPs, ace pots, teams, roster and check-in), and live scoring.
- **Members** — pending applications (approve, reject, mark dues paid), create a login and issue a temporary PIN, reset a PIN, promote or demote admins (the last admin cannot be removed), **renew** a membership year, and **remove** a member.
- **Money** — pro shop inventory, orders, wallets, and fundraiser campaigns.
- **Tools** — courses, course health, layouts (including the SAFARI hole builder), tee-sign review, bag tags, meeting minutes, the community review queue, the data archive, **Lost & Found** (reports, AI match suggestions, karma and reversals, hidden items, close and merge), and **Marketplace** moderation (reports, hidden items, suspensions, the moderation log, and **Possible lost discs for sale** with Hide listing / Mark reviewed).

### Integrations
- **Crotts AI** — provider chain OpenRouter → Cloudflare Workers AI → dev stub.
- **Tee-sign OCR (vision)** — Gemini → OpenRouter → Workers AI.
- **Lost & Found vision** — Gemini (free tier) reads found-disc photos privately and compares photos ("the same physical disc?"), with an OpenRouter free model as the fallback. Club-wide daily budget and per-minute pacing so tee-sign OCR keeps room; a quota answer means "try again later" on the 15-minute cron.
- **Voice entry ("Say it")** — Whisper large-v3-turbo on **Groq's free plan** (with a disc-name spelling hint), then Whisper through OpenRouter as the paid backup (about $0.0002 a minute). The audio is forwarded as is and never stored.
- **Weather** — Open-Meteo, with National Weather Service observations as fallback when the free quota trips (feeds both the app and the rating engine). Course observation clocks are Eastern.
- **Email** — Resend (order/registration/application mail), best-effort.
- **PayPal** — Orders v2 auto-capture for dues, event entry, and the shop, plus a `paypal.me` fallback.
- **Web Push** — VAPID. Member devices opt in from Account. Admin devices have a separate subscription for club alerts.
- **Ratings** — PDGA official stats on the member dashboard, a live "playing" rating during a round when the layout has a scratch score, and a full PDGA-SSA engine recomputed by a daily cron.

---

## Architecture

### Request flow

```
Browser (static page)
  │  resolves the API base through src/shared/api-base.js
  │  (data-*-base attribute, else by host)
  ▼
Cloudflare Worker  auth-worker/src/index.ts   (default export { fetch, scheduled })
  ├─ KV  ROSTER      members (source of truth incl. PIN hashes) + login indexes + passkey creds
  ├─ KV  RATELIMIT   login lockout + counters + one-time WebAuthn challenges
  ├─ D1  DB          club data: events, courses/layouts, registration, results, board,
  │                  messages, push subscriptions, bag tags, membership dues,
  │                  pro-shop/wallet, ratings, casual rounds, throw clips
  │                  (all queries parameterized)
  ├─ DO  LIVE        LiveEventDO — live scorecard state + WebSocket; writes to D1 only on finalize
  ├─ R2  PHOTOS      tee-sign images, marketplace listing photos, Lost & Found photos, private bag photos
  └─ AI  + OpenRouter/Gemini/Groq  Crotts assistant, tee-sign OCR, Lost & Found reads, Whisper voice entry
  scheduled()  cron "17 8 * * *"   → daily ratings recompute, and the Dec 1 membership reminder
               cron "*/15 * * * *" → marketplace withdrawal sweep, UDisc layout import (similar names + city,
                                     unmapped only), then the Lost & Found tick last (expiry, photo purge,
                                     due AI reads, matching, bag-photo cleanup)
               cron "7 * * * *"    → hourly PDGA events within 100 miles, members' PDGA registrations (NC / VA / SC); Sunday 3pm Eastern
                                     UDisc league standings ride this tick
```

### The split router

Two-tier, no framework. `src/index.ts` `fetch()` runs a fixed pipeline: resolve `origin` → CORS/OPTIONS → a **fail-closed secret gate** (500 before any routing unless `JWT_SECRET` is ≥32 chars) → a top-level `if`-chain for member/auth/webauthn/tee-sign/pdga routes → `clubApi()` → 404, all wrapped in a `try/catch` that returns **CORS-bearing** error responses.

`clubApi()` (in `club-api.ts`) tries domain handlers in a **fixed order, first non-null response wins**: `handleClubPublic → handleClubLive → handleCasualRoundRequests → handleCasualRounds → handleClubShop → handleClubRegistration → handleClubAdmin`. Each self-guards on the request path shape and returns `null` to pass. Dispatch is order-sensitive.

Three authorization gates live in `authz.ts`, and **all authorization is re-checked server-side**:
- `requireAuth` — verifies the Bearer JWT (returns null if the member still must change their PIN).
- `requireMember` — `requireAuth` → member id, or 401.
- `adminGate` — `requireAuth` **plus** a fresh roster read requiring `member.isAdmin === true`. `isAdmin` is **never** trusted from the JWT; it is read from KV on every request.

### Live scoring & the consensus model

One Durable Object class, `LiveEventDO`, serves both event live-scoring and casual rounds. State lives in Durable Object storage (not D1) until finalize; a hibernatable WebSocket broadcasts a fresh snapshot on every change. Each hole score is a **map of votes keyed by scorer**; the official score is **derived** only when active scorers agree. On finalize, standings are written to D1 (and rolled back if any persist step throws). The Durable Object trusts only the Worker-injected `X-Auth-Member` / `X-Auth-Admin` headers — never the request body.

### Data layer

All D1 access is **parameterized** (`.bind()` with `?`). Migrations in `auth-worker/migrations/NNNN_*.sql` are **append-only and globally ordered** (`0001`–`0072`; the `0007` gap is intentional and must not be back-filled; **the next is `0073`**). `0025_event_courses.sql` is the structured multi-course / multi-layout event assignment table. Later migrations add clips, bag tags, push, messages, membership dues, the marketplace (`0063`), Lost & Found (`0064`), Lost & Found weight and hole (`0065`), bag photos, the bag / marketplace cross-checks (`0066`), whole-bag / accessory photos (`0067`), bags and accessories in the marketplace plus "Sell this" links (`0068`, a rebuild of `market_listings` that keeps every id), members' PDGA registrations (`0069`), club donations from marketplace sales (`0070`), the round karma watch (`0071`), and guest promo spots (`0072`). Do not reuse a number.

My Bag discs live in `member_practice_records` (JSON payloads synced by the offline-first practice engine); the bag's photos, its found-disc switch and the lost-post links live in their own tables so the sync engine never handles images.

---

## Tech stack

- **Frontend:** hand-written HTML5 shells + CSS custom-property design tokens (`tokens.css`), Vite/React bundles for the public, admin, members, live-scoring, tee-sign preview, and home app surfaces, a service worker (`sw.js`, manually versioned) + PWA manifest.
- **Backend:** Cloudflare Workers (TypeScript), Workers KV, D1 (SQLite), Durable Objects, R2, Workers AI. Auth via PBKDF2-HMAC-SHA256 PIN hashing + HS256 JWT (`jose`) + passkeys (`@simplewebauthn/server`).
- **Tooling:** `wrangler`, `vitest` (Worker tests), `node --test` (frontend helper tests), `playwright` (browser QA), `tsc` (typecheck).

---

## Repository layout

```
/                         static frontend (served as-is)
  index.html              home page
  gvdg-members.html       member dashboard + directory + login
  admin.html              admin control panel
  events.html             public events hub + detail
  score.html              live scoring HTML shell
  scoring-app.html        public description of the scoring app
  src/score-app/          React shell + live-scoring app entry
  vite.score.config.mjs   Vite build for the generated score-app/ bundle
  score-app/              generated score bundle (created by npm run build, git-ignored)
  pro-shop.html           pro shop + member wallet + used-disc marketplace
  lost-found.html         Lost & Found (found / lost posts, claims, the Returned wall)
  camera.css              the in-app camera (pro shop, Lost & Found, member app)
  ryder-cup.html          Ryder Cup standings
  gvdg-blog.html          blog
  archive.html            results archive
  src/*-app/              React app entries for migrated page regions
  *-app/                  generated route bundles (created by npm run build; checked in where needed for static hosting)
  *.js                    small static helpers that remain page-owned (pwa.js, ryder-cup.js, ...)
  tokens.css              design tokens (single source of colour truth)
  sw.js                   service worker (manually versioned cache; bump it when a precached page changes)
  site.webmanifest        PWA manifest

auth-worker/              the Cloudflare Worker (server-side)
  src/                    TypeScript modules (index.ts, authz.ts, live.ts, db*.ts, club-*.ts, …)
  migrations/             append-only D1 migrations (0001–0072; 0007 gap is intentional; next is 0073)
  test/                   vitest suites
  scripts/                provision.mjs, dev-seed.mjs, validate-wrangler-config.mjs
  wrangler.toml           bindings, environments, vars

scripts/                  gvdg-deploy.sh (locked local deploy; see Deployment) + watchdog
tests/                    frontend helper tests (node --test)
docs/                     design specs & implementation plans
```

Key docs: **[CLAUDE.md](CLAUDE.md)** (architecture map), **[AGENTS.md](AGENTS.md)** (deploy contract), **[DESIGN.md](DESIGN.md)** (design system), **[CROTTS.md](CROTTS.md)** (AI assistant setup), **[PAYMENTS.md](PAYMENTS.md)** (PayPal), **[STAGING.md](STAGING.md)**, `auth-worker/PROVISIONING.md` (member seeding).

---

## Local development

**Prerequisites:** Node.js 22+, and `wrangler` (`npm i -g wrangler`). Run the root build before serving the local frontend.

### 1. Install root frontend/tooling dependencies
```bash
npm install
```

### 2. Install Worker dependencies
```bash
cd auth-worker
npm install
```

### 3. Provide local secrets & vars
Create `auth-worker/.dev.vars` (git-ignored) with at least:
```
JWT_SECRET=<any string ≥ 32 characters>
ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080
SESSION_TTL_SEC=43200
```
CORS is an **exact-match allowlist**, so the origin you serve the site from must be listed.

### 4. Run the Worker (local)
```bash
cd auth-worker
npm run dev            # wrangler dev — local KV / D1 / R2 / DO on http://127.0.0.1:8788
```

### 5. Seed local data
Apply migrations and seed a member into local KV:
```bash
# D1 schema (from auth-worker/)
for f in migrations/*.sql; do wrangler d1 execute DB --local --file="$f"; done

# a member (PIN hashing matches the Worker) — generates KV bulk-put JSON
node scripts/dev-seed.mjs 12345 JaneD 4821 "Jane Doe" > seed.local.json
wrangler kv bulk put seed.local.json --binding=ROSTER --local
```
> Note: the roster is in **KV** (`member:<id>`), not D1. `dev-seed.mjs` creates a member with `mustChangePin: true`; edit the generated JSON to add `"isAdmin": true` / `"mustChangePin": false` if you need an admin who skips the forced PIN change.

### 6. Build and serve the static site
```bash
# from the repo root
npm run build
python3 -m http.server 8080 --bind 127.0.0.1
```
Open `http://127.0.0.1:8080/` — the pages auto-resolve the API to `http://127.0.0.1:8788`.

> **Stopping dev servers:** kill by port PID — `ss -ltnpH 'sport=:8788'` then `kill <pid>`. **Never** `pkill -f wrangler` (it can match your own shell).

---

## Testing

```bash
# Worker (from auth-worker/)
npm test                      # vitest — full unit/integration suite
npx vitest run test/live.test.ts   # a single file
npm run typecheck             # tsc --noEmit
npm run audit                 # npm audit --audit-level=moderate

# Frontend helpers (from repo root)
npm run build                 # builds all generated Vite route bundles
npm test                      # node --test tests/*.test.mjs
npm run qa:react              # react-doctor project scan; generated app bundles are ignored
npm run qa:site-smoke         # Playwright browser smoke for migrated route bundles
npm run qa:live-scoring       # Playwright live-scoring browser QA
npm run qa:members-dashboard  # Playwright member-dashboard browser QA
node scripts/qa/lost-found-browser-qa.mjs   # Lost & Found + camera + pick-lists + voice + location + My Bag cross-checks,
                                             # against the real Worker in-process (mocked Gemini / Groq / OpenRouter)
node scripts/qa/marketplace-browser-qa.mjs  # the marketplace (incl. Sell this from My Bag: a disc, the bag, an accessory)
node scripts/qa/practice-browser-qa.mjs     # practice + My Bag (photos, I lost this disc, Sell this, the switch)
npm run qa:staging-live-scoring  # live gvdgclub.com scoring E2E; requires QA credentials
npm run qa:staging-member-dashboard # live gvdgclub.com member dashboard E2E; requires QA credentials
```

**Live verification is required for anything user-facing:** unit tests and static review are necessary but not sufficient. Stand up the Worker + served frontend and drive the actual flow before calling a change done.

---

## Deployment

> **Do not `wrangler deploy` or `wrangler pages deploy` by hand.** `gvdgclub.com` is one shared environment. A raw deploy is last-write-wins.

- **A push to `main` does not deploy.**
- **The live publish is the GitHub Actions workflow** [Deploy to staging (gvdgclub.com)](.github/workflows/deploy-staging.yml). It is `workflow_dispatch` only. On `main` it runs the static and Worker tests, applies remote D1 migrations, deploys the Worker `--env gvdgclub` (`auth.gvdgclub.com`), deploys Cloudflare Pages project `gvdg-club-site`, then runs the post-deploy browser checks.
- **`./scripts/gvdg-deploy.sh`** is the lock-protected local path in [AGENTS.md](AGENTS.md). It refuses a dirty tree and refuses a HEAD that does not contain the commit already live on `gvdgclub.com`.
- **`main` is the only line that should be live** on `gvdgclub.com`.

```bash
gh workflow run "Deploy to staging (gvdgclub.com)" --ref main
curl -s https://gvdgclub.com/version.json          # {commit, branch, deployedAt, deployer}

GVDG_AGENT=<your-name> ./scripts/gvdg-deploy.sh    # local locked deploy, if you are not using Actions
./scripts/gvdg-deploy.sh --status                  # what's live vs your HEAD (read-only)
./scripts/gvdg-deploy.sh --dry-run                 # run every gate, deploy nothing
```

The deploy runs the live scoring and member-dashboard staging checks when a private QA credential is configured (`GVDG_STAGING_QA_TOKEN`, or `GVDG_STAGING_QA_IDENTIFIER` plus `GVDG_STAGING_QA_PIN`). The QA member must be an admin so the scoring check can cancel the temporary round it creates.

Production (`www.greenvillediscgolf.com`, GitHub Pages, pinned by `CNAME`) is **separate** and is not touched by this workflow or by the dev-deploy script.

---

## Configuration & secrets

Worker bindings (per environment in `auth-worker/wrangler.toml`): `ROSTER` + `RATELIMIT` (KV), `DB` (D1), `PHOTOS` (R2), `AI` (Workers AI), `LIVE` (Durable Object `LiveEventDO`), `ASSISTANT_RL` (unsafe rate-limit). Crons: daily ratings (`17 8 * * *`), a UDisc layout import every 15 minutes, and an hourly PDGA refresh (`7 * * * *`). The Sunday league refresh and the December 1 membership reminder ride those existing ticks. Cloudflare has rejected extra cron triggers.

**Secrets** (never committed; set via `wrangler secret put` or synced by CI):
`JWT_SECRET`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `PAYPAL_CLIENT_ID` / `PAYPAL_SECRET`, `RESEND_API_KEY`, `PIN_PEPPER`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`. The deploy workflow uploads `GEMINI_API_KEY`, the VAPID keys and `GROQ_API_KEY` from GitHub secrets (and logs only whether Groq accepts the key).

Optional vars: `MEMBERSHIP_DUES_CENTS` (default 1500) and `MEMBERSHIP_DUES_ONLINE=off` to force dues checkout off; `LF_DAILY_VISION_BUDGET` (default 150) and `LF_VISION_PER_MINUTE` (default 4) for Lost & Found AI reads; `VOICE_DAILY_BUDGET` (default 300 clips) and `OPENROUTER_WHISPER_MODEL` for voice entry.

**Feature-gating is by credential presence and fails _soft_:** PayPal auto-checkout needs both PayPal secrets (else dues and entry fall back to an admin "marked paid" / pay-at-the-event flag); Web Push is a no-op without VAPID keys; Crotts and OCR degrade down their provider chains; Lost & Found posts and matches still work on their typed details when the AI is unavailable (reads retry on the cron); "Say it" shows a plain message and the pick-lists still work when no Whisper provider answers; email is a no-op without `RESEND_API_KEY`. A missing credential looks like "nothing happened," not an error.

`validate-wrangler-config.mjs` gates every deploy and aborts on any `REPLACE_WITH_*` placeholder in the targeted environment.

---

## API reference

All authorization is re-checked server-side. Base URL is the Worker (`auth.gvdgclub.com` / `auth.greenvillediscgolf.com` / `http://127.0.0.1:8788`).

### Public (no auth)
`POST /login` · `POST /membership/apply` · `GET /membership/config` · `POST /assistant` · `POST /webauthn/auth/{options,verify}` · `GET /pdga-stats` · `GET /courses` · `GET /leagues[/:id]` · `GET /events[/:id]` · `GET /events/:id/{results,ctps,ace-pot}` · `GET /fundraisers[/:id]` · `GET /meetings[/:id]` · `GET /registration/open` · `GET /payments/config` · live snapshots + `/ws`. Member: `GET /pdga-registrations` → `{ mine, club }` (the member's PDGA events with their division and clubmates going; events clubmates are registered for). Admin: `GET /admin/pdga-registrations/status` (counts per state, last read; the post-deploy live check records it). Public: `GET /karma` → `{ players: { [handicapKey]: karma }, traders: { [traderKey]: karma } }` (people with karma only; cached 5 minutes).

### Member-authenticated (Bearer JWT)
`GET /me` · `POST /set-pin` · `POST /profile` · `GET /my-results` (club events + `casual` history) · `GET /my-ratings` · `GET /my-live-rounds` · `GET /my-registrations` · `GET|POST /board[/…]` · `GET|POST /me/messages` · `GET|PUT|DELETE /me/push-subscription` · `GET /me/notices` · `POST /webauthn/register/{options,verify}` · `POST /tee-signs` · `GET /my-tee-signs` · live score/card writes (own card only).

### Registration & shop (member, some guest-optional)
`GET /events/:id/registration` · `POST /events/:id/{register,checkin}` · `POST /events/:id/pay/{create-order,capture}` · `GET /shop/products` · `POST /shop/pay/{create-order,capture}` · `GET /shop/wallet` · `GET /shop/orders`. A lapsed member gets `membership_lapsed` on a **new** event registration. Guests and admins are not blocked that way.

### Marketplace, Lost & Found, My Bag and voice (members, and email-verified guests where noted)
- **Marketplace** `/market/*`: `config`, `guest/{start,verify}` (the shared guest identity), `listings` (browse with `kind=disc|bag|accessory`, create — `itemKind`, `gearType`, `donatePercent` / `donateCents`, and from My Bag `bagRef` + `bagPhotoIds` — edit, photos, withdraw / relist, buy), `deals/:id/donation` (the seller sent the club's share), admin `donations/:id/review`, `offers`, `deals`, `wanted` (+ replies), `feedback`, `reports`, `traders/:key`, `settings`, `me`.
- **Lost & Found** `/lost-found/*`: `config`, `posts` (browse, create, detail, `PATCH` edit by its poster, add photo, close, turn-in, photo remove), `photos/:id` (public image; `keep` / `replace` / `remove` for its uploader), `matches/:id` (decide: mine / not mine), `claims/:id/...` (messages, returned, confirm, celebrate), `returned` (wall and homepage strip), `people/:key`, `me`, `reports`, `guest/{start,verify}`.
- **My Bag** (member) `GET /me/bag` (also the bag items up for sale) · `PUT /me/bag/settings` · `POST /me/bag/photos` (a disc, the whole bag, or an accessory) · `GET|DELETE /me/bag/photos/:id` (owner only, never cached publicly) · `POST|PATCH|DELETE /me/bag/accessories[/:id]`.
- **Voice** `POST /voice/disc` (an audio clip → `{ transcript }`; open, rate-limited per address and by a daily budget).

### Admin-gated and admin-only
`/admin/events`, `/admin/courses`, `/admin/layouts`, `/admin/leagues`, `/admin/fundraisers`, `/admin/meetings`, `/admin/import`, `/admin/tee-signs`, `/admin/shop`, `/admin/wallets`, `/admin/orders`, `/admin/export`, `/admin/bag-tags`, `/admin/market` (overview, reports, hide / unhide, suspensions, feedback removal, `lost-matches/:listingId/:lostId/review`), `/admin/lost-found` (overview, reports, matches, hide, close, merge, karma reversal, photos), and **`/admin/members`** (list / create / `reset-pin` / **`set-role`** / **`renew`** / **`remove`**, plus `/admin/members/applications` approve, reject, and mark-paid). Last-admin protection applies to demote and remove. An admin cannot remove their own login. Event live-scoring lifecycle is `start` / `finalize`. Admin-only casual round cancel is `POST /rounds/:code/cancel`.

---

## Security model

- **Fail-closed secret gate** — the Worker 500s before routing unless `JWT_SECRET` is ≥32 chars; `origin` is threaded into every early return so errors keep CORS headers.
- **CORS is an exact-match allowlist** (no wildcard/subdomain matching).
- **`adminGate` is the only admin authority** — server-side `isAdmin` from KV, never the JWT.
- **Anti-enumeration** — unknown login identifiers still run a real PBKDF2 against a dummy hash; lockout is keyed by a canonicalized identifier.
- **Enrollment is an application, not an open signup.** `POST /membership/apply` stores a pending application. A member login exists only after an admin approves it, or after `provision.mjs` / the admin create endpoint. New logins start with a forced PIN change.
- **Membership year is not a login gate.** A lapsed member can still authenticate. New event registration is what refuses them.
- **WebAuthn challenges are single-use**; the stored credential counter advances each authentication.
- **Imports are SSRF-guarded** — an https-only, public-host allowlist with redirect re-validation and byte/time caps.
- **XSS-safe by construction** — live/API data is rendered with `createElement` / `textContent`, external hrefs pass a URL sanitizer.
- **Photos carry no location.** Browsers re-encode uploads through a canvas and the Worker strips EXIF / XMP / text chunks again; it never decodes an image.
- **Private stays private.** What's written on a lost disc, an AI read of a photo, a bag's photos and writing, and why a match was made are never in a public payload (tests assert it). Bag photos are served only to their owner. Marketplace "possible lost disc" alerts go only to the seller and the admins; the finder of a found disc is never told whose bag or lost post matched.

---

## Further documentation

| Doc | What it covers |
|---|---|
| **[USER-GUIDE.md](USER-GUIDE.md)** | How to use **every feature** on the site, in plain simple language. |
| [CLAUDE.md](CLAUDE.md) | Full architecture map, request flow, worker domain map, runtime gotchas. |
| [AGENTS.md](AGENTS.md) | The deploy coordination contract for the shared environment. |
| [DESIGN.md](DESIGN.md) | The design system (colour, type, components). |
| [CROTTS.md](CROTTS.md) | Crotts AI assistant setup & providers. |
| [PAYMENTS.md](PAYMENTS.md) | PayPal enablement. |
| [STAGING.md](STAGING.md) | The dev/staging environment. |
| `auth-worker/PROVISIONING.md` | Seeding members and issuing PINs. |

---

*Built for the Greenville Disc Golf Club — Greenville, North Carolina. 🥏*
