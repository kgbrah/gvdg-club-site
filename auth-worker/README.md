# GVDG member auth Worker

Cloudflare Worker that authenticates club members for the static GitHub Pages site
(`www.greenvillediscgolf.com`). Members log in with their **PDGA #** *or* **UDisc username**
plus a **PIN**; the Worker issues a short-lived signed JWT the members page stores and replays.

This is slice **B1** (auth API). Roster provisioning is **B2**; passkeys/WebAuthn are **B3**.

## Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/login` | `{ identifier, pin }` | `200 {token, mustChangePin, name}` · `401` bad creds · `423` locked (`Retry-After`) · `400` malformed |
| `GET` | `/me` | — (Bearer token) | `200 {sub, mustChangePin}` · `401` |
| `POST` | `/set-pin` | `{ newPin }` (Bearer token) | `200 {token, mustChangePin:false}` · `400` bad format · `401` |
| `OPTIONS` | `*` | — | `204` CORS preflight |

## Security model
- **PIN entropy is only 10⁴.** The hash alone is always brute-forceable offline, so the real
  controls are (1) never leaking the KV roster and (2) **server-side rate-limiting + lockout**
  (`ratelimit.ts`: 5 attempts → 15-min lock). PBKDF2 (120k iters, WebCrypto) is defense-in-depth.
- JWT is HS256 via `jose`, signed with the `JWT_SECRET` secret, 15-min TTL.
- CORS is allow-listed to the club origins; unknown identifiers return the same `401` as a wrong
  PIN (no user enumeration) and run a dummy hash to equalize timing.
- Known tradeoff: lockout is keyed per identifier, so a griefer could lock a known member for
  15 min (account-lockout DoS). Acceptable at club scale; a future pass can add a per-IP tier.

## Deploy (mostlysober252)
```bash
cd auth-worker
npm install
wrangler kv namespace create ROSTER       # paste the id into wrangler.toml
wrangler kv namespace create RATELIMIT     # paste the id into wrangler.toml
wrangler secret put JWT_SECRET             # a long random string
wrangler deploy
```
Then seed the roster (slice B2 tool) and point the members page at the Worker URL.

## Local development & verification
```bash
npm test                                   # 35 unit tests (vitest)
npx tsc --noEmit                           # typecheck

# live-drive the real Worker:
echo 'JWT_SECRET=local-dev-secret-at-least-32-bytes-long' > .dev.vars
node scripts/dev-seed.mjs 12345 JaneD 4821 "Jane Doe" > seed.local.json
npx wrangler kv bulk put seed.local.json --binding ROSTER --local
npx wrangler dev --local
# curl http://127.0.0.1:8788/login -d '{"identifier":"12345","pin":"4821"}' -H 'Origin: https://www.greenvillediscgolf.com'
```
