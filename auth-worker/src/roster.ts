// Member roster stored in Workers KV.
//
// Layout:
//   member:<memberId>      -> JSON Member record (the source of truth)
//   idx:pdga:<digits>      -> memberId  (login-by-PDGA# index)
//   idx:udisc:<lowercase>  -> memberId  (login-by-UDisc-username index)

import type { KVLike } from "./ratelimit.js";

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
}

export type ProfilePatch = { pdgaNo?: string | null; udisc?: string | null; photo?: string | null };
export type UpdateResult = { ok: true; member: Member } | { ok: false; conflict: "pdga" | "udisc" };

const RECORD = (id: string) => `member:${id}`;
const IDX_PDGA = (n: string) => `idx:pdga:${normPdga(n)}`;
const IDX_UDISC = (u: string) => `idx:udisc:${normUdisc(u)}`;

function normPdga(s: string): string {
  return s.replace(/\D/g, "");
}
function normUdisc(s: string): string {
  return s.trim().toLowerCase();
}

/** Write a member record and its login indexes. Used by the admin seeding script. */
export async function putMember(kv: KVLike, m: Member): Promise<void> {
  await kv.put(RECORD(m.memberId), JSON.stringify(m));
  if (m.pdgaNo) await kv.put(IDX_PDGA(m.pdgaNo), m.memberId);
  if (m.udisc) await kv.put(IDX_UDISC(m.udisc), m.memberId);
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

  const pdgaDigits = normPdga(id);
  if (pdgaDigits) {
    const memberId = await kv.get(IDX_PDGA(pdgaDigits));
    if (memberId) return getMember(kv, memberId);
  }
  const memberId = await kv.get(IDX_UDISC(id));
  if (memberId) return getMember(kv, memberId);

  return null;
}

/** Replace a member's PIN hash and clear the forced-change flag. */
export async function setPin(kv: KVLike, memberId: string, pinHash: string): Promise<void> {
  const m = await getMember(kv, memberId);
  if (!m) throw new Error(`unknown member: ${memberId}`);
  m.pinHash = pinHash;
  m.mustChangePin = false;
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
