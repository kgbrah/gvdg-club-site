# Tee-Sign Capture — crowdsourced course data via member photos + Crotts vision

- **Date:** 2026-06-24
- **Status:** Approved design → ready for implementation plan
- **Repo:** `gvdg-club-site` (Cloudflare Worker `auth-worker/` + static frontend)
- **Branch:** `feat/tee-sign-capture`, stacked on `feat/events-d1-schema` (the club-ops/D1/live-scoring backend it builds on)

## Problem & context

The club needs accurate per-hole **par + distance** for its ~22 home courses to drive live UDisc-style
scoring, and wants a **tee-sign graphic** shown for each hole during play. Importing this from UDisc by
URL does not work, and we confirmed empirically why:

- **UDisc** course pages (HTTP 200, ~395 KB) contain **zero `"par"` fields** in the served HTML. Per-hole
  data is held in a reference-serialized client blob and hydrated **client-side** from a closed internal
  API. A server-side Worker `fetch` can never see pars/distances. `parseUdiscLayout` therefore always
  degrades to "name only."
- **discgolfscene** course pages expose only course-level metadata (name, location, hole count, rating);
  there is **no per-hole par/distance table** in fetchable HTML, and per-hole pages 404 on plain fetch.

Conclusion: **no external source reliably yields per-hole pars via server fetch.** The reliable source is
the club's own knowledge — which is literally printed on the **tee signs**. So instead of scraping, members
**photograph tee signs while playing**; an AI vision model (Crotts) reads par/distance from the photo; an
admin confirms; the confirmed data drives scoring and the photo becomes the hole's graphic. This fills the
course-data gaps organically and stays entirely on free tiers.

## Goals

- Members upload tee-sign photos (mobile camera) for a chosen course + hole.
- Crotts (vision) extracts `{par, distance_ft, tee, target}` as a **suggestion**.
- An admin **confirms** before any value becomes official scoring data (two-tier trust).
- The official photo + a clean tee-sign graphic render for the current hole during live scoring.
- Everything runs on Cloudflare free tiers (D1 + new R2 + existing AI rails).

## Non-goals

- Fully-automated, no-human-in-the-loop par extraction (OCR is imperfect — confirmation is mandatory).
- Live UDisc/discgolfscene scraping as a source of truth (abandoned; unreliable as shown above).
- Per-throw GPS / shot tracking. Distance comes from the sign, or `distance.ts` (haversine/par-estimate).

## Locked decisions

1. **Trust model = two-tier (C).** A candidate photo is visible immediately as "⚠ unverified," but scoring
   reads **only** admin-confirmed (official) data. Confirmation writes the par/distance into the layout.
2. **Candidate visibility = logged-in members only** until approved. Official photos are public.
3. **Storage = Cloudflare R2** (new binding). Images never go in KV/D1; D1 holds only metadata.
4. **Ship T0 first** — the SVG tee-sign render is dependency-free and works today from existing layout data.
5. **Scope = one program, slices T0–T4.**

## Architecture

```
member (phone) ── POST /tee-signs ──▶ Worker ──▶ R2 PHOTOS (image)  + D1 tee_signs (row, status=candidate)
                                          └─ ctx.waitUntil ─▶ vision.ts (OpenRouter VL → Workers AI → none)
                                                                 fills extracted_par/distance on the row
admin ── GET /admin/tee-signs?status=candidate ──▶ review queue (photo + editable guess)
      └─ POST /admin/tee-signs/:id/approve ──▶ writes par/distance into course_layouts.holes,
                                                sets hole.tee_sign_key, status=official, demotes prior official
live scoring / event detail ──▶ renders official photo + hole/par/distance overlay
                                 (no photo → SVG tee sign from layout data → placeholder + CTA)
```

Identity stays in KV (existing auth). Club data stays in D1. The Worker is the trust boundary; all writes
are server-side authz-checked (`requireAuth` for members, `adminGate` for approval).

### Data model

New migration `auth-worker/migrations/0007_tee_signs.sql`:

```sql
CREATE TABLE tee_signs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  layout_id INTEGER,                 -- nullable; a sign is usually course+hole intrinsic
  hole_number INTEGER NOT NULL,
  r2_key TEXT NOT NULL,              -- server-generated UUID key in R2
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,         -- memberId
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',  -- candidate | official | rejected
  extracted_par INTEGER,
  extracted_distance_ft INTEGER,
  extracted_tee TEXT,
  extracted_target TEXT,
  extract_raw TEXT,                  -- raw model JSON, for audit
  extract_source TEXT,               -- 'openrouter:<model>' | 'workers-ai:<model>' | 'manual' | NULL
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX idx_tee_signs_hole ON tee_signs(course_id, hole_number, status);
CREATE INDEX idx_tee_signs_status ON tee_signs(status);
```

`tee_signs` is the **capture/moderation ledger**. The *scoring* source of truth remains
`course_layouts.holes` JSON (already read by live scoring). On approval we copy the confirmed
`par`/`distance_ft` into that hole and add `tee_sign_key` (+ `distance_source:'tee_sign'`). Scoring never
reads a candidate row directly — that is what keeps two-tier clean.

### Storage — R2

`auth-worker/wrangler.toml` gains:

```toml
[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "gvdg-photos"
```

Free tier: 10 GB storage, 0 egress; the full catalog (~22×18 photos ≈ 80 MB) is trivial. Object keys are
server-generated: `tee-signs/<courseId>/<hole>/<uuid>.<ext>` (no user input in the path → no traversal).

**Serving images (matches the auth model):**
- **Official** photos are public → plain `<img src="/tee-signs/:id/image">`, long cache.
- **Candidate** photos are members-only → the members/admin JS fetches them with the Bearer token
  (`fetch` → blob → object URL), the same authed-fetch pattern the SPA already uses. No public candidate URL.

### Vision extraction — `auth-worker/src/vision.ts`

Mirrors `assistant.ts`'s provider chain, multimodal:

```
extractTeeSign(env, dataUrl) :
  try OpenRouter VL model (env.OPENROUTER_VISION_MODEL, default a current free VL id,
      runtime-query openrouter /models for a :free image-input model if the default 404s/429s)
  → fallback Workers AI vision (env.VISION_MODEL default '@cf/meta/llama-3.2-11b-vision-instruct')
  → else return {source:null}  (manual entry)
```

- Strict prompt: "Read this disc golf tee sign. Return ONLY JSON
  `{hole:int|null, par:int|null, distance_ft:int|null, tee:string|null, target:string|null}`. Null any
  field not clearly visible." Parse JSON defensively; **clamp** `par`∈[1,10], `distance_ft`∈[20,2000];
  ignore everything else. The model's text is never rendered as HTML and never auto-applied (human confirms),
  so tee-sign text cannot become a prompt-injection/scoring attack.
- Image to model: the Worker holds the bytes → base64 data URL (OpenRouter `image_url`; Workers AI image
  input). Client pre-resizes to ≤ ~1024 px (bigger than the 256 px profile thumb — OCR needs detail).
- Runs in `ctx.waitUntil(...)` after the upload response so the row populates within seconds. Requires
  threading `ExecutionContext` into `export default { fetch(request, env, ctx) }` (currently `(request, env)`).

### Worker endpoints (new)

Member-authed (`requireAuth`):
- `POST /tee-signs` — body `{courseId, hole, layoutId?, image (base64 data URL)}`. Validate, R2 put,
  insert candidate row, `ctx.waitUntil(extract)`, return the row. RATELIMIT (e.g. 10/min/member).
- `GET /my-tee-signs` — caller's uploads + statuses.
- `GET /tee-signs/:id/image` — official → public; candidate → requires auth (blob-fetch from members/admin).
- `GET /courses/:id/tee-signs` — official signs per hole (+ candidates for authed members), for render.

Admin (`adminGate`):
- `GET /admin/tee-signs?status=candidate` — review queue.
- `POST /admin/tee-signs/:id/approve` — body `{par, distance_ft, tee?, target?, layoutId}` → official.
  Because a sign may have a null `layout_id`, approval **targets a concrete layout**: `layoutId` from the
  body, defaulting to the course's primary/default layout (admin can pick another). The confirmed values are
  written into that layout's hole; prior official sign for the same course+hole is demoted.
- `POST /admin/tee-signs/:id/reject`, `DELETE /admin/tee-signs/:id`.
- `POST /admin/tee-signs/:id/extract` — re-run vision (when a free model was unavailable at upload time).

### Worker modules

- **`src/photos.ts`** (new) — R2 put/get + image validation: **magic-byte sniff** (jpeg/png/webp only,
  **reject SVG**), size cap, UUID key generation. Keeps `index.ts` (already ~1080 lines) from growing.
- **`src/vision.ts`** (new) — the extraction provider chain above.
- **`src/db.ts`** — `tee_signs` CRUD + `setHoleFromTeeSign(layoutId, hole, par, distance, key)` (called by
  approve with the resolved target `layoutId`) + `defaultLayoutForCourse(courseId)`.
- **`src/index.ts`** — route wiring + handlers (thin; logic in the modules above); thread `ctx`.

### Frontend

- **`tee-sign.js`** (new, T0) — pure `teeSignSvg({hole, par, distance_ft, distance_source, tee, target,
  courseName})` → themed (light/dark), XSS-safe (all text via DOM/escaping) SVG string. Reused everywhere a
  hole is shown. Works **today** from existing `course_layouts.holes`.
- **`gvdg-members.html`** — "📸 Capture a tee sign" flow: pick course + hole (camera capture on mobile),
  client resize/EXIF-strip (canvas re-encode), upload, show Crotts' guess, list my candidates.
- **`admin.html`** — "Tee Signs" review tab: candidate queue grouped by course/hole; photo + editable
  par/distance; Approve / Edit+Approve / Reject / Delete. Also a "Layouts" hook to see official signs.
- **`events.html` + `admin.html` live scoring** — render the official tee-sign photo + hole/par/distance
  overlay for the current hole; SVG fallback from layout data; placeholder + capture CTA when neither.

## Security

- Upload: `requireAuth` + RATELIMIT; magic-byte content-type allowlist (jpeg/png/webp), **SVG rejected**;
  size cap after client resize; **EXIF stripped** (client canvas re-encode drops it — removes the member-GPS
  leak); UUID R2 keys.
- Vision: output strictly parsed + clamped; raw stored for audit; never rendered as HTML; never auto-applied.
- Moderation: candidates are members-only and admin-rejectable/removable; only `adminGate` can make a sign
  official or edit scoring values.
- Serving: official images public with `nosniff` + correct content-type; candidate images only via authed
  blob fetch. No public bucket listing.

## Slicing (each slice = one PR through `/simplify` → `/code-review` → `/security-review` + live-verify)

- **T0 — SVG tee-sign render.** `tee-sign.js` pure component + render it in event detail and a layout/hole
  preview from existing data. No backend. *Live-verify:* light+dark, XSS-safe, correct for seeded courses.
- **T1 — Storage + upload backbone.** R2 binding, `0007` migration, `src/photos.ts`, `POST /tee-signs`,
  image serve, `GET /my-tee-signs`, admin list/approve(manual par)/reject/delete. **No AI yet.**
  *Live-verify:* upload → R2 → D1 → serve (official public / candidate authed) → approve writes the layout.
- **T2 — Crotts vision.** `src/vision.ts` + provider chain + `ctx.waitUntil` extraction + re-extract; admin
  queue shows editable AI guess. *Live-verify with real tee-sign photos:* extraction populates, fallbacks fire.
- **T3 — Member capture UI.** Mobile course+hole pick, camera capture, client resize/EXIF-strip, show guess,
  my-candidates. *Live-verify on a mobile viewport* (real camera/file input → upload → appears as candidate).
- **T4 — Render in scoring.** Official photo + overlay + SVG fallback + "unverified" badge on the live
  scorecard, event detail, and public leaderboard. *Live-verify during a real scored event* (scorekeeper sees
  the right sign per hole; viewer sees official only).

## Free-tier / provisioning (mostlysober252)

- `wrangler r2 bucket create gvdg-photos`; paste the `[[r2_buckets]]` binding (already in `wrangler.toml`).
- Vision works on the existing `AI` binding (Workers AI) with no new secret; optionally set
  `OPENROUTER_VISION_MODEL` to a free VL id (the existing `OPENROUTER_API_KEY` secret covers OpenRouter).
- D1: `0007` migration applied with the others. No new DB or paid plan needed.

## Verification (per CLAUDE.md — live, not just unit tests)

Each slice: vitest units (validation, mocked-provider vision parse/clamp, db, SVG pure fn) **and** a real
local drive via `wrangler dev --local` (R2/D1/AI), exercised in a browser — including a mobile viewport for
capture and a real scored event for render. Nothing is "done" until driven in the running app.

## Open follow-ups (not in this program)

- Auto-suggest course/hole from EXIF GPS or live-round context (MVP: member selects explicitly).
- Multiple official layouts per course sharing/different signs (MVP: one official sign per course+hole).
- Bulk "seed from members" event/competition to crowd-source a course in one outing.
