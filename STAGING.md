# Staging / dev environment — `gvdgclub.com`

A separate, isolated environment to **live-drive PRs before merging**. Production
(`greenvillediscgolf.com`) is never touched: staging is its own Worker
(`gvdg-member-auth-staging`) with its **own** KV/D1/R2, on **sandbox** PayPal.

```
gvdgclub.com  (Cloudflare Pages, dev branch)  ──►  auth.gvdgclub.com  ──►  gvdg-member-auth-staging
                                                                            └─ staging KV / D1 / R2 (isolated)
greenvillediscgolf.com (prod, later)          ──►  auth.greenvillediscgolf.com ──► gvdg-member-auth (prod data)
```

The frontend picks the backend by **hostname** (see "Frontend" below), so one codebase
serves prod, gvdgclub.com, `*.pages.dev` previews, and `localhost` with no per-deploy edits.

---

## 1. One-time Cloudflare setup (you — needs your account)

```bash
cd auth-worker && npm install
wrangler login                 # or set CLOUDFLARE_API_TOKEN (Edit Cloudflare Workers template)

# Create ISOLATED staging resources (separate from prod):
wrangler kv namespace create ROSTER       # → paste id → wrangler.toml  REPLACE_WITH_STAGING_ROSTER_KV_ID
wrangler kv namespace create RATELIMIT    # → paste id → wrangler.toml  REPLACE_WITH_STAGING_RATELIMIT_KV_ID
wrangler d1 create gvdg-staging           # → paste database_id → wrangler.toml  REPLACE_WITH_STAGING_D1_DATABASE_ID
wrangler r2 bucket create gvdg-photos-staging

# Apply the schema (creates all tables incl. pro-shop migration 0009):
npm run migrate:staging                   # = wrangler d1 migrations apply DB --env staging --remote

# Secrets for the staging Worker (NOT in git):
wrangler secret put JWT_SECRET --env staging            # any random >=32 chars
wrangler secret put OPENROUTER_API_KEY --env staging    # paste the OpenRouter key (already in .dev.vars for local)
#   PayPal Checkout stays OFF on staging unless you add BOTH (sandbox creds recommended):
# wrangler secret put PAYPAL_CLIENT_ID --env staging
# wrangler secret put PAYPAL_SECRET --env staging

# Deploy the staging Worker:
npm run deploy:staging                    # validates only the [env.staging] block, then wrangler deploy --env staging
```

Then in the **Cloudflare dashboard**: add the `gvdgclub.com` zone, and on the
`gvdg-member-auth-staging` Worker → **Settings → Domains & Routes → add Custom Domain
`auth.gvdgclub.com`**. `wrangler.toml` intentionally does not declare staging routes because
the deploy token only needs Worker permissions; the dashboard-owned custom domain stays attached.

> `npm run deploy:staging:dry-run` validates the config with placeholders allowed — useful before the ids are filled in.

## 2. Static dev site → Cloudflare Pages (you)

1. Cloudflare → **Pages → Create → Connect to Git** → this repo. Build command: none (static); output dir: repo root.
2. **Production branch** = `main` (later → `greenvillediscgolf.com`).
3. Every other branch/PR auto-builds to its own `*.pages.dev` preview URL — that's how devs live-drive a PR.
4. **Custom domains** → add `gvdgclub.com` (+ `www`), and alias it to your rolling **dev/integration branch** (Pages → the project → Custom domains / branch aliases). Push the PR you want to feature to that branch.

## 3. Frontend — already wired

`crotts.js`, `gvdg-members.html`, `events.html`, `admin.html`, and `pro-shop.html` now **resolve the
Worker base by hostname** (and the baked `data-*` attributes were blanked so they don't pin to prod).
Rule everywhere: an explicit `data-*` attribute wins (manual override) → else `greenvillediscgolf.com`/`www`
⇒ prod, **everything else (gvdgclub.com, `*.pages.dev`, localhost) ⇒ staging**. No per-deploy edits needed.

## 4. Seed a test roster (closed enrollment — no self-signup)

```bash
cd auth-worker
node scripts/provision.mjs --roster roster.json --out-dir ./out   # set admin:true for admins
wrangler kv bulk put ./out/kv-bulk.json --binding ROSTER --env staging
# default PINs are in out/default-pins.csv — hand out, then delete. Members force-change PIN on first login.
```

## Staging deploy loop
1. Push the branch you want to live-drive.
2. Run **Deploy to staging (gvdgclub.com)** from GitHub Actions, choosing that branch.
3. Devs live-drive `gvdgclub.com` / the preview URL against **isolated** dev data.
4. Merge to `main` when ready. Prod data remains untouched until production resource ids are configured.

> The staging CI needs only the `CLOUDFLARE_API_TOKEN` repo secret (same one prod uses). It does **not**
> sync app secrets — set those once with `wrangler secret put JWT_SECRET --env staging` (+ `OPENROUTER_API_KEY`,
> optional PayPal); Worker secrets persist across deploys. The workflow stays red until the
> `REPLACE_WITH_STAGING_*` ids are filled in `wrangler.toml`. Manual deploy any time: `npm run deploy:staging`.
> One shared staging slot — newest PR push wins; for true per-PR isolation you'd add per-PR Worker names later.

## Notes
- **Passkeys are per-domain.** Enroll separately on `gvdgclub.com`; PIN login works regardless.
- **WebAuthn origin must match.** `EXPECTED_ORIGIN=https://gvdgclub.com` assumes you serve the dev site at the **apex**. If you serve at `www.` or only via `*.pages.dev`, set `EXPECTED_ORIGIN` to that exact origin or passkeys there will fail (PIN still works).
- **PayPal.** Donation/fundraiser links already point to `paypal.me/greenvillediscgolf` (the club handle — real money). The Checkout API (event/shop card payments) stays in manual mode on staging until you add sandbox `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET`.
- **Crotts model.** Staging uses `nvidia/nemotron-3-ultra-550b-a55b:free` (best free Nemotron). It's large → occasionally slow; for snappier replies switch `OPENROUTER_MODEL` in `[env.staging.vars]` to `nvidia/nemotron-3-super-120b-a12b:free`. The OpenRouter key is on a $5/mo balance → free models are capped ~50 req/day.
- **Local dev:** `auth-worker/.dev.vars` (gitignored) already holds the OpenRouter key + a dev `JWT_SECRET` for `wrangler dev`.
