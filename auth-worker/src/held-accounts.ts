// Held accounts (the owner's rule): anyone on the club's Google Sheets who isn't in the app yet gets an account that
// holds their imported store credit, dues and bag tag (roster.createHeldMember: no PIN, no login index, can't sign in).
// When the player sets up their account (an admin approves their application, or an admin adds them) the held account
// is matched by PDGA #, UDisc name or name and carried over: its wallet entries and bag tags move to the new account,
// its dues and tier come along, and the held record is removed. An admin can also link a held account to a member who
// is already in the app under another name (POST /admin/members/link-held).
import type { Env } from "./env.js";
import { deleteMember, getMember, listMembers, normalizePersonName, saveMemberRecord, type KVListLike, type Member } from "./roster.js";

export interface CarriedOver {
  heldId: string;
  name: string;
  balanceCents: number;
  throughYear: number | null;
  tags: number[];
  guest: boolean;
}

const digits = (value: string | null | undefined) => String(value ?? "").replace(/\D/g, "");
const lower = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

/**
 * The one held account that is this person: same PDGA #, else same UDisc name, else the same name when exactly one
 * held account has it and it doesn't name a different PDGA # / UDisc account.
 */
export async function findHeldMatch(env: Env, who: { name: string; pdgaNo?: string | null; udisc?: string | null }): Promise<string | null> {
  const held = (await listMembers(env.ROSTER as unknown as KVListLike)).filter((m) => m.held === true);
  if (!held.length) return null;
  const pdga = digits(who.pdgaNo);
  const udisc = lower(who.udisc);
  if (pdga) {
    const byPdga = held.filter((m) => digits(m.pdgaNo) === pdga);
    if (byPdga.length === 1) return byPdga[0]!.memberId;
  }
  if (udisc) {
    const byUdisc = held.filter((m) => lower(m.udisc) === udisc);
    if (byUdisc.length === 1) return byUdisc[0]!.memberId;
  }
  const name = normalizePersonName(who.name);
  if (!name) return null;
  const byName = held.filter((m) => normalizePersonName(m.name) === name
    && (!m.pdgaNo || digits(m.pdgaNo) === pdga) && (!m.udisc || lower(m.udisc) === udisc));
  return byName.length === 1 ? byName[0]!.memberId : null;
}

/**
 * Move a held account onto a real one: wallet entries and bag tags (a tag the member already holds in that series
 * wins; the held one is released), dues (the held account's year: the sheets are canon) and the guest tier. Then the
 * held record is removed. Returns what came across, or null when `heldId` isn't a held account.
 */
export async function absorbHeld(env: Env, heldId: string, target: Member, adminId: string | null): Promise<CarriedOver | null> {
  const held = await getMember(env.ROSTER, heldId);
  if (!held || held.held !== true || held.memberId === target.memberId) return null;
  const balance = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM wallet_transactions WHERE member_id = ?")
    .bind(heldId).first<{ cents: number }>();
  await env.DB.prepare("UPDATE wallet_transactions SET member_id = ?, member_name = ? WHERE member_id = ?")
    .bind(target.memberId, target.name, heldId).run();
  const tags = (await env.DB.prepare("SELECT series_id, tag_number FROM bag_tag_holders WHERE member_id = ?")
    .bind(heldId).all<{ series_id: number; tag_number: number }>()).results ?? [];
  const moved: number[] = [];
  for (const tag of tags) {
    const already = await env.DB.prepare("SELECT tag_number FROM bag_tag_holders WHERE series_id = ? AND member_id = ?")
      .bind(tag.series_id, target.memberId).first<{ tag_number: number }>();
    if (already) {
      await env.DB.prepare("DELETE FROM bag_tag_holders WHERE series_id = ? AND member_id = ?").bind(tag.series_id, heldId).run();
      await env.DB.prepare("INSERT INTO bag_tag_moves (series_id, kind, summary, actor_id) VALUES (?, 'release', ?, ?)")
        .bind(tag.series_id, `Released #${tag.tag_number} (held for ${held.name}): ${target.name} already holds #${already.tag_number}`, adminId).run();
      continue;
    }
    await env.DB.prepare("UPDATE bag_tag_holders SET member_id = ?, member_name = ? WHERE series_id = ? AND member_id = ?")
      .bind(target.memberId, target.name, tag.series_id, heldId).run();
    await env.DB.prepare("INSERT INTO bag_tag_moves (series_id, kind, summary, actor_id) VALUES (?, 'assign', ?, ?)")
      .bind(tag.series_id, `#${tag.tag_number} (held for ${held.name}) is now ${target.name}'s`, adminId).run();
    moved.push(tag.tag_number);
  }
  const updated: Member = { ...target };
  if (typeof held.memberThroughYear === "number") updated.memberThroughYear = held.memberThroughYear;
  if (held.guest === true && target.isAdmin !== true) updated.guest = true;
  await saveMemberRecord(env.ROSTER, updated);
  await deleteMember(env.ROSTER, heldId);
  console.log(JSON.stringify({ evt: "held_account_claimed", heldId, memberId: target.memberId, actor: adminId, at: Date.now() }));
  return {
    heldId, name: held.name, balanceCents: Number(balance?.cents) || 0,
    throughYear: typeof held.memberThroughYear === "number" ? held.memberThroughYear : null, tags: moved, guest: held.guest === true,
  };
}

/** After a new account is created: carry over the held account that is this person, if there is exactly one. */
export async function claimHeldFor(env: Env, member: Member, adminId: string | null): Promise<CarriedOver | null> {
  const heldId = await findHeldMatch(env, member);
  if (!heldId) return null;
  return absorbHeld(env, heldId, member, adminId);
}

/** "$12.50 store credit, dues through 2026 and bag tag #7 came over from the club's sheets." */
export function carriedOverText(carried: CarriedOver | null): string {
  if (!carried) return "";
  const parts: string[] = [];
  if (carried.balanceCents) parts.push(`${carried.balanceCents < 0 ? "-" : ""}$${(Math.abs(carried.balanceCents) / 100).toFixed(2)} store credit`);
  if (carried.throughYear && !carried.guest) parts.push(`dues through ${carried.throughYear}`);
  if (carried.tags.length) parts.push(carried.tags.length === 1 ? `bag tag #${carried.tags[0]}` : `bag tags ${carried.tags.map((tag) => "#" + tag).join(", ")}`);
  if (carried.guest) parts.push("guest tier");
  if (!parts.length) return `Matched ${carried.name} from the club's sheets.`;
  const list = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
  return `Matched ${carried.name} from the club's sheets: ${list} came over.`;
}
