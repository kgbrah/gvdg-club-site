# Roster provisioning (slice B2)

`scripts/provision.mjs` turns a plain roster JSON file into the two artifacts an admin needs to
onboard GVDG members into the auth Worker's KV store:

1. **`kv-bulk.json`** — member records + login indexes, ready for `wrangler kv bulk put`.
   Values contain only the PBKDF2 **PIN hash**, never the cleartext PIN.
2. **`default-pins.csv`** — the cleartext one-time PIN for each member, for the admin to
   distribute. **This file is SENSITIVE** (see the security note below).

The script uses WebCrypto + Node stdlib only (no dependencies) and reproduces
`src/crypto.ts` `hashPin()` exactly (PBKDF2-HMAC-SHA256, 120,000 iterations, 16-byte random
salt, `pbkdf2$sha256$<iters>$<saltB64url>$<hashB64url>`), so a provisioned member's default PIN
verifies against the live Worker's `verifyPin()`.

## Roster input format

A JSON array of members. Each entry needs `name` plus **at least one** of `pdgaNo` / `udisc`:

```json
[
  { "name": "Jane Doe",  "pdgaNo": "12345", "udisc": "JaneD" },
  { "name": "Marcus Lee", "pdgaNo": "67890" },
  { "name": "Priya Nair", "udisc": "PriyaThrows" }
]
```

See `roster.sample.json`. The `memberId` is derived deterministically:
`m_<pdga-digits>` when a PDGA# is present, otherwise `m_u_<udisc-lowercased>`. It is stable
across re-runs, so re-provisioning the same roster overwrites the same KV records.

## Run

```bash
node scripts/provision.mjs --roster roster.sample.json --out-dir ./out
```

Then load the records into KV (remote, or add `--local` for the dev KV):

```bash
wrangler kv bulk put ./out/kv-bulk.json --binding ROSTER
```

The script prints a summary: member count, the output paths, the KV entry count, and the
sensitivity warning.

## Reset one member's PIN

To regenerate a single member's default PIN (e.g. they lost it before first login), pass
`--reset` with their PDGA# or UDisc username. It re-emits only that member's KV record/indexes
and a one-row `default-pins.csv`:

```bash
node scripts/provision.mjs --reset 12345 --roster roster.sample.json --out-dir ./out
wrangler kv bulk put ./out/kv-bulk.json --binding ROSTER   # overwrites just that member
```

This sets `mustChangePin: true` again, so the member is forced to choose a new PIN at next login.

## How an admin distributes PINs + the forced-change flow

1. Run the provisioner and load `kv-bulk.json` into the `ROSTER` KV namespace.
2. From `default-pins.csv`, give each member their `defaultPIN` over a **secure, person-specific
   channel** (in person, or a 1:1 message — never a shared spreadsheet, email blast, or anything
   committed to git).
3. The member logs in at the portal with their PDGA# **or** UDisc username + that default PIN.
4. Because every provisioned record has `mustChangePin: true`, the Worker/site forces a PIN
   change on that first successful login before issuing a usable session. Setting the new PIN
   clears `mustChangePin` (handled by `setPin()` in `src/roster.ts`). The default PIN is now dead.
5. Once all PINs are handed out, **delete `default-pins.csv`**.

## SECURITY — keep these out of git

The repo `.gitignore` already ignores `seed.local.json`. The provisioning outputs must be treated
**the same way** — do not commit them, and ignore them locally:

- `out/` (the default `--out-dir`)
- `default-pins.csv` — **cleartext one-time PINs**; the most sensitive artifact. Distribute over a
  secure channel and delete it once PINs are handed out.
- `kv-bulk.json` — contains only PIN **hashes** (not cleartext), but a 4-digit PIN hash is
  brute-forceable offline, so keep this private too. The real defenses are never leaking the KV
  roster and the Worker's server-side rate-limiting / lockout (`src/ratelimit.ts`).

> This note intentionally does **not** edit `.gitignore` (out of scope for slice B2). An operator
> should add `out/`, `kv-bulk.json`, and `default-pins.csv` to `.gitignore` (alongside the existing
> `seed.local.json`) before running the tool in a real checkout.
