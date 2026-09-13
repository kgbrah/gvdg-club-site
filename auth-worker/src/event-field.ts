import type { Env } from "./env.js";
import type { D1Like } from "./db-types.js";
import { getMember } from "./roster.js";
import { playersMatch } from "./player-identity.js";

export type PublicFieldPlayer = {
  name: string;
  division: string | null;
  team: string | null;
  pdga_no: string | null;
  rating: number | null;
};

type FieldSeed = {
  eventId: number;
  memberId: string | null;
  name: string;
  division: string | null;
  team: string | null;
  pdgaNo: string | null;
};

type RegistrationSeed = {
  event_id?: number | null;
  member_id?: string | null;
  name?: string | null;
  division?: string | null;
  team?: string | null;
};

type WalkOnSeed = RegistrationSeed & { pdga_no?: string | null };

function asId(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function digits(value: unknown): string | null {
  const raw = String(value ?? "").replace(/\D/g, "");
  return raw || null;
}

function isGuest(id: string | null): boolean {
  return Boolean(id && id.startsWith("g_"));
}

function integerRating(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export function ratingFromPdgaCache(data: string | null | undefined): number | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return integerRating(record.official_rating) ?? integerRating(record.live_rating);
  } catch {
    return null;
  }
}

export function unionFieldSeeds(regs: readonly RegistrationSeed[], walkons: readonly WalkOnSeed[]): FieldSeed[] {
  const out: FieldSeed[] = [];
  const seenMember = new Set<string>();
  const add = (seed: FieldSeed) => {
    if (seed.memberId && seenMember.has(seed.memberId)) return;
    const matchIdx = out.findIndex((existing) => existing.eventId === seed.eventId && playersMatch(existing.name, seed.name));
    if (matchIdx >= 0) {
      const existing = out[matchIdx]!;
      if (isGuest(existing.memberId) && seed.memberId && !isGuest(seed.memberId)) {
        if (existing.memberId) seenMember.delete(existing.memberId);
        out[matchIdx] = {
          ...seed,
          pdgaNo: seed.pdgaNo || existing.pdgaNo,
          division: seed.division || existing.division,
          team: seed.team || existing.team,
        };
        if (seed.memberId) seenMember.add(seed.memberId);
      }
      return;
    }
    if (seed.memberId) seenMember.add(seed.memberId);
    out.push(seed);
  };
  for (const row of regs) {
    const eventId = asId(row.event_id);
    if (eventId == null) continue;
    add({
      eventId,
      memberId: typeof row.member_id === "string" ? row.member_id : null,
      name: String(row.name || "Player").trim() || "Player",
      division: typeof row.division === "string" && row.division.trim() ? row.division.trim() : null,
      team: typeof row.team === "string" && row.team.trim() ? row.team.trim() : null,
      pdgaNo: null,
    });
  }
  for (const row of walkons) {
    const eventId = asId(row.event_id);
    if (eventId == null) continue;
    add({
      eventId,
      memberId: typeof row.member_id === "string" ? row.member_id : null,
      name: String(row.name || "Player").trim() || "Player",
      division: typeof row.division === "string" && row.division.trim() ? row.division.trim() : null,
      team: typeof row.team === "string" && row.team.trim() ? row.team.trim() : null,
      pdgaNo: digits(row.pdga_no),
    });
  }
  return out;
}

export function sortPublicField(players: readonly PublicFieldPlayer[]): PublicFieldPlayer[] {
  return players.slice().sort((left, right) => {
    const div = String(left.division || "Open").localeCompare(String(right.division || "Open"));
    if (div) return div;
    const ratingA = left.rating == null ? -1 : left.rating;
    const ratingB = right.rating == null ? -1 : right.rating;
    if (ratingA !== ratingB) return ratingB - ratingA;
    return left.name.localeCompare(right.name);
  });
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function rowsIn<T>(db: D1Like, sql: string, ids: number[]): Promise<T[]> {
  if (!ids.length) return [];
  return ((await db.prepare(sql).bind(...ids).all()).results || []) as T[];
}

export async function publicFieldsByEvent(env: Env, eventIds: readonly number[]): Promise<Map<number, PublicFieldPlayer[]>> {
  const ids = [...new Set(eventIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, PublicFieldPlayer[]>();
  for (const id of ids) out.set(id, []);
  if (!ids.length) return out;

  const inList = placeholders(ids.length);
  const [regs, walkons] = await Promise.all([
    rowsIn<RegistrationSeed>(env.DB, `SELECT event_id, member_id, name, division, team FROM registrations WHERE event_id IN (${inList})`, ids),
    rowsIn<WalkOnSeed>(env.DB, `SELECT event_id, member_id, name, pdga_no, division, team FROM event_players WHERE event_id IN (${inList})`, ids),
  ]);
  const seeds = unionFieldSeeds(regs, walkons);
  const memberIds = [...new Set(seeds.map((seed) => seed.memberId).filter((id): id is string => Boolean(id && !isGuest(id))))];
  const members = await Promise.all(memberIds.map((id) => getMember(env.ROSTER, id)));
  const pdgaByMember = new Map<string, string>();
  for (let i = 0; i < memberIds.length; i++) {
    const pdga = digits(members[i]?.pdgaNo);
    if (pdga) pdgaByMember.set(memberIds[i]!, pdga);
  }

  const pdgaNos = [...new Set(seeds.map((seed) => seed.pdgaNo || (seed.memberId ? pdgaByMember.get(seed.memberId) : null) || null).filter((n): n is string => Boolean(n)))];
  const ratingByPdga = new Map<string, number>();
  if (pdgaNos.length) {
    const cacheRows = ((await env.DB.prepare(`SELECT pdga, data FROM pdga_cache WHERE pdga IN (${placeholders(pdgaNos.length)})`).bind(...pdgaNos).all()).results || []) as { pdga?: string; data?: string }[];
    for (const row of cacheRows) {
      const pdga = digits(row.pdga);
      const rating = ratingFromPdgaCache(row.data);
      if (pdga && rating != null) ratingByPdga.set(pdga, rating);
    }
  }

  for (const seed of seeds) {
    const pdga = seed.pdgaNo || (seed.memberId ? pdgaByMember.get(seed.memberId) : null) || null;
    const list = out.get(seed.eventId) || [];
    list.push({
      name: seed.name,
      division: seed.division,
      team: seed.team,
      pdga_no: pdga,
      rating: pdga ? ratingByPdga.get(pdga) ?? null : null,
    });
    out.set(seed.eventId, list);
  }
  for (const [eventId, players] of out) out.set(eventId, sortPublicField(players));
  return out;
}
