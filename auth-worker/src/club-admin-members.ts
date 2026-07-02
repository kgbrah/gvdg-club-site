import type { Env } from "./env.js";
import { json, readJson } from "./http.js";
import { asStr } from "./input.js";
import { generatePin, hashPin } from "./crypto.js";
import { createMember, listMembers, resetMemberPin, type AdminMember, type Member } from "./roster.js";

// Admin member onboarding: create a member (or reissue) and return a one-time TEMPORARY PIN for the
// admin to hand off. The member logs in with PDGA#/UDisc + temp PIN, then is forced to set their own
// PIN (mustChangePin). Admin-gated upstream by handleClubAdmin -> adminGate. The cleartext temp PIN is
// returned ONLY in this authenticated response (never stored, never logged); KV holds only the hash.

const PDGA_RE = /^\d{1,12}$/;
const UDISC_RE = /^[A-Za-z0-9._-]{1,50}$/;

function pub(m: Member | AdminMember) {
  return { memberId: m.memberId, name: m.name, pdgaNo: m.pdgaNo ?? null, udisc: m.udisc ?? null, isAdmin: m.isAdmin === true, mustChangePin: m.mustChangePin };
}

export async function handleAdminMembers(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
): Promise<Response | null> {
  // GET /admin/members — list members (public-safe fields, never the PIN hash)
  if (method === "GET" && seg.length === 2) {
    return json({ members: await listMembers(env.ROSTER) }, 200, origin);
  }

  // POST /admin/members — create a NEW member and issue a temporary PIN
  if (method === "POST" && seg.length === 2) {
    const b = (await readJson(request)) ?? {};
    const name = asStr(b.name, 80);
    const pdgaNo = asStr(b.pdgaNo, 12);
    const udisc = asStr(b.udisc, 50);
    const isAdmin = b.isAdmin === true;
    const adminGrantConfirmed = b.confirm_admin_grant === true;
    if (!name) return json({ error: "name_required" }, 400, origin);
    if (!pdgaNo && !udisc) return json({ error: "pdga_or_udisc_required" }, 400, origin);
    if (pdgaNo && !PDGA_RE.test(pdgaNo)) return json({ error: "invalid_pdga" }, 400, origin);
    if (udisc && !UDISC_RE.test(udisc)) return json({ error: "invalid_udisc" }, 400, origin);
    if (isAdmin && !adminGrantConfirmed) return json({ error: "admin_grant_confirmation_required" }, 409, origin);

    const tempPin = generatePin();
    const result = await createMember(env.ROSTER, { name, pdgaNo, udisc, isAdmin }, await hashPin(tempPin));
    if (!result.ok) return json({ error: "member_" + result.reason }, result.reason === "invalid" ? 400 : 409, origin);
    return json({ tempPin, member: pub(result.member) }, 201, origin);
  }

  // POST /admin/members/reset-pin — reissue a temporary PIN for an EXISTING member
  if (method === "POST" && seg.length === 3 && seg[2] === "reset-pin") {
    const b = (await readJson(request)) ?? {};
    const identifier = asStr(b.identifier, 60);
    if (!identifier) return json({ error: "identifier_required" }, 400, origin);
    if (b.confirm_member_pin_reset !== true) return json({ error: "member_pin_reset_confirmation_required" }, 409, origin);

    const tempPin = generatePin();
    const m = await resetMemberPin(env.ROSTER, identifier, await hashPin(tempPin));
    if (!m) return json({ error: "not_found" }, 404, origin);
    return json({ tempPin, member: pub(m) }, 200, origin);
  }

  return null;
}
