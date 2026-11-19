// Member roster stored in Workers KV.
//
// Layout:
//   member:<memberId>      -> JSON Member record (the source of truth)
//   idx:pdga:<digits>      -> memberId  (login-by-PDGA# index)
//   idx:udisc:<lowercase>  -> memberId  (login-by-UDisc-username index)

import type { KVLike } from "./ratelimit.js";
import { easternCalendarYear } from "./membership-year.js";

export interface Member {
  memberId: string;
  name: string;
  pdgaNo?: string;
  udisc?: string;
  /** Profile photo: a pdga.com URL (auto) or a small data-URL (member upload). */
  photo?: string;
  /** Club admin — may manage events/courses/leagues/etc. Granted by an admin via provisioning. */
  isAdmin?: boolean;
  pinHash: string;
  mustChangePin: boolean;
  /** Monotonic PIN-version. Bumped on every PIN change/reset so tokens minted earlier are rejected
   *  server-side (see authz.requireAuth). Absent = 0 for legacy records. */
  pinVer?: number;
  /** Set when an admin approves a membership application; cleared once the one-time welcome card is seen. */
  welcomePending?: boolean;
  /** Last calendar year (America/New_York) this membership covers. Absent = paid through 2026. */
  memberThroughYear?: number;
  /** Account tier "guest" (set by an admin): signs in and plays, but isn't a dues-paying club member. */
  guest?: boolean;
  /**
   * A held account: someone on the club's Google Sheets who hasn't set up a sign-in yet. It holds their imported
   * store credit, dues and bag tag. It has no PIN and no login index, so it can never sign in; when the player
   * sets up their account (an approved application, or an admin adding them) it's matched and carried over
   * (held-accounts.ts).
   */
  held?: boolean;
  /** Guest accounts sign in with their email (idx:email) and must give a phone; private, admin-only. */
  email?: string;
  phone?: string;
  /** One of the first 100 approved guest applications (guest_promo): round history and stats like a member. */
  guestPromo?: boolean;
}

/** Round history and stats: members and admins, and guests who got a promo spot. */
export function hasHistoryAccess(m: Pick<Member, "isAdmin" | "guest" | "guestPromo"> | null | undefined): boolean {
  if (!m) return false;
  return m.isAdmin === true || m.guest !== true || m.guestPromo === true;
}

export type MemberTier = "admin" | "member" | "guest";

export function memberTier(m: Pick<Member, "isAdmin" | "guest"> | null | undefined): MemberTier {
  if (m?.isAdmin === true) return "admin";
  return m?.guest === true ? "guest" : "member";
}

/** "Jordan Parker" for "jordan  parker", "Parker, Jordan" or "Jordan Parker Jr."-style punctuation. */
export function normalizePersonName(name: string | null | undefined): string {
  let text = String(name ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const comma = text.match(/^([^,]+),\s*([^,]+)$/);
  if (comma) text = `${comma[2]} ${comma[1]}`;
  return text.replace(/[^a-z0-9' -]+/g, " ").replace(/['-]/g, "").replace(/\s+/g, " ").trim();
}

function fnv64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

/** A held account's id: from its PDGA # or UDisc name when the sheet has one, else its name (so re-importing finds it). */
export function heldMemberIdFor(input: { name: string; pdgaNo?: string | null; udisc?: string | null }): string {
  const pdga = input.pdgaNo ? normPdga(input.pdgaNo) : "";
  if (pdga) return `m_h_p${pdga}`;
  const udisc = input.udisc ? normUdisc(input.udisc) : "";
  if (udisc) return `m_h_u${udisc}`;
  return `m_h_n${fnv64(normalizePersonName(input.name))}`;
}

export function isHeldMemberId(memberId: string): boolean {
  return memberId.startsWith("m_h_");
}

/** Create (or find) the held account for someone on the sheets. No PIN, no login index: it can't sign in. */
export async function createHeldMember(
  kv: KVLike,
  input: { name: string; pdgaNo?: string | null; udisc?: string | null; guest?: boolean },
): Promise<{ member: Member; created: boolean }> {
  const memberId = heldMemberIdFor(input);
  const existing = await getMember(kv, memberId);
  if (existing) return { member: existing, created: false };
  const pdga = input.pdgaNo ? normPdga(input.pdgaNo) : "";
  const udisc = input.udisc ? String(input.udisc).trim() : "";
  const m: Member = {
    memberId,
    name: input.name.trim(),
    ...(pdga ? { pdgaNo: pdga } : {}),
    ...(udisc ? { udisc } : {}),
    ...(input.guest ? { guest: true } : {}),
    held: true,
    pinHash: "",
    mustChangePin: true,
    memberThroughYear: easternCalendarYear(),
  };
  await kv.put(RECORD(memberId), JSON.stringify(m));
  return { member: m, created: true };
}

/** Write a member record as is (no index changes). For admin edits of fields that aren't login identifiers. */
export async function saveMemberRecord(kv: KVLike, m: Member): Promise<void> {
  await kv.put(RECORD(m.memberId), JSON.stringify(m));
}

/** Set an account's tier. The caller guards the last admin. */
export async function setMemberTier(kv: KVLike, memberId: string, tier: MemberTier): Promise<Member | null> {
  const m = await getMember(kv, memberId);
  if (!m) return null;
  if (tier === "admin") m.isAdmin = true;
  else delete m.isAdmin;
  if (tier === "guest") m.guest = true;
  else delete m.guest;
  await kv.put(RECORD(memberId), JSON.stringify(m));
  return m;
}

export type ProfilePatch = { pdgaNo?: string | null; udisc?: string | null; photo?: string | null };
export type UpdateResult = { ok: true; member: Member } | { ok: false; conflict: "pdga" | "udisc" };

const RECORD = (id: string) => `member:${id}`;
const IDX_PDGA = (n: string) => `idx:pdga:${normPdga(n)}`;
const IDX_UDISC = (u: string) => `idx:udisc:${normUdisc(u)}`;
const IDX_EMAIL = (e: string) => `idx:email:${normEmail(e)}`;

function normEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** Text on both sides of an "@" (so "@name", the way UDisc shows usernames, is a UDisc name, not an email). */
function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(s.trim());
}

function normPdga(s: string): string {
  return s.replace(/\D/g, "");
}
function normUdisc(s: string): string {
  return s.trim().toLowerCase();
}

/** The PDGA # a sign-in name stands for ("80024", "#80024", "PDGA 80024", "80-024"), or "" for anything else - so a UDisc
 *  name with digits in it ("discgolfer2019") is never read as PDGA #2019 (a wrong-PIN for the player, a lockout and
 *  a false "already a member" for whoever holds that number). */
function pdgaOf(s: string): string {
  return /^\s*(?:pdga\s*)?#?\s*\d[\d\s.-]*$/i.test(s) ? normPdga(s) : "";
}

/** UDisc shows usernames as "@name"; sign-in takes either form. */
function bareUdisc(s: string): string {
  return normUdisc(s).replace(/^@+/, "");
}

/**
 * Canonical lockout / rate-limit key for a login identifier, using the SAME normalization
 * resolveMember applies. Every punctuation variant of one PDGA# ("1-2345", "1.2345", "12345x")
 * collapses to a single `pdga:<digits>` key, and any casing of a UDisc name to one `udisc:<lc>` key —
 * so an attacker can't reset the per-identifier lockout by mutating the raw identifier string.
 */
export function canonicalLoginKey(identifier: string): string {
  if (isEmail(identifier)) return `email:${normEmail(identifier)}`;
  const digits = pdgaOf(identifier);
  return digits ? `pdga:${digits}` : `udisc:${bareUdisc(identifier)}`;
}

/** Write a member record and its login indexes. Used by the admin seeding script. */
export async function putMember(kv: KVLike, m: Member): Promise<void> {
  await kv.put(RECORD(m.memberId), JSON.stringify(m));
  if (m.held === true) return; // a held account has no sign-in
  if (m.pdgaNo) await kv.put(IDX_PDGA(m.pdgaNo), m.memberId);
  if (m.udisc) await kv.put(IDX_UDISC(m.udisc), m.memberId);
  if (m.email) await kv.put(IDX_EMAIL(m.email), m.memberId);
}

export async function getMember(kv: KVLike, memberId: string): Promise<Member | null> {
  const raw = await kv.get(RECORD(memberId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Member;
  } catch {
    return null;
  }
}

/**
 * Resolve a member by either a PDGA # or a UDisc username.
 * Tries the PDGA index first, then the UDisc index, so a single login field accepts both.
 */
export async function resolveMember(kv: KVLike, identifier: string): Promise<Member | null> {
  const id = identifier.trim();
  if (!id) return null;
  // An email signs in by its own index only (an email with digits must never be read as a PDGA #).
  if (isEmail(id)) {
    const byEmail = await kv.get(IDX_EMAIL(id));
    return byEmail ? getMember(kv, byEmail) : null;
  }

  const pdgaDigits = pdgaOf(id);
  if (pdgaDigits) {
    const memberId = await kv.get(IDX_PDGA(pdgaDigits));
    if (memberId) return getMember(kv, memberId);
  }
  const memberId = await kv.get(IDX_UDISC(id)) ?? (bareUdisc(id) !== normUdisc(id) ? await kv.get(IDX_UDISC(bareUdisc(id))) : null);
  if (memberId) return getMember(kv, memberId);

  return null;
}

/** Replace a member's PIN hash, clear the forced-change flag, and bump pinVer so every token issued
 *  before this change is revoked. Returns the new pinVer so the caller can mint a fresh, valid token. */
export async function setPin(kv: KVLike, memberId: string, pinHash: string): Promise<number> {
  const m = await getMember(kv, memberId);
  if (!m) throw new Error(`unknown member: ${memberId}`);
  m.pinHash = pinHash;
  m.mustChangePin = false;
  m.pinVer = (m.pinVer ?? 0) + 1;
  await kv.put(RECORD(memberId), JSON.stringify(m));
  return m.pinVer;
}

/** Grant or revoke a member's admin flag. Read-modify-write; all other fields untouched.
 *  Clears the key entirely when false to match the "absent = not admin" convention that
 *  createMember follows. Returns the updated member, or null if the member doesn't exist. */
export async function setMemberAdmin(kv: KVLike, memberId: string, isAdmin: boolean): Promise<Member | null> {
  const m = await getMember(kv, memberId);
  if (!m) return null;
  if (isAdmin) m.isAdmin = true;
  else delete m.isAdmin;
  await kv.put(RECORD(memberId), JSON.stringify(m));
  return m;
}

/** Replace ONLY a member's PIN hash (used for the transparent pepper re-hash on login). Unlike setPin,
 *  it leaves mustChangePin and pinVer untouched, so silently upgrading the hash never revokes the
 *  member's other sessions or re-triggers a forced change. No-op if the member vanished mid-request. */
export async function rehashPin(kv: KVLike, memberId: string, pinHash: string): Promise<void> {
  const m = await getMember(kv, memberId);
  if (!m) return;
  m.pinHash = pinHash;
  await kv.put(RECORD(memberId), JSON.stringify(m));
}

/**
 * Update a member's self-service profile fields (PDGA #, UDisc username, photo) and keep
 * the login indexes in sync. A field left `undefined` is unchanged; `null`/"" clears it.
 * Refuses to claim a PDGA #/UDisc already owned by a DIFFERENT member (identity-hijack guard);
 * conflicts are checked before any mutation so updates are all-or-nothing.
 */
export async function updateProfile(kv: KVLike, memberId: string, patch: ProfilePatch): Promise<UpdateResult> {
  const m = await getMember(kv, memberId);
  if (!m) throw new Error(`unknown member: ${memberId}`);

  const newPdga = patch.pdgaNo === undefined ? undefined : normPdga(String(patch.pdgaNo ?? "")) || null;
  // UDisc: keep the member's display casing on the record; index by lowercase (IDX_UDISC normalizes).
  const newUdisc = patch.udisc === undefined ? undefined : String(patch.udisc ?? "").trim() || null;

  if (newPdga) {
    const owner = await kv.get(IDX_PDGA(newPdga));
    if (owner && owner !== memberId) return { ok: false, conflict: "pdga" };
  }
  if (newUdisc) {
    const owner = await kv.get(IDX_UDISC(newUdisc));
    if (owner && owner !== memberId) return { ok: false, conflict: "udisc" };
  }

  if (newPdga !== undefined) {
    if (m.pdgaNo && normPdga(m.pdgaNo) !== newPdga) await kv.delete(IDX_PDGA(m.pdgaNo));
    if (newPdga) {
      m.pdgaNo = newPdga;
      await kv.put(IDX_PDGA(newPdga), memberId);
    } else {
      delete m.pdgaNo;
    }
  }
  if (newUdisc !== undefined) {
    if (m.udisc && normUdisc(m.udisc) !== normUdisc(newUdisc ?? "")) await kv.delete(IDX_UDISC(m.udisc));
    if (newUdisc) {
      m.udisc = newUdisc;
      await kv.put(IDX_UDISC(newUdisc), memberId);
    } else {
      delete m.udisc;
    }
  }
  if (patch.photo !== undefined) {
    if (patch.photo) m.photo = patch.photo;
    else delete m.photo;
  }

  await kv.put(RECORD(memberId), JSON.stringify(m));
  return { ok: true, member: m };
}

// ---------------- admin onboarding (issue temporary PINs) ----------------

/** KVLike plus `list` — for enumerating member records in the admin members view. */
export interface KVListLike extends KVLike {
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** Stable memberId from identity: prefers PDGA# (`m_<digits>`), else UDisc (`m_u_<lowercase>`). */
export function memberIdFor(input: { pdgaNo?: string | null; udisc?: string | null; email?: string | null }): string | null {
  const pdga = input.pdgaNo ? normPdga(input.pdgaNo) : "";
  if (pdga) return `m_${pdga}`;
  const udisc = input.udisc ? normUdisc(input.udisc) : "";
  if (udisc) return `m_u_${udisc}`;
  const email = input.email ? normEmail(input.email) : "";
  if (email) return `m_e_${fnv64(email)}`;
  return null;
}

export type CreateMemberInput = {
  name: string; pdgaNo?: string | null; udisc?: string | null; isAdmin?: boolean;
  /** Guest accounts: sign in by email, must give a phone. */
  email?: string | null; phone?: string | null; guest?: boolean;
};
export type CreateResult = { ok: true; member: Member } | { ok: false; reason: "exists" | "conflict" | "invalid" };
export type AdminMember = Pick<Member, "memberId" | "name" | "pdgaNo" | "udisc" | "isAdmin" | "mustChangePin" | "memberThroughYear" | "guest" | "held" | "email" | "phone" | "guestPromo">;

/** Create a NEW member. An admin-issued temporary PIN must be changed at first sign-in (mustChangePin: true); a PIN
 *  the person chose themselves (an approved application) is theirs already (`pinChosenByMember`). Fails with `exists`
 *  if the member id is taken, or `conflict` if a PDGA#/UDisc index already points at someone else —
 *  use resetMemberPin to reissue a PIN for an existing member instead. */
export async function createMember(kv: KVLike, input: CreateMemberInput, pinHash: string, opts: { pinChosenByMember?: boolean } = {}): Promise<CreateResult> {
  const memberId = memberIdFor(input);
  if (!memberId || !input.name?.trim()) return { ok: false, reason: "invalid" };
  if (await kv.get(RECORD(memberId))) return { ok: false, reason: "exists" };
  const pdga = input.pdgaNo ? normPdga(input.pdgaNo) : "";
  const udisc = input.udisc ? normUdisc(input.udisc) : "";
  if (pdga) { const o = await kv.get(IDX_PDGA(pdga)); if (o && o !== memberId) return { ok: false, reason: "conflict" }; }
  if (udisc) { const o = await kv.get(IDX_UDISC(udisc)); if (o && o !== memberId) return { ok: false, reason: "conflict" }; }
  const email = input.email ? normEmail(input.email) : "";
  if (email) { const o = await kv.get(IDX_EMAIL(email)); if (o && o !== memberId) return { ok: false, reason: "conflict" }; }
  const m: Member = {
    memberId,
    name: input.name.trim(),
    ...(pdga ? { pdgaNo: pdga } : {}),
    ...(udisc ? { udisc: input.udisc!.trim() } : {}),
    ...(input.isAdmin ? { isAdmin: true } : {}),
    ...(email ? { email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.guest && !input.isAdmin ? { guest: true } : {}),
    pinHash,
    mustChangePin: opts.pinChosenByMember !== true,
    memberThroughYear: easternCalendarYear(),
  };
  await putMember(kv, m);
  return { ok: true, member: m };
}

/** Reissue a temporary PIN for an EXISTING member (resolved by PDGA#/UDisc): sets the new hash and
 *  forces a change on next login; other fields are untouched. Returns the member, or null if not found. */
export async function resetMemberPin(kv: KVLike, identifier: string, pinHash: string): Promise<Member | null> {
  const m = await resolveMember(kv, identifier);
  if (!m) return null;
  m.pinHash = pinHash;
  m.mustChangePin = true;
  m.pinVer = (m.pinVer ?? 0) + 1;
  await kv.put(RECORD(m.memberId), JSON.stringify(m));
  return m;
}

/** List all members for the admin view — public-safe fields only, NEVER the pinHash. */
export async function listMembers(kv: KVListLike): Promise<AdminMember[]> {
  const out: AdminMember[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "member:", cursor });
    for (const k of page.keys) {
      const m = await getMember(kv, k.name.slice("member:".length));
      if (m) out.push({ memberId: m.memberId, name: m.name, pdgaNo: m.pdgaNo, udisc: m.udisc, isAdmin: m.isAdmin === true, mustChangePin: m.mustChangePin, memberThroughYear: m.memberThroughYear, guest: m.guest === true, held: m.held === true, email: m.email, phone: m.phone, guestPromo: m.guestPromo === true });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Count current admins — used for last-admin protection so the club can't lock itself out. */
export async function countAdmins(kv: KVListLike): Promise<number> {
  return (await listMembers(kv)).filter((m) => m.isAdmin).length;
}

/** Drop a member and their login indexes. Past scores stay. Returns the removed record so a
 *  last-admin race can put it back. Index keys are deleted only when they still point here. */
export async function deleteMember(kv: KVLike, memberId: string): Promise<Member | null> {
  const m = await getMember(kv, memberId);
  if (!m) return null;
  await kv.delete(RECORD(m.memberId));
  if (m.pdgaNo && (await kv.get(IDX_PDGA(m.pdgaNo))) === m.memberId) await kv.delete(IDX_PDGA(m.pdgaNo));
  if (m.udisc && (await kv.get(IDX_UDISC(m.udisc))) === m.memberId) await kv.delete(IDX_UDISC(m.udisc));
  if (m.email && (await kv.get(IDX_EMAIL(m.email))) === m.memberId) await kv.delete(IDX_EMAIL(m.email));
  return m;
}

/** Mark a member paid through a calendar year. Other fields stay put. */
export async function setMemberThroughYear(kv: KVLike, memberId: string, year: number): Promise<Member | null> {
  const m = await getMember(kv, memberId);
  if (!m) return null;
  m.memberThroughYear = year;
  await kv.put(RECORD(m.memberId), JSON.stringify(m));
  return m;
}

/** Resolve a member for admin tools by ANY of: internal memberId (`m_…`), PDGA# (digits), UDisc
 *  username, or an exact (case-insensitive) display name. The name match must be unambiguous — two
 *  members with the same name return `ambiguous` so an admin can't credit the wrong wallet. */
export async function resolveMemberFlexible(
  kv: KVListLike,
  identifier: string,
): Promise<{ ok: true; member: Member } | { ok: false; reason: "not_found" | "ambiguous" }> {
  const id = identifier.trim();
  if (!id) return { ok: false, reason: "not_found" };
  const byId = await getMember(kv, id);
  if (byId) return { ok: true, member: byId };
  const resolved = await resolveMember(kv, id); // PDGA# or UDisc username
  if (resolved) return { ok: true, member: resolved };
  const lc = id.toLowerCase();
  const named = (await listMembers(kv)).filter((m) => m.name.trim().toLowerCase() === lc);
  if (named.length > 1) return { ok: false, reason: "ambiguous" };
  if (named.length === 1) {
    const full = await getMember(kv, named[0]!.memberId);
    if (full) return { ok: true, member: full };
  }
  return { ok: false, reason: "not_found" };
}
