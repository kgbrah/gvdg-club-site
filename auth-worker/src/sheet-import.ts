// Admin › Import › The club's Google Sheets. The owner's rules: whatever is on the sheets is canon, rows match by PDGA #,
// UDisc name or name, and anyone on a sheet who isn't in the app gets a held account (held-accounts.ts) that carries
// over when they set up their sign-in. The browser reads the sheet and maps its columns (src/shared/sheet-import.js);
// the Worker matches, plans and applies:
//
//   POST /admin/sheet-import/plan   { kind, rows, seriesId?, defaultTier }  -> what each row would change (no writes)
//   POST /admin/sheet-import/apply  { kind, rows, seriesId?, defaultTier }  -> applies (balances / dues / people in
//                                     batches of APPLY_BATCH rows; bag tags in one call: the series becomes the sheet)
//
// kind: "people" (name, PDGA #, UDisc, tier), "balances" (store credit: the wallet is set to the sheet's balance),
// "dues" (membership paid through a year), "tags" (bag tag standings for one series). A row's tier (Member / Guest)
// applies to everyone but admins; imports never grant or remove admin. A real account's sign-in identifiers are only
// filled when blank (changing one would lock the player out), and its name is left as they set it; both are reported.
import type { Env } from "./env.js";
import { json, readJson } from "./http.js";
import { easternCalendarYear, throughYearOf } from "./membership-year.js";
import {
  createHeldMember, getMember, heldMemberIdFor, listMembers, memberTier, normalizePersonName, saveMemberRecord, setMemberThroughYear, setMemberTier,
  updateProfile, type AdminMember, type KVListLike, type Member,
} from "./roster.js";

export const SHEET_KINDS = ["people", "balances", "dues", "tags"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];
type Tier = "member" | "guest";
export const MAX_ROWS = 500;
export const MAX_TAG_ROWS = 200;
export const APPLY_BATCH = 25;

export interface SheetRow {
  line: number;
  name: string;
  pdga: string;
  udisc: string;
  tier: Tier | "";
  /** balances: cents; dues: through year; tags: tag number; people: unused. */
  value: number | null;
  /** apply only: the member the plan matched, or "" for a new held account. */
  memberId?: string;
  /** A value the app can't use (a balance over $10,000, a dues year past next year, tag #0): this row is skipped and
   *  says why, instead of the whole sheet being refused. */
  problem?: string;
}

const UDISC_RE = /^[A-Za-z0-9._-]{1,50}$/;

function cleanRow(raw: unknown, kind: SheetKind): SheetRow | null {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!row) return null;
  const line = Number(row.line);
  const name = String(row.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const pdga = String(row.pdga ?? "").replace(/\D/g, "").slice(0, 8);
  const udiscRaw = String(row.udisc ?? "").trim();
  const udisc = UDISC_RE.test(udiscRaw) ? udiscRaw : "";
  const tier = row.tier === "member" || row.tier === "guest" ? row.tier : "";
  let value: number | null = row.value == null || row.value === "" ? null : Number(row.value);
  if (value != null && !Number.isInteger(value)) return null;
  let problem = "";
  if (kind === "balances" && value != null && Math.abs(value) > 10_000_00) problem = `${money(value)} is more than $10,000; check the sheet.`;
  if (kind === "dues" && value != null && (value < 2000 || value > easternCalendarYear() + 1)) problem = `${value} isn't a dues year the app can use (2000 to ${easternCalendarYear() + 1}).`;
  if (kind === "tags" && value != null && (value < 1 || value > 9999)) problem = `Tag #${value} isn't a tag number (1 to 9999).`;
  if (problem) value = null;
  if (kind === "people") value = null;
  if (!Number.isInteger(line) || line < 1 || (!name && !pdga && !udisc)) return null;
  const memberId = typeof row.memberId === "string" && /^m_[A-Za-z0-9_.-]{1,80}$/.test(row.memberId) ? row.memberId : "";
  return { line, name, pdga, udisc, tier, value, memberId, ...(problem ? { problem } : {}) };
}

function readRows(body: Record<string, unknown>, kind: SheetKind): SheetRow[] | null {
  if (!Array.isArray(body.rows) || body.rows.length > MAX_ROWS) return null;
  const rows: SheetRow[] = [];
  for (const raw of body.rows) {
    const row = cleanRow(raw, kind);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

// --- matching ---------------------------------------------------------------------------------------------------

interface NameEntry { member: AdminMember; order: number; name: string; first: string; last: string }
interface Roster {
  all: AdminMember[];
  byPdga: Map<string, AdminMember>;
  byUdisc: Map<string, AdminMember>;
  byName: Map<string, AdminMember[]>;
  /** People in the app (not held), their names prepared once: by last name, and by first letter + length (for
   *  suggestions: a typo rarely hits the first letter, and a name within 2 edits is within 2 letters' length). */
  byLast: Map<string, NameEntry[]>;
  byStart: Map<string, NameEntry[]>;
}

async function loadRoster(env: Env): Promise<Roster> {
  const all = await listMembers(env.ROSTER as unknown as KVListLike);
  const byPdga = new Map<string, AdminMember>();
  const byUdisc = new Map<string, AdminMember>();
  const byName = new Map<string, AdminMember[]>();
  const byLast = new Map<string, NameEntry[]>();
  const byStart = new Map<string, NameEntry[]>();
  all.forEach((member, order) => {
    if (member.held === true) return;
    const name = normalizePersonName(member.name);
    if (!name) return;
    const [first = "", ...rest] = name.split(" ");
    const entry = { member, order, name, first, last: rest[rest.length - 1] ?? "" };
    if (entry.last) byLast.set(entry.last, [...(byLast.get(entry.last) ?? []), entry]);
    const start = name[0] + ":" + name.length;
    byStart.set(start, [...(byStart.get(start) ?? []), entry]);
  });
  // Real accounts win over held ones when both carry the same PDGA # / UDisc name.
  for (const m of [...all].sort((a, b) => Number(a.held === true) - Number(b.held === true))) {
    const pdga = String(m.pdgaNo ?? "").replace(/\D/g, "");
    if (pdga && !byPdga.has(pdga)) byPdga.set(pdga, m);
    const udisc = String(m.udisc ?? "").trim().toLowerCase();
    if (udisc && !byUdisc.has(udisc)) byUdisc.set(udisc, m);
    const name = normalizePersonName(m.name);
    if (name) byName.set(name, [...(byName.get(name) ?? []), m]);
    // The sheets' own spelling for them, remembered when an admin linked a row to them.
    for (const alias of m.sheetNames ?? []) if (alias && alias !== name) byName.set(alias, [...(byName.get(alias) ?? []), m]);
  }
  return { all, byPdga, byUdisc, byName, byLast, byStart };
}

type How = "pdga" | "udisc" | "name";

function matchRow(roster: Roster, row: SheetRow): { member: AdminMember; how: How } | { ambiguous: AdminMember[] } | null {
  if (row.pdga && roster.byPdga.has(row.pdga)) return { member: roster.byPdga.get(row.pdga)!, how: "pdga" };
  if (row.udisc && roster.byUdisc.has(row.udisc.toLowerCase())) return { member: roster.byUdisc.get(row.udisc.toLowerCase())!, how: "udisc" };
  const named = (roster.byName.get(normalizePersonName(row.name)) ?? []).filter((m) => {
    // Same name but a different PDGA # / UDisc account is someone else.
    const pdga = String(m.pdgaNo ?? "").replace(/\D/g, "");
    if (row.pdga && pdga && pdga !== row.pdga) return false;
    if (row.udisc && m.udisc && m.udisc.toLowerCase() !== row.udisc.toLowerCase()) return false;
    return true;
  });
  if (named.length === 1) return { member: named[0]!, how: "name" };
  if (named.length > 1) {
    const real = named.filter((m) => m.held !== true);
    if (real.length === 1) return { member: real[0]!, how: "name" };
    return { ambiguous: named };
  }
  return null;
}

/** Edit distance, bounded (names are short; only computed for rows nothing matched). */
function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** Members already in the app whose name is close (a typo, or the same last name and first initial): the admin can
 *  link them. Only names that could be close are compared - the same last name, or the same first letter and a length
 *  within 2 - so a big first import (hundreds of new names) stays inside the Worker's CPU budget. */
function suggestionsFor(roster: Roster, row: SheetRow): { memberId: string; name: string }[] {
  const name = normalizePersonName(row.name);
  if (!name) return [];
  const [first = "", ...rest] = name.split(" ");
  const last = rest[rest.length - 1] ?? "";
  const close = new Map<number, NameEntry>();
  for (const entry of last ? roster.byLast.get(last) ?? [] : []) if (entry.first[0] === first[0]) close.set(entry.order, entry);
  for (let length = name.length - 2; length <= name.length + 2; length++) {
    for (const entry of roster.byStart.get(name[0] + ":" + length) ?? []) if (!close.has(entry.order) && distance(name, entry.name, 2) <= 2) close.set(entry.order, entry);
  }
  return [...close.values()].sort((a, b) => a.order - b.order).slice(0, 2).map((entry) => ({ memberId: entry.member.memberId, name: entry.member.name }));
}

// --- plan -------------------------------------------------------------------------------------------------------

async function balancesOf(env: Env, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = (await env.DB.prepare(
      `SELECT member_id, COALESCE(SUM(amount_cents), 0) AS cents FROM wallet_transactions WHERE member_id IN (${chunk.map(() => "?").join(",")}) GROUP BY member_id`,
    ).bind(...chunk).all<{ member_id: string; cents: number }>()).results ?? [];
    for (const row of rows) out.set(row.member_id, Number(row.cents) || 0);
  }
  return out;
}

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tierLabel = (tier: string) => tier === "admin" ? "Admin" : tier === "guest" ? "Guest" : "Member";

export interface PlanRow {
  line: number;
  name: string;
  match: { memberId: string; name: string; how: How; held: boolean; tier: string } | null;
  action: "update" | "same" | "new" | "skip";
  before: string;
  after: string;
  notes: string[];
  suggestions: { memberId: string; name: string }[];
}

async function plan(env: Env, kind: SheetKind, rows: SheetRow[], seriesId: number | null, defaultTier: Tier) {
  const roster = await loadRoster(env);
  const matched = rows.map((row) => ({ row, found: matchRow(roster, row) }));
  const ids = matched.map(({ found }) => found && "member" in found ? found.member.memberId : "").filter(Boolean);
  const balances = kind === "balances" ? await balancesOf(env, [...new Set(ids)]) : new Map<string, number>();
  const holders = kind === "tags" && seriesId
    ? ((await env.DB.prepare("SELECT tag_number, member_id, member_name FROM bag_tag_holders WHERE series_id = ? ORDER BY tag_number")
      .bind(seriesId).all<{ tag_number: number; member_id: string; member_name: string }>()).results ?? [])
    : [];
  const tagOf = new Map(holders.map((holder) => [holder.member_id, holder.tag_number]));
  const seenMember = new Map<string, number>();
  const seenTag = new Map<number, number>();
  const out: PlanRow[] = matched.map(({ row, found }) => {
    const notes: string[] = [];
    const member = found && "member" in found ? found.member : null;
    const key = member?.memberId ?? "new:" + (row.pdga || row.udisc.toLowerCase() || normalizePersonName(row.name));
    const base: PlanRow = {
      line: row.line, name: row.name || member?.name || row.pdga || row.udisc,
      match: member ? { memberId: member.memberId, name: member.name, how: (found as { how: How }).how, held: member.held === true, tier: memberTier(member) } : null,
      action: member ? "same" : "new", before: "", after: "", notes, suggestions: member ? [] : suggestionsFor(roster, row),
    };
    if (row.problem) {
      notes.push(row.problem);
      return { ...base, action: "skip" };
    }
    if (found && "ambiguous" in found) notes.push(`${found.ambiguous.length} people in the app are named ${row.name}: add a PDGA # or UDisc name to this row to pick one.`);
    if (!member && !row.name) {
      notes.push("No name on this row, and nobody in the app has that PDGA # / UDisc name.");
      return { ...base, action: "skip" };
    }
    if (found && "ambiguous" in found) return { ...base, action: "skip" };
    if (seenMember.has(key)) {
      notes.push(`Same person as row ${seenMember.get(key)}; that row is used.`);
      return { ...base, action: "skip" };
    }
    seenMember.set(key, row.line);
    // Tier (any kind with a tier column, or the default for new accounts). Never touches an admin.
    const tier = row.tier || (member ? "" : defaultTier);
    const tierChange = tier && member && memberTier(member) !== "admin" && memberTier(member) !== tier ? tierLabel(tier) : "";
    if (member && tier && memberTier(member) === "admin" && tier !== "member") notes.push("An admin: their tier isn't changed by an import.");
    if (member && member.held !== true) {
      if (row.name && (member.sheetNames ?? []).includes(normalizePersonName(row.name))) notes.push(`Linked to ${member.name} on an earlier import.`);
      else if (row.name && normalizePersonName(row.name) !== normalizePersonName(member.name)) notes.push(`In the app as ${member.name}; their name stays.`);
      const pdga = String(member.pdgaNo ?? "").replace(/\D/g, "");
      if (row.pdga && pdga && pdga !== row.pdga) notes.push(`PDGA # in the app is ${pdga}; it stays (it's how they sign in).`);
      if (row.udisc && member.udisc && member.udisc.toLowerCase() !== row.udisc.toLowerCase()) notes.push(`UDisc name in the app is ${member.udisc}; it stays.`);
    }
    if (!member) notes.push(`New ${tierLabel(tier || defaultTier).toLowerCase()} account, held until they sign up.`);
    else if (member.held) notes.push("Already held from an earlier import.");
    let before = "";
    let after = "";
    let changed = !member || Boolean(tierChange);
    if (kind === "balances") {
      if (row.value == null) { notes.push("No balance on this row."); return { ...base, action: "skip" }; }
      const current = member ? balances.get(member.memberId) ?? 0 : 0;
      before = member ? money(current) : "";
      after = money(row.value);
      changed = changed || current !== row.value;
    } else if (kind === "dues") {
      const current = member ? throughYearOf(member) : null;
      if (row.value == null) {
        notes.push("Not marked paid: dues are left as they are.");
      } else {
        before = current != null ? `Through ${current}` : "";
        after = `Through ${row.value}`;
        changed = changed || current !== row.value;
      }
    } else if (kind === "tags") {
      if (row.value == null) { notes.push("No tag number on this row."); return { ...base, action: "skip" }; }
      if (seenTag.has(row.value)) { notes.push(`Tag #${row.value} is also on row ${seenTag.get(row.value)}; fix the sheet first.`); return { ...base, action: "skip" }; }
      seenTag.set(row.value, row.line);
      const current = member ? tagOf.get(member.memberId) : undefined;
      before = current != null ? `#${current}` : "";
      after = `#${row.value}`;
      changed = changed || current !== row.value;
    } else if (kind === "people" && member && member.held !== true) {
      const fillPdga = row.pdga && !member.pdgaNo && !roster.byPdga.has(row.pdga);
      const fillUdisc = row.udisc && !member.udisc && !roster.byUdisc.has(row.udisc.toLowerCase());
      if (fillPdga) notes.push(`Adds PDGA # ${row.pdga}.`);
      if (fillUdisc) notes.push(`Adds UDisc name ${row.udisc}.`);
      changed = changed || Boolean(fillPdga || fillUdisc);
    }
    if (tierChange) { before = before ? `${before} · ${tierLabel(memberTier(member!))}` : tierLabel(memberTier(member!)); after = after ? `${after} · ${tierChange}` : tierChange; }
    return { ...base, action: !member ? "new" : changed ? "update" : "same", before, after };
  });
  // Bag tags: the series becomes the sheet, so anyone holding a tag who isn't on it lets it go.
  const onSheet = new Set(out.filter((row) => row.action !== "skip" && row.match).map((row) => row.match!.memberId));
  const releases = kind === "tags"
    ? holders.filter((holder) => !onSheet.has(holder.member_id)).map((holder) => ({ tag: holder.tag_number, name: holder.member_name }))
    : [];
  const counts = { update: 0, new: 0, same: 0, skip: 0 };
  for (const row of out) counts[row.action] += 1;
  return { kind, rows: out, releases, counts };
}

// --- apply ------------------------------------------------------------------------------------------------------

/** The account a row lands on: the planned member, or the person's held account (created once, found again later). */
async function target(env: Env, row: SheetRow, defaultTier: Tier): Promise<Member | null> {
  if (row.memberId) return getMember(env.ROSTER, row.memberId);
  if (!row.name) return null;
  return (await createHeldMember(env.ROSTER, { name: row.name, pdgaNo: row.pdga || null, udisc: row.udisc || null, guest: (row.tier || defaultTier) === "guest" })).member;
}

/** An admin linked this row to someone whose name the sheet spells differently: remember the sheet's spelling, so the
 *  same sheet matches them next time instead of offering a new held account again. */
async function rememberSheetName(env: Env, member: Member, row: SheetRow): Promise<Member> {
  if (!row.memberId || !row.name || member.held === true) return member;
  const alias = normalizePersonName(row.name);
  const own = normalizePersonName(member.name);
  const samePdga = row.pdga && String(member.pdgaNo ?? "").replace(/\D/g, "") === row.pdga;
  const sameUdisc = row.udisc && member.udisc && member.udisc.toLowerCase() === row.udisc.toLowerCase();
  if (!alias || alias === own || samePdga || sameUdisc || (member.sheetNames ?? []).includes(alias)) return member;
  const next: Member = { ...member, sheetNames: [...(member.sheetNames ?? []), alias].slice(-5) };
  await saveMemberRecord(env.ROSTER, next);
  return next;
}

async function applyTier(env: Env, member: Member, row: SheetRow): Promise<Member> {
  if (!row.tier || memberTier(member) === "admin" || memberTier(member) === row.tier) return member;
  return (await setMemberTier(env.ROSTER, member.memberId, row.tier)) ?? member;
}

/** Set the wallet to `cents` with one entry, only if nobody changed it in between (a retry or a double tap is a no-op). */
async function setBalance(env: Env, member: Member, cents: number, adminId: string): Promise<"done" | "same"> {
  const result = await env.DB.prepare(
    `INSERT INTO wallet_transactions (member_id, member_name, amount_cents, transaction_type, source, note, created_by)
     SELECT ?, ?, ? - bal, CASE WHEN ? - bal > 0 THEN 'credit' ELSE 'debit' END, 'sheet_import', 'Balance from the club''s Google Sheet', ?
     FROM (SELECT COALESCE(SUM(amount_cents), 0) AS bal FROM wallet_transactions WHERE member_id = ?) WHERE bal <> ?`,
  ).bind(member.memberId, member.name, cents, cents, adminId, member.memberId, cents).run();
  return Number(result.meta?.changes) ? "done" : "same";
}

async function applyRows(env: Env, kind: SheetKind, rows: SheetRow[], defaultTier: Tier, adminId: string) {
  const results: { line: number; memberId: string; status: "done" | "same" | "error"; error?: string }[] = [];
  for (const row of rows) {
    if (row.problem) { results.push({ line: row.line, memberId: row.memberId ?? "", status: "error", error: "unusable_value" }); continue; }
    try {
      let member = await target(env, row, defaultTier);
      if (!member) { results.push({ line: row.line, memberId: "", status: "error", error: "not_found" }); continue; }
      const before = JSON.stringify(member);
      member = await rememberSheetName(env, member, row);
      member = await applyTier(env, member, row);
      let status: "done" | "same" = JSON.stringify(member) === before ? "same" : "done";
      if (kind === "balances" && row.value != null) {
        if ((await setBalance(env, member, row.value, adminId)) === "done") status = "done";
      } else if (kind === "dues" && row.value != null && throughYearOf(member) !== row.value) {
        member = (await setMemberThroughYear(env.ROSTER, member.memberId, row.value)) ?? member;
        status = "done";
      } else if (kind === "people") {
        if (member.held === true) {
          const next: Member = { ...member, ...(row.name ? { name: row.name } : {}), ...(row.pdga ? { pdgaNo: row.pdga } : {}), ...(row.udisc ? { udisc: row.udisc } : {}) };
          if (JSON.stringify(next) !== JSON.stringify(member)) { await saveMemberRecord(env.ROSTER, next); status = "done"; }
        } else {
          const patch: { pdgaNo?: string; udisc?: string } = {};
          if (row.pdga && !member.pdgaNo) patch.pdgaNo = row.pdga;
          if (row.udisc && !member.udisc) patch.udisc = row.udisc;
          if (Object.keys(patch).length) {
            const updated = await updateProfile(env.ROSTER, member.memberId, patch);
            if (updated.ok) status = "done";
          }
        }
      }
      results.push({ line: row.line, memberId: member.memberId, status });
    } catch (error) {
      results.push({ line: row.line, memberId: row.memberId ?? "", status: "error", error: error instanceof Error ? error.message.slice(0, 80) : "failed" });
    }
  }
  return results;
}

function willRememberAlias(member: Pick<Member, "held" | "name" | "pdgaNo" | "udisc" | "sheetNames">, row: SheetRow): boolean {
  if (!row.memberId || !row.name || member.held === true) return false;
  const alias = normalizePersonName(row.name);
  const own = normalizePersonName(member.name);
  const samePdga = Boolean(row.pdga && String(member.pdgaNo ?? "").replace(/\D/g, "") === row.pdga);
  const sameUdisc = Boolean(row.udisc && member.udisc && member.udisc.toLowerCase() === row.udisc.toLowerCase());
  return Boolean(alias && alias !== own && !samePdga && !sameUdisc && !(member.sheetNames ?? []).includes(alias));
}

function willChangeTier(member: Pick<Member, "isAdmin" | "guest">, row: SheetRow): boolean {
  return Boolean(row.tier && memberTier(member) !== "admin" && memberTier(member) !== row.tier);
}

/** Bag tags: the series becomes exactly the sheet, in one batch. */
async function applyTags(env: Env, seriesId: number, rows: SheetRow[], defaultTier: Tier, adminId: string) {
  const tags = rows.filter((row) => row.value != null && !row.problem);
  if (new Set(tags.map((row) => row.value)).size !== tags.length) return { error: "duplicate_tag" as const };
  const existingById = new Map((await listMembers(env.ROSTER as unknown as KVListLike)).map((m) => [m.memberId, m]));
  let plannedKvWrites = 0;
  const newHeldSeen = new Set<string>();
  const seenIds = new Set<string>();
  for (const row of tags) {
    if (row.memberId) {
      if (seenIds.has(row.memberId)) return { error: "duplicate_member" as const };
      seenIds.add(row.memberId);
      const existing = existingById.get(row.memberId);
      if (existing) {
        if (willRememberAlias(existing, row)) plannedKvWrites += 1;
        if (willChangeTier(existing, row)) plannedKvWrites += 1;
      }
    } else if (row.name) {
      const heldId = heldMemberIdFor({ name: row.name, pdgaNo: row.pdga || null, udisc: row.udisc || null });
      if (seenIds.has(heldId)) return { error: "duplicate_member" as const };
      seenIds.add(heldId);
      const existing = existingById.get(heldId);
      if (!existing) {
        if (!newHeldSeen.has(heldId)) {
          newHeldSeen.add(heldId);
          plannedKvWrites += 1;
        }
      } else if (willChangeTier(existing, row)) {
        plannedKvWrites += 1;
      }
    }
  }
  if (plannedKvWrites > APPLY_BATCH) return { error: "too_many_new_members" as const, max: APPLY_BATCH };

  const holders: { tag: number; memberId: string; name: string }[] = [];
  for (const row of tags) {
    const listed = row.memberId
      ? existingById.get(row.memberId)
      : row.name
        ? existingById.get(heldMemberIdFor({ name: row.name, pdgaNo: row.pdga || null, udisc: row.udisc || null }))
        : undefined;
    let member: Member | null = null;
    if (listed && !willRememberAlias(listed, row) && !willChangeTier(listed, row)) {
      if (holders.some((holder) => holder.memberId === listed.memberId)) return { error: "duplicate_member" as const };
      holders.push({ tag: row.value!, memberId: listed.memberId, name: listed.name });
      continue;
    }
    member = await target(env, row, defaultTier);
    if (!member) continue;
    member = await rememberSheetName(env, member, row);
    member = await applyTier(env, member, row);
    if (holders.some((holder) => holder.memberId === member!.memberId)) return { error: "duplicate_member" as const };
    holders.push({ tag: row.value!, memberId: member.memberId, name: member.name });
  }
  const statements = [env.DB.prepare("DELETE FROM bag_tag_holders WHERE series_id = ?").bind(seriesId)];
  for (let i = 0; i < holders.length; i += 20) {
    const chunk = holders.slice(i, i + 20);
    statements.push(env.DB.prepare(
      `INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`,
    ).bind(...chunk.flatMap((holder) => [seriesId, holder.tag, holder.memberId, holder.name])));
  }
  statements.push(env.DB.prepare("INSERT INTO bag_tag_moves (series_id, kind, summary, actor_id) VALUES (?, 'assign', ?, ?)")
    .bind(seriesId, `Standings set from the club's Google Sheet (${holders.length} tags)`, adminId));
  if (env.DB.batch) await env.DB.batch(statements);
  else for (const statement of statements) await statement.run();
  return { results: holders.map((holder) => ({ tag: holder.tag, memberId: holder.memberId })) };
}

export async function handleSheetImport(request: Request, env: Env, origin: string | null, method: string, seg: string[], adminId: string): Promise<Response | null> {
  const action = seg[2];
  if (method !== "POST" || seg.length !== 3 || (action !== "plan" && action !== "apply")) return null;
  const body = (await readJson(request, 400_000)) ?? {};
  const kind = SHEET_KINDS.find((value) => value === body.kind);
  if (!kind) return json({ error: "invalid_kind" }, 400, origin);
  const rows = readRows(body, kind);
  if (!rows) return json({ error: "invalid_rows" }, 400, origin);
  const defaultTier: Tier = body.defaultTier === "guest" ? "guest" : "member";
  const seriesId = Number.isInteger(Number(body.seriesId)) && Number(body.seriesId) > 0 ? Number(body.seriesId) : null;
  if (kind === "tags") {
    const series = seriesId ? await env.DB.prepare("SELECT id, active FROM bag_tag_series WHERE id = ?").bind(seriesId).first<{ id: number; active: number }>() : null;
    if (!series || series.active !== 1) return json({ error: "no_series" }, 404, origin);
  }
  if (action === "plan") return json(await plan(env, kind, rows, seriesId, defaultTier), 200, origin);
  if (kind === "tags") {
    if (rows.length > MAX_TAG_ROWS) return json({ error: "too_many_rows", max: MAX_TAG_ROWS }, 413, origin);
    const result = await applyTags(env, seriesId!, rows, defaultTier, adminId);
    if ("error" in result) {
      return json(
        "max" in result ? { error: result.error, max: result.max } : { error: result.error },
        result.error === "too_many_new_members" ? 413 : 409,
        origin,
      );
    }
    console.log(JSON.stringify({ evt: "sheet_import", kind, actor: adminId, rows: rows.length, at: Date.now() }));
    return json(result, 200, origin);
  }
  if (rows.length > APPLY_BATCH) return json({ error: "too_many_rows", max: APPLY_BATCH }, 413, origin);
  const results = await applyRows(env, kind, rows, defaultTier, adminId);
  console.log(JSON.stringify({ evt: "sheet_import", kind, actor: adminId, rows: rows.length, done: results.filter((row) => row.status === "done").length, at: Date.now() }));
  return json({ results }, 200, origin);
}
