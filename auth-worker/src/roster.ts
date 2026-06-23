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
  pinHash: string;
  mustChangePin: boolean;
}

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
