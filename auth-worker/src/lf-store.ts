// Lost & Found data access and response shaping. Every query is parameterized; the only dynamic SQL is
// IN-list placeholders and WHERE fragments picked from hardcoded literals.
//
// PRIVACY FILTER: every public shape below is built from an explicit allow-list of fields. Rows are never
// spread into a response, so private_ink, ink text, original R2 keys and owner ids cannot leak by accident.

import type { Env } from "./env.js";
import { discTitle } from "./lf-input.js";
import { reasonLabels } from "./lf-match.js";
import { liteOf, num, numOrNull, str, tradersByOwner, type Row, type TraderLite } from "./market-store.js";

export const KARMA_PER_RETURN = 10;

export const POST_COLUMNS = `p.id, p.kind, p.owner_id, p.status, p.brand, p.mold, p.plastic, p.color, p.course_id, p.course_name, p.area,
  p.event_date, p.holding, p.bin_note, p.reward_note, p.ai_fields, p.hidden, p.merged_into, p.created_at, p.updated_at, p.expires_at, p.closed_at`;

export async function getPostRow(env: Env, id: number): Promise<Row | null> {
  return env.DB.prepare(`SELECT ${POST_COLUMNS} FROM lf_posts p WHERE p.id = ?`).bind(id).first<Row>();
}

export function photoUrl(id: number): string {
  return "/lost-found/photos/" + id;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

export interface PublicPhoto { id: number; url: string }
export interface PhotoState { photos: PublicPhoto[]; pending: number }

/** Public (redacted) photos per post, plus how many are still waiting for their redacted copy. */
export async function postPhotoStates(env: Env, postIds: readonly number[]): Promise<Map<number, PhotoState>> {
  const out = new Map<number, PhotoState>();
  const ids = [...new Set(postIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(
      `SELECT id, post_id, redaction FROM lf_photos WHERE post_id IN (${placeholders(chunk)}) AND redaction IN ('public', 'pending', 'failed')
       ORDER BY sort_order, id`,
    ).bind(...chunk).all<{ id: number; post_id: number; redaction: string }>()).results ?? [];
    for (const row of rows) {
      const state = out.get(row.post_id) ?? { photos: [], pending: 0 };
      if (row.redaction === "public") state.photos.push({ id: row.id, url: photoUrl(row.id) });
      else state.pending += 1;
      out.set(row.post_id, state);
    }
  }
  return out;
}

export async function celebrationPhotoStates(env: Env, celebrationIds: readonly number[]): Promise<Map<number, PhotoState>> {
  const out = new Map<number, PhotoState>();
  const ids = [...new Set(celebrationIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(
      `SELECT id, celebration_id, redaction FROM lf_photos WHERE celebration_id IN (${placeholders(chunk)}) AND redaction IN ('public', 'pending', 'failed')
       ORDER BY sort_order, id`,
    ).bind(...chunk).all<{ id: number; celebration_id: number; redaction: string }>()).results ?? [];
    for (const row of rows) {
      const state = out.get(row.celebration_id) ?? { photos: [], pending: 0 };
      if (row.redaction === "public") state.photos.push({ id: row.id, url: photoUrl(row.id) });
      else state.pending += 1;
      out.set(row.celebration_id, state);
    }
  }
  return out;
}

export interface Karma { karma: number; returned: number }

/** Karma = SUM of the append-only ledger; discs returned = confirmed returns that were not reversed. */
export async function karmaOf(env: Env, personIds: readonly string[]): Promise<Map<string, Karma>> {
  const out = new Map<string, Karma>();
  const ids = [...new Set(personIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(
      `SELECT person_id, COALESCE(SUM(delta), 0) AS karma,
              SUM(CASE WHEN reason = 'return_confirmed' THEN 1 WHEN reason = 'admin_reversal' THEN -1 ELSE 0 END) AS returned
       FROM lf_karma WHERE person_id IN (${placeholders(chunk)}) GROUP BY person_id`,
    ).bind(...chunk).all<{ person_id: string; karma: number; returned: number }>()).results ?? [];
    for (const row of rows) out.set(row.person_id, { karma: Number(row.karma) || 0, returned: Math.max(0, Number(row.returned) || 0) });
  }
  return out;
}

export interface Person extends TraderLite { karma: number; returned: number }

export function personOf(traders: Map<string, TraderLite>, karma: Map<string, Karma>, id: string): Person {
  const lite = liteOf(traders, id);
  const k = karma.get(id) ?? { karma: 0, returned: 0 };
  return { key: lite.key, name: lite.name, kind: lite.kind, karma: k.karma, returned: k.returned };
}

export async function people(env: Env, ids: readonly string[]): Promise<(id: string) => Person> {
  const [traders, karma] = await Promise.all([tradersByOwner(env, ids), karmaOf(env, ids)]);
  return (id: string) => personOf(traders, karma, id);
}

export interface CourseInfo { id: number; name: string; lat: number | null; lng: number | null }

export async function coursesById(env: Env, ids: readonly (number | null)[]): Promise<Map<number, CourseInfo>> {
  const out = new Map<number, CourseInfo>();
  const list = [...new Set(ids.filter((id): id is number => typeof id === "number" && id > 0))];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const rows = (await env.DB.prepare(`SELECT id, name, lat, lng FROM courses WHERE id IN (${placeholders(chunk)})`)
      .bind(...chunk).all<{ id: number; name: string; lat: number | null; lng: number | null }>()).results ?? [];
    for (const row of rows) out.set(row.id, { id: row.id, name: row.name, lat: row.lat ?? null, lng: row.lng ?? null });
  }
  return out;
}

/** open / claimed / returned / closed / expired / merged, with an open post past its date shown as expired. */
export function postStatus(row: Row, now = Date.now()): string {
  const status = str(row, "status");
  if (status === "open" && sqlMs(str(row, "expires_at")) <= now) return "expired";
  return status;
}

export function sqlMs(value: string): number {
  if (!value) return NaN;
  return Date.parse(value.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? "" : "Z"));
}

export function postTitle(row: Row): string {
  return discTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold"), color: str(row, "color") });
}

/** The public card for a post. Allow-list only. */
export function postCard(row: Row, photos: Map<number, PhotoState>, person: (id: string) => Person, viewerId: string | null) {
  const id = num(row, "id");
  const state = photos.get(id) ?? { photos: [], pending: 0 };
  const ownerId = str(row, "owner_id");
  return {
    id,
    kind: str(row, "kind"),
    title: postTitle(row),
    brand: str(row, "brand"),
    mold: str(row, "mold"),
    plastic: str(row, "plastic"),
    color: str(row, "color"),
    course: row.course_id != null ? { id: num(row, "course_id"), name: str(row, "course_name") } : null,
    area: str(row, "area"),
    date: row.event_date ? str(row, "event_date") : null,
    holding: row.holding ? str(row, "holding") : null,
    binNote: str(row, "bin_note"),
    rewardNote: str(row, "reward_note"),
    aiFields: str(row, "ai_fields").split(",").filter(Boolean),
    status: postStatus(row),
    hidden: num(row, "hidden") === 1,
    createdAt: str(row, "created_at"),
    expiresAt: str(row, "expires_at"),
    photos: state.photos,
    photoPending: state.pending,
    poster: person(ownerId),
    mine: viewerId != null && viewerId === ownerId,
  };
}

export async function postCards(env: Env, rows: Row[], viewerId: string | null) {
  const ids = rows.map((row) => num(row, "id"));
  const [photos, person] = await Promise.all([postPhotoStates(env, ids), people(env, rows.map((row) => str(row, "owner_id")))]);
  return rows.map((row) => postCard(row, photos, person, viewerId));
}

// ---- Matches ----

export const MATCH_COLUMNS = `m.id, m.found_id, m.lost_id, m.candidate_id, m.score, m.reasons, m.ai_verdict, m.status, m.created_at, m.updated_at`;

export function parseReasons(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((code): code is string => typeof code === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function strength(score: number): "strong" | "possible" {
  return score >= 55 ? "strong" : "possible";
}

// ---- Claims ----

export const CLAIM_COLUMNS = `c.id, c.found_id, c.lost_id, c.match_id, c.finder_id, c.owner_id, c.status, c.message, c.dm_thread_id,
  c.created_at, c.returned_at, c.confirmed_at, c.closed_at`;

export async function getClaimRow(env: Env, id: number): Promise<Row | null> {
  return env.DB.prepare(`SELECT ${CLAIM_COLUMNS} FROM lf_claims c WHERE c.id = ?`).bind(id).first<Row>();
}

export async function logClaim(env: Env, entry: { claimId?: number | null; postId?: number | null; actorId: string; action: string;
  from?: string | null; to?: string | null; note?: string }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO lf_claim_log (claim_id, post_id, actor_id, action, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(entry.claimId ?? null, entry.postId ?? null, entry.actorId, entry.action, entry.from ?? null, entry.to ?? null, (entry.note ?? "").slice(0, 200)).run();
}

export async function logModeration(env: Env, adminId: string, action: string, targetKind: string, targetId: string | number, reason: string): Promise<void> {
  await env.DB.prepare("INSERT INTO lf_mod_log (admin_id, action, target_kind, target_id, reason) VALUES (?, ?, ?, ?, ?)")
    .bind(adminId, action, targetKind, String(targetId), reason.slice(0, 200)).run();
}

// ---- Celebrations ----

export const CELEBRATION_COLUMNS = `e.id, e.claim_id, e.author_id, e.role, e.caption, e.hidden, e.created_at,
  c.finder_id, c.owner_id, c.found_id, c.confirmed_at, p.brand, p.mold, p.plastic, p.color, p.course_id, p.course_name`;

export async function celebrationCards(env: Env, rows: Row[], viewerId: string | null) {
  const ids = rows.map((row) => num(row, "id"));
  const [photos, person] = await Promise.all([
    celebrationPhotoStates(env, ids),
    people(env, rows.flatMap((row) => [str(row, "author_id"), str(row, "finder_id")])),
  ]);
  return rows.map((row) => {
    const id = num(row, "id");
    const state = photos.get(id) ?? { photos: [], pending: 0 };
    return {
      id,
      claimId: num(row, "claim_id"),
      role: str(row, "role"),
      caption: str(row, "caption"),
      hidden: num(row, "hidden") === 1,
      createdAt: str(row, "created_at"),
      returnedAt: str(row, "confirmed_at"),
      disc: discTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold"), color: str(row, "color") }),
      course: row.course_id != null ? { id: num(row, "course_id"), name: str(row, "course_name") } : null,
      author: person(str(row, "author_id")),
      // The owner is never named publicly; the finder is, with their karma.
      finder: person(str(row, "finder_id")),
      photos: state.photos,
      photoPending: state.pending,
      mine: viewerId != null && viewerId === str(row, "author_id"),
    };
  });
}

/** Most karma first. Reversed returns drop out because their ledger rows cancel. */
export async function topFinders(env: Env, limit = 5) {
  const rows = (await env.DB.prepare(
    `SELECT person_id, SUM(delta) AS karma,
            SUM(CASE WHEN reason = 'return_confirmed' THEN 1 WHEN reason = 'admin_reversal' THEN -1 ELSE 0 END) AS returned
     FROM lf_karma GROUP BY person_id HAVING SUM(delta) > 0 ORDER BY karma DESC, MAX(id) DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(20, limit))).all<{ person_id: string; karma: number; returned: number }>()).results ?? [];
  const traders = await tradersByOwner(env, rows.map((row) => row.person_id));
  return rows.map((row) => {
    const lite = liteOf(traders, row.person_id);
    return { key: lite.key, name: lite.name, kind: lite.kind, karma: Number(row.karma) || 0, returned: Math.max(0, Number(row.returned) || 0) };
  });
}

/** Recently returned discs (confirmed claims), newest first, for the wall, member Home and the homepage. */
export async function recentReturns(env: Env, limit = 6, days = 60) {
  const rows = (await env.DB.prepare(
    `SELECT c.id, c.finder_id, c.confirmed_at, p.id AS post_id, p.brand, p.mold, p.plastic, p.color, p.course_id, p.course_name,
            (SELECT e.id FROM lf_celebrations e WHERE e.claim_id = c.id AND e.hidden = 0 ORDER BY e.id LIMIT 1) AS celebration_id,
            (SELECT e.caption FROM lf_celebrations e WHERE e.claim_id = c.id AND e.hidden = 0 ORDER BY e.id LIMIT 1) AS caption,
            (SELECT ph.id FROM lf_photos ph JOIN lf_celebrations e ON e.id = ph.celebration_id
               WHERE e.claim_id = c.id AND e.hidden = 0 AND ph.redaction = 'public' ORDER BY e.id, ph.sort_order, ph.id LIMIT 1) AS celebration_photo,
            (SELECT ph.id FROM lf_photos ph WHERE ph.post_id = p.id AND ph.redaction = 'public' ORDER BY ph.sort_order, ph.id LIMIT 1) AS post_photo
     FROM lf_claims c JOIN lf_posts p ON p.id = c.found_id
     WHERE c.status = 'confirmed' AND p.hidden = 0 AND c.confirmed_at >= datetime('now', ?)
       AND NOT EXISTS (SELECT 1 FROM lf_karma k WHERE k.claim_id = c.id AND k.reason = 'admin_reversal')
     ORDER BY c.confirmed_at DESC, c.id DESC LIMIT ?`,
  ).bind(`-${Math.max(1, Math.min(365, days))} days`, Math.max(1, Math.min(24, limit))).all<Row>()).results ?? [];
  const person = await people(env, rows.map((row) => str(row, "finder_id")));
  return rows.map((row) => {
    const photoId = numOrNull(row, "celebration_photo") ?? numOrNull(row, "post_photo");
    return {
      claimId: num(row, "id"),
      postId: num(row, "post_id"),
      disc: discTitle({ brand: str(row, "brand"), plastic: str(row, "plastic"), mold: str(row, "mold"), color: str(row, "color") }),
      course: row.course_id != null ? { id: num(row, "course_id"), name: str(row, "course_name") } : null,
      returnedAt: str(row, "confirmed_at"),
      finder: person(str(row, "finder_id")),
      celebrationId: numOrNull(row, "celebration_id"),
      caption: str(row, "caption"),
      photo: photoId ? { id: photoId, url: photoUrl(photoId) } : null,
    };
  });
}

export function matchReasonLabels(codes: readonly string[]): string[] {
  return reasonLabels(codes);
}
