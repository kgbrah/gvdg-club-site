import type { Env } from "./env.js";
import { clearAccountLocks } from "./account-recovery.js";
import { releaseGuestPromo } from "./guest-accounts.js";
import { json, readJson } from "./http.js";
import { asStr } from "./input.js";
import { generatePin, hashPin } from "./crypto.js";
import { createMember, listMembers, resetMemberPin, getMember, setMemberAdmin, countAdmins, deleteMember, setMemberThroughYear, putMember, memberTier, setMemberTier, type AdminMember, type KVListLike, type Member, type MemberTier } from "./roster.js";
import { absorbHeld, carriedOverText, claimHeldFor } from "./held-accounts.js";
import { handleAdminMembershipApplications } from "./membership-apply.js";
import { membershipStatus } from "./membership-year.js";

// Admin member onboarding: create a member (or reissue) and return a one-time TEMPORARY PIN for the
// admin to hand off. The member logs in with PDGA#/UDisc + temp PIN, then is forced to set their own
// PIN (mustChangePin). Admin-gated upstream by handleClubAdmin -> adminGate. The cleartext temp PIN is
// returned ONLY in this authenticated response (never stored, never logged); KV holds only the hash.

const PDGA_RE = /^\d{1,12}$/;
const UDISC_RE = /^[A-Za-z0-9._-]{1,50}$/;

function pub(m: Member | AdminMember) {
  const status = membershipStatus(m);
  return {
    memberId: m.memberId,
    name: m.name,
    pdgaNo: m.pdgaNo ?? null,
    udisc: m.udisc ?? null,
    isAdmin: m.isAdmin === true,
    mustChangePin: m.mustChangePin,
    memberThroughYear: status.throughYear,
    membershipCurrent: status.current,
    renewalYear: status.renewalYear,
    tier: memberTier(m),
    held: m.held === true,
    // Guest accounts: how to reach them (admin-only), and whether they got a promo spot.
    email: m.email ?? null,
    phone: m.phone ?? null,
    guestPromo: m.guestPromo === true,
  };
}

export async function handleAdminMembers(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const applications = await handleAdminMembershipApplications(request, env, origin, method, seg, adminId, ctx);
  if (applications) return applications;

  // GET /admin/members — list members (public-safe fields, never the PIN hash)
  if (method === "GET" && seg.length === 2) {
    const members = await listMembers(env.ROSTER as unknown as KVListLike);
    return json({ members: members.map(pub) }, 200, origin);
  }

  // POST /admin/members — create a NEW member and issue a temporary PIN
  if (method === "POST" && seg.length === 2) {
    const b = (await readJson(request)) ?? {};
    const name = asStr(b.name, 80);
    const pdgaNo = asStr(b.pdgaNo, 12);
    const udisc = asStr(b.udisc, 50);
    const isAdmin = b.isAdmin === true;
    if (!name) return json({ error: "name_required" }, 400, origin);
    if (!pdgaNo && !udisc) return json({ error: "pdga_or_udisc_required" }, 400, origin);
    if (pdgaNo && !PDGA_RE.test(pdgaNo)) return json({ error: "invalid_pdga" }, 400, origin);
    if (udisc && !UDISC_RE.test(udisc)) return json({ error: "invalid_udisc" }, 400, origin);

    const tempPin = generatePin();
    const result = await createMember(env.ROSTER, { name, pdgaNo, udisc, isAdmin }, await hashPin(tempPin, env.PIN_PEPPER));
    if (!result.ok) return json({ error: "member_" + result.reason }, result.reason === "invalid" ? 400 : 409, origin);
    // Someone already on the club's sheets: their held account (store credit, dues, bag tag) comes across.
    const carried = await claimHeldFor(env, result.member, adminId);
    const member = carried ? (await getMember(env.ROSTER, result.member.memberId)) ?? result.member : result.member;
    // Clear any lingering login lockouts from before a previous removal so the new temp PIN works right away.
    try { await clearAccountLocks(env, member); } catch { /* lockouts are best-effort */ }
    return json({ tempPin, member: pub(member), carriedOver: carriedOverText(carried) || null }, 201, origin);
  }

  // POST /admin/members/reset-pin — reissue a temporary PIN for an EXISTING member
  if (method === "POST" && seg.length === 3 && seg[2] === "reset-pin") {
    const b = (await readJson(request)) ?? {};
    const identifier = asStr(b.identifier, 60);
    if (!identifier) return json({ error: "identifier_required" }, 400, origin);

    const tempPin = generatePin();
    const m = await resetMemberPin(env.ROSTER, identifier, await hashPin(tempPin, env.PIN_PEPPER));
    if (!m) return json({ error: "not_found" }, 404, origin);
    // Clear lockouts alongside issuing a temp PIN so an admin reset lets the member sign in right away.
    try { await clearAccountLocks(env, m); } catch { /* lockouts are best-effort */ }
    return json({ tempPin, member: pub(m) }, 200, origin);
  }

  // POST /admin/members/clear-locks { memberId } — clear everything that can keep a member out (wrong-PIN lockouts,
  // the email step's limits, Forgot PIN requests), so an admin can let them straight back in.
  if (method === "POST" && seg.length === 3 && seg[2] === "clear-locks") {
    const b = (await readJson(request)) ?? {};
    const memberId = asStr(b.memberId, 80);
    if (!memberId) return json({ error: "member_required" }, 400, origin);
    const target = await getMember(env.ROSTER, memberId);
    if (!target) return json({ error: "not_found" }, 404, origin);
    return json({ cleared: await clearAccountLocks(env, target), member: pub(target) }, 200, origin);
  }

  // POST /admin/members/set-tier — Admin, Member or Guest (assigned by an admin; last-admin protected). Not for held
  // accounts: they get a tier when the player sets up their account.
  if (method === "POST" && seg.length === 3 && seg[2] === "set-tier") {
    const b = (await readJson(request)) ?? {};
    const memberId = asStr(b.memberId, 80);
    const tier = b.tier === "admin" || b.tier === "member" || b.tier === "guest" ? b.tier as MemberTier : null;
    if (!memberId) return json({ error: "member_required" }, 400, origin);
    if (!tier) return json({ error: "invalid_tier" }, 400, origin);
    const target = await getMember(env.ROSTER, memberId);
    if (!target) return json({ error: "not_found" }, 404, origin);
    if (target.held === true && tier === "admin") return json({ error: "held_account" }, 409, origin);
    const was = memberTier(target);
    if (was === tier) return json({ member: pub(target) }, 200, origin);
    if (was === "admin" && (await countAdmins(env.ROSTER as unknown as KVListLike)) <= 1) return json({ error: "last_admin" }, 409, origin);
    const updated = await setMemberTier(env.ROSTER, memberId, tier);
    if (!updated) return json({ error: "not_found" }, 404, origin);
    if (was === "admin" && (await countAdmins(env.ROSTER as unknown as KVListLike)) === 0) {
      await setMemberTier(env.ROSTER, memberId, "admin");
      return json({ error: "last_admin" }, 409, origin);
    }
    if (was === "guest" && tier !== "guest") {
      try { await releaseGuestPromo(env, memberId); } catch { /* promo row optional */ }
    }
    console.log(JSON.stringify({ evt: "tier_change", actor: adminId, target: memberId, from: was, to: tier, at: Date.now() }));
    return json({ member: pub(updated) }, 200, origin);
  }

  // POST /admin/members/lapsed-to-guest — move lapsed members (not admins, not held accounts) to the Guest tier, bounded per call.
  if (method === "POST" && seg.length === 3 && seg[2] === "lapsed-to-guest") {
    const LAPSED_BATCH = 25;
    const lapsed = (await listMembers(env.ROSTER as unknown as KVListLike))
      .filter((m) => m.isAdmin !== true && m.held !== true && m.guest !== true && membershipStatus(m).lapsed);
    const batch = lapsed.slice(0, LAPSED_BATCH);
    for (const m of batch) await setMemberTier(env.ROSTER, m.memberId, "guest");
    const remaining = lapsed.length - batch.length;
    console.log(JSON.stringify({ evt: "lapsed_to_guest", actor: adminId, count: batch.length, remaining, at: Date.now() }));
    return json(remaining > 0 ? { moved: batch.length, remaining } : { moved: batch.length }, 200, origin);
  }

  // POST /admin/members/link-held — a held account (from the sheets) is a member already in the app under another
  // name: move its store credit, dues and bag tag onto that member and remove it.
  if (method === "POST" && seg.length === 3 && seg[2] === "link-held") {
    const b = (await readJson(request)) ?? {};
    const heldId = asStr(b.heldId, 80);
    const memberId = asStr(b.memberId, 80);
    if (!heldId || !memberId) return json({ error: "member_required" }, 400, origin);
    const target = await getMember(env.ROSTER, memberId);
    if (!target || target.held === true) return json({ error: "not_found" }, 404, origin);
    const carried = await absorbHeld(env, heldId, target, adminId);
    if (!carried) return json({ error: "not_held" }, 409, origin);
    return json({ member: pub((await getMember(env.ROSTER, memberId)) ?? target), carriedOver: carriedOverText(carried) }, 200, origin);
  }

  // POST /admin/members/set-role — promote/demote an existing member (last-admin protected)
  if (method === "POST" && seg.length === 3 && seg[2] === "set-role") {
    const b = (await readJson(request)) ?? {};
    const memberId = asStr(b.memberId, 80);
    if (!memberId) return json({ error: "member_required" }, 400, origin);
    if (typeof b.isAdmin !== "boolean") return json({ error: "isAdmin_required" }, 400, origin);
    const isAdmin = b.isAdmin;

    const target = await getMember(env.ROSTER, memberId);
    if (!target) return json({ error: "not_found" }, 404, origin);

    const was = target.isAdmin === true;
    // No state change: return without writing or logging (avoids phantom audit entries).
    if (was === isAdmin) return json({ member: pub(target) }, 200, origin);

    // Never remove the final admin — also blocks the sole admin from self-demoting.
    if (!isAdmin) {
      const admins = await countAdmins(env.ROSTER as unknown as KVListLike);
      if (admins <= 1) return json({ error: "last_admin" }, 409, origin);
    }

    const updated = await setMemberAdmin(env.ROSTER, memberId, isAdmin);
    if (!updated) return json({ error: "not_found" }, 404, origin);

    // Defense-in-depth: the count-then-write guard above is NOT atomic on eventually-consistent KV,
    // so a concurrent demote could slip past it and drop the club to zero admins. Re-check after the
    // write and roll this demotion back if it removed the last admin, converging to a safe state.
    // (A single-writer Durable Object owning the admin count is the fully race-free fix — follow-up.)
    if (!isAdmin) {
      const remaining = await countAdmins(env.ROSTER as unknown as KVListLike);
      if (remaining === 0) {
        await setMemberAdmin(env.ROSTER, memberId, true);
        return json({ error: "last_admin" }, 409, origin);
      }
    }

    console.log(JSON.stringify({ evt: "role_change", actor: adminId, target: memberId, from: was, to: isAdmin, at: Date.now() }));
    return json({ member: pub(updated) }, 200, origin);
  }

  // POST /admin/members/renew — mark one more calendar year paid. One year at a time, never past next year.
  if (method === "POST" && seg.length === 3 && seg[2] === "renew") {
    const b = (await readJson(request)) ?? {};
    const memberId = asStr(b.memberId, 80);
    if (!memberId) return json({ error: "member_required" }, 400, origin);
    const target = await getMember(env.ROSTER, memberId);
    if (!target) return json({ error: "not_found" }, 404, origin);
    const status = membershipStatus(target);
    if (status.renewalYear == null) return json({ error: "already_renewed" }, 409, origin);
    const updated = await setMemberThroughYear(env.ROSTER, memberId, status.renewalYear);
    if (!updated) return json({ error: "not_found" }, 404, origin);
    console.log(JSON.stringify({ evt: "member_renewed", actor: adminId, target: memberId, throughYear: status.renewalYear, at: Date.now() }));
    return json({ member: pub(updated) }, 200, origin);
  }

  // POST /admin/members/remove — drop a login. Not yourself, and never the last admin.
  if (method === "POST" && seg.length === 3 && seg[2] === "remove") {
    const b = (await readJson(request)) ?? {};
    const memberId = asStr(b.memberId, 80);
    if (!memberId) return json({ error: "member_required" }, 400, origin);
    const target = await getMember(env.ROSTER, memberId);
    if (!target) return json({ error: "not_found" }, 404, origin);
    if (target.isAdmin === true) {
      const admins = await countAdmins(env.ROSTER as unknown as KVListLike);
      if (admins <= 1) return json({ error: "last_admin" }, 409, origin);
    }
    if (memberId === adminId) return json({ error: "self" }, 409, origin);
    const removed = await deleteMember(env.ROSTER, memberId);
    if (!removed) return json({ error: "not_found" }, 404, origin);
    if (removed.isAdmin === true) {
      const remaining = await countAdmins(env.ROSTER as unknown as KVListLike);
      if (remaining === 0) {
        await putMember(env.ROSTER, removed);
        return json({ error: "last_admin" }, 409, origin);
      }
    }
    if (await env.ROSTER.get(`wa:creds:${memberId}`)) await env.ROSTER.delete(`wa:creds:${memberId}`);
    try { await releaseGuestPromo(env, memberId); } catch { /* promo row optional */ }
    try {
      await env.DB.prepare("DELETE FROM member_push_subscriptions WHERE member_id = ?").bind(memberId).run();
    } catch { /* push rows are optional */ }
    console.log(JSON.stringify({ evt: "member_removed", actor: adminId, target: memberId, at: Date.now() }));
    return json({ ok: true, memberId }, 200, origin);
  }

  return null;
}
