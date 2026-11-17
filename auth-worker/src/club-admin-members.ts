import type { Env } from "./env.js";
import { json, readJson } from "./http.js";
import { asStr } from "./input.js";
import { generatePin, hashPin } from "./crypto.js";
import { createMember, listMembers, resetMemberPin, getMember, setMemberAdmin, countAdmins, deleteMember, setMemberThroughYear, putMember, type AdminMember, type KVListLike, type Member } from "./roster.js";
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
    return json({ tempPin, member: pub(result.member) }, 201, origin);
  }

  // POST /admin/members/reset-pin — reissue a temporary PIN for an EXISTING member
  if (method === "POST" && seg.length === 3 && seg[2] === "reset-pin") {
    const b = (await readJson(request)) ?? {};
    const identifier = asStr(b.identifier, 60);
    if (!identifier) return json({ error: "identifier_required" }, 400, origin);

    const tempPin = generatePin();
    const m = await resetMemberPin(env.ROSTER, identifier, await hashPin(tempPin, env.PIN_PEPPER));
    if (!m) return json({ error: "not_found" }, 404, origin);
    return json({ tempPin, member: pub(m) }, 200, origin);
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
    try {
      await env.DB.prepare("DELETE FROM member_push_subscriptions WHERE member_id = ?").bind(memberId).run();
    } catch { /* push rows are optional */ }
    console.log(JSON.stringify({ evt: "member_removed", actor: adminId, target: memberId, at: Date.now() }));
    return json({ ok: true, memberId }, 200, origin);
  }

  return null;
}
