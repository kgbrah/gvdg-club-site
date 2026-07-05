# Admin: Promote / Demote Members to/from Admin

- **Date:** 2026-07-05
- **Status:** Design → pending user approval → implementation plan
- **Type:** Standalone feature (Cloudflare Worker + admin UI). **Independent of the Batch-3 a11y slices** — sequenced alongside them.

## 1. Goal

Admins can grant or revoke another member's admin rights **after** account creation.
Today `isAdmin` is only settable at member-creation (`POST /admin/members` with
`isAdmin:true`); there is no update path, so a mistaken flag or a later promotion requires
re-provisioning. Add an admin-gated role-toggle endpoint + a Members-tab control.

## 2. Current model (verified)

- `isAdmin?: boolean` on the roster `Member` record (`roster.ts:18`); **absent = not admin**
  (`createMember` only writes `isAdmin:true`, never `false`).
- Server-side authority is `adminGate` (`authz.ts`) — re-reads ROSTER on every request and
  requires `member.isAdmin===true`; **never trusts the JWT** (per `CLAUDE.md`).
- `club-admin-members.ts` (`handleAdminMembers`, all behind `adminGate`) already does
  `GET /admin/members` (list via `listMembers`), `POST /admin/members` (create),
  `POST /admin/members/reset-pin`. Read-modify-write pattern for a member is `getMember` →
  mutate → `kv.put(RECORD(id), JSON.stringify(m))` (see `setPin`/`resetMemberPin`).

## 3. Design

### 3.1 Roster helper (`roster.ts`)

```ts
/** Grant/revoke a member's admin flag. Read-modify-write; all other fields untouched.
 *  Clears the key entirely when false to match the "absent = not admin" convention.
 *  Returns the updated member, or null if the member doesn't exist. */
export async function setMemberAdmin(kv: KVLike, memberId: string, isAdmin: boolean): Promise<Member | null> {
  const m = await getMember(kv, memberId);
  if (!m) return null;
  if (isAdmin) m.isAdmin = true; else delete m.isAdmin;
  await kv.put(RECORD(memberId), JSON.stringify(m));
  return m;
}

/** Count current admins — used for last-admin protection. */
export async function countAdmins(kv: KVListLike): Promise<number> {
  return (await listMembers(kv)).filter((m) => m.isAdmin).length;
}
```

### 3.2 Endpoint (`club-admin-members.ts`)

`POST /admin/members/set-role`, body `{ memberId: string, isAdmin: boolean }` (admin-gated
upstream). New branch in `handleAdminMembers`:

1. validate `memberId` (`asStr`, 80) and `isAdmin === true|false`;
2. `target = getMember(env.ROSTER, memberId)`; **404** `not_found` if absent;
3. **Last-admin protection:** if demoting (`!isAdmin`) and `target.isAdmin===true`, refuse
   with **409** `last_admin` when `countAdmins() <= 1`. This *also* covers self-demote: the
   only-admin demoting themselves is exactly the last-admin case and is blocked; with ≥2
   admins, self-demote is allowed.
4. `setMemberAdmin(...)`; return `{ member: pub(updated) }` (the existing public-safe view).
5. **Idempotent:** setting the flag to its current value succeeds as a no-op 200.

**Audit:** thread the acting admin's `memberId` into `handleAdminMembers` (currently
`(request, env, origin, method, seg)` — add the `claims`/actor already resolved by
`adminGate` at the `club-admin-routes.ts` call site) and emit one structured
`console.log({evt:'role_change', actor, target: memberId, isAdmin})` (Workers observability
captures it). No new D1 table for v1.

### 3.3 Admin UI (`admin.html` Members tab)

Per member row in the Members list: an **admin badge** when `isAdmin`, and a button —
**"Make admin"** (not admin) / **"Remove admin"** (admin, enabled only if not the last admin).
On click: a confirm step (extra-explicit for self-demote: "You'll lose admin access"), then
`POST /admin/members/set-role`, then re-render the list and surface the result. Disable the
button while the request is in flight. Map `last_admin` → "Can't remove the last admin."
(This UI is intentionally **self-contained**; it does not depend on the Batch-3 a11y modal —
it can adopt `GVDGa11y` later.)

## 4. Security & invariants

- Authority stays with `adminGate` (server-side ROSTER `isAdmin`); the endpoint adds no new
  trust surface. Only `memberId` + boolean cross the wire; no PIN/hash touched.
- Last-admin protection prevents self-lockout of the club.
- Closed-enrollment and PIN invariants are untouched (this never mints/rotates a PIN).
- The change takes effect immediately because `adminGate` re-reads ROSTER per request — a
  demoted admin's existing JWT stops passing `adminGate` on its next admin call (no token
  revocation needed).

## 5. Testing & live-verify

- **Worker unit (`vitest`, in `auth-worker/test/`):** `setMemberAdmin` promote then demote
  (flag set then key absent); `countAdmins`; the route — promote a member, demote back,
  **last-admin guard returns 409**, `not_found` 404, non-admin caller blocked by `adminGate`
  (already covered by the gate, assert the route is behind it), idempotent no-op.
- **Live-verify (required gate):** in the running admin app, promote a non-admin member →
  their next login shows the admin portal; demote them → admin routes 403; attempt to demote
  the last admin → blocked with the friendly message. Verify in light + dark, 0 console errors.

## 6. Out of scope

- Granular roles/permissions (single `isAdmin` boolean only).
- A dedicated D1 audit table (structured console log for v1).
- Bulk role changes.
