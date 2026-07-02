// D1 data-access layer for club operations (Phase 1).
// ALL queries are parameterized via .bind() — never string-interpolate user input.

import { enrichHoles, type LayoutHole } from "./layouts.js";

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: {
    changes?: number;
    rows_written?: number;
  } & Record<string, unknown>;
}
export interface D1StatementLike {
  bind(...vals: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1ResultLike>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
}

export const EVENT_TYPES = ["tournament", "league_round", "fundraiser", "meeting"] as const;
export const EVENT_STATUSES = ["scheduled", "live", "final", "cancelled"] as const;
export const EVENT_FORMATS = ["stroke", "matchplay", "doubles"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------- courses ----------------
export interface CourseInput {
  name: string;
  location?: string | null;
  udisc_url?: string | null;
  udisc_course_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  created_by?: string | null;
}

export async function listCourses(db: D1Like) {
  return (await db.prepare("SELECT * FROM courses ORDER BY is_default DESC, name").all()).results;
}
export async function getCourse(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM courses WHERE id = ?").bind(id).first();
}
export async function createCourse(db: D1Like, c: CourseInput) {
  return db
    .prepare(
      "INSERT INTO courses (name, location, udisc_url, udisc_course_id, lat, lng, is_default, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?) RETURNING *",
    )
    .bind(c.name, c.location ?? null, c.udisc_url ?? null, c.udisc_course_id ?? null, c.lat ?? null, c.lng ?? null, c.created_by ?? null)
    .first();
}
// CoursePatch keeps legacy COALESCE semantics: null means "leave unchanged".
export type CoursePatch = { name?: string | null; location?: string | null; udisc_url?: string | null; udisc_course_id?: string | null; lat?: number | null; lng?: number | null };
// EventPatch uses undefined for "leave unchanged" and null to clear nullable fields.
export type EventPatch = {
  type?: string | null; name?: string | null; status?: string | null; format?: string | null; date?: string | null;
  course_id?: number | null; layout_id?: number | null; league_id?: number | null; notes?: string | null;
};

export async function updateCourse(db: D1Like, id: number, c: CoursePatch) {
  return db
    .prepare(
      "UPDATE courses SET name=COALESCE(?,name), location=COALESCE(?,location), udisc_url=COALESCE(?,udisc_url), udisc_course_id=COALESCE(?,udisc_course_id), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=? RETURNING *",
    )
    .bind(c.name ?? null, c.location ?? null, c.udisc_url ?? null, c.udisc_course_id ?? null, c.lat ?? null, c.lng ?? null, id)
    .first();
}
export async function deleteCourse(db: D1Like, id: number) {
  await db.prepare("DELETE FROM courses WHERE id = ?").bind(id).run();
}

// ---------------- course layouts ----------------
export async function listLayouts(db: D1Like, courseId: number) {
  return (await db.prepare("SELECT * FROM course_layouts WHERE course_id = ? ORDER BY id").bind(courseId).all()).results;
}
export async function createLayout(
  db: D1Like,
  l: { course_id: number; name?: string; holes: unknown; total_par?: number | null },
) {
  const holesJson = JSON.stringify(l.holes ?? []);
  return db
    .prepare("INSERT INTO course_layouts (course_id, name, holes, total_par) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(l.course_id, l.name ?? "Main", holesJson, l.total_par ?? null)
    .first();
}
export async function getLayout(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM course_layouts WHERE id = ?").bind(id).first();
}
export interface ScorableHole {
  hole: number;
  par: number;
  distance_ft: number | null;
  tee_sign_id: number | null;
}

/** A layout's hole list as scorable hole metadata (parses stored JSON), or [] for none/invalid/missing layout. */
export async function getLayoutHoles(db: D1Like, layoutId: number | null | undefined): Promise<ScorableHole[]> {
  if (!layoutId) return [];
  const layout = (await getLayout(db, Number(layoutId))) as { holes?: string } | null;
  try {
    return JSON.parse(layout?.holes ?? "[]").map((h: { hole: number; par: number; distance_ft?: number | null; verified?: { tee_sign_id?: number | null } | null; tee_sign_id?: number | null }) => ({
      hole: Number(h.hole),
      par: Number(h.par),
      distance_ft: h.distance_ft == null ? null : Number(h.distance_ft),
      tee_sign_id: h.verified?.tee_sign_id ?? h.tee_sign_id ?? null,
    }));
  } catch {
    return [];
  }
}
export async function updateLayout(
  db: D1Like,
  id: number,
  l: { name?: string | null; holes?: unknown; total_par?: number | null },
) {
  // holes is the source of truth; pass an already-enriched array. null holes = leave unchanged.
  const holesJson = l.holes === undefined ? null : JSON.stringify(l.holes ?? []);
  return db
    .prepare(
      "UPDATE course_layouts SET name=COALESCE(?,name), holes=COALESCE(?,holes), total_par=COALESCE(?,total_par) WHERE id=? RETURNING *",
    )
    .bind(l.name ?? null, holesJson, l.total_par ?? null, id)
    .first();
}
export async function deleteLayout(db: D1Like, id: number) {
  await db.prepare("DELETE FROM course_layouts WHERE id = ?").bind(id).run();
}

// ---------------- course positions (tee/target pool for the SAFARI editor) ----------------
export const POSITION_KINDS = ["tee", "target"] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];
export interface PositionInput {
  course_id: number;
  kind: PositionKind;
  label: string;
  lat?: number | null;
  lng?: number | null;
  color?: string | null;
}

export async function listPositions(db: D1Like, courseId: number, kind?: PositionKind) {
  let sql = "SELECT * FROM course_positions WHERE course_id = ?";
  const binds: unknown[] = [courseId];
  if (kind) { sql += " AND kind = ?"; binds.push(kind); }
  sql += " ORDER BY kind, id";
  return (await db.prepare(sql).bind(...binds).all()).results;
}
export async function createPosition(db: D1Like, p: PositionInput) {
  return db
    .prepare("INSERT INTO course_positions (course_id, kind, label, lat, lng, color) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(p.course_id, p.kind, p.label, p.lat ?? null, p.lng ?? null, p.color ?? null)
    .first();
}
export async function deletePosition(db: D1Like, courseId: number, id: number) {
  await db.prepare("DELETE FROM course_positions WHERE id = ? AND course_id = ?").bind(id, courseId).run();
}
/** Replace the whole pool for a course (used by UDisc import): clear then re-insert. */
export async function replacePositions(db: D1Like, courseId: number, positions: PositionInput[]) {
  await db.prepare("DELETE FROM course_positions WHERE course_id = ?").bind(courseId).run();
  for (const p of positions) {
    await db
      .prepare("INSERT INTO course_positions (course_id, kind, label, lat, lng) VALUES (?, ?, ?, ?, ?)")
      .bind(courseId, p.kind, p.label, p.lat ?? null, p.lng ?? null)
      .run();
  }
  return listPositions(db, courseId);
}

// ---------------- leagues ----------------
export async function listLeagues(db: D1Like) {
  return (await db.prepare("SELECT * FROM leagues ORDER BY season DESC, name").all()).results;
}
export async function createLeague(
  db: D1Like,
  l: { name: string; season?: string | null; format?: string | null; description?: string | null; created_by?: string | null },
) {
  return db
    .prepare("INSERT INTO leagues (name, season, format, description, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(l.name, l.season ?? null, l.format ?? null, l.description ?? null, l.created_by ?? null)
    .first();
}
export async function getLeague(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM leagues WHERE id = ?").bind(id).first();
}
export async function updateLeague(
  db: D1Like,
  id: number,
  l: { name?: string | null; season?: string | null; format?: string | null; description?: string | null },
) {
  return db
    .prepare(
      "UPDATE leagues SET name=COALESCE(?,name), season=COALESCE(?,season), format=COALESCE(?,format), description=COALESCE(?,description) WHERE id=? RETURNING *",
    )
    .bind(l.name ?? null, l.season ?? null, l.format ?? null, l.description ?? null, id)
    .first();
}
export async function deleteLeague(db: D1Like, id: number) {
  await db.prepare("DELETE FROM leagues WHERE id = ?").bind(id).run();
}
/** A league's events (most recent first). */
export async function listLeagueEvents(db: D1Like, leagueId: number) {
  return (await db.prepare("SELECT * FROM events WHERE league_id = ? ORDER BY date DESC, id DESC").bind(leagueId).all()).results;
}
/** Result rows across a league's FINALIZED events — fed to computeLeagueStandings. */
export async function leagueResultRows(db: D1Like, leagueId: number) {
  return (
    await db
      .prepare(
        "SELECT r.member_id, r.name, r.place, r.to_par FROM results r JOIN events e ON e.id = r.event_id WHERE e.league_id = ? AND e.status = 'final'",
      )
      .bind(leagueId)
      .all()
  ).results;
}

// ---------------- events ----------------
export interface EventInput {
  type: string;
  name: string;
  status?: string;
  format?: string | null;
  date?: string | null;
  course_id?: number | null;
  layout_id?: number | null;
  league_id?: number | null;
  source?: string;
  external_url?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

export async function listEvents(db: D1Like, opts: { status?: string; type?: string } = {}) {
  let sql = "SELECT * FROM events";
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.status) { where.push("status = ?"); binds.push(opts.status); }
  if (opts.type) { where.push("type = ?"); binds.push(opts.type); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY date DESC, id DESC";
  return (await db.prepare(sql).bind(...binds).all()).results;
}
export async function getEvent(db: D1Like, id: number) {
  const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first();
  if (!event) return null;
  const players = (await db.prepare("SELECT * FROM event_players WHERE event_id = ? ORDER BY name").bind(id).all()).results;
  return { ...event, players };
}
export async function createEvent(db: D1Like, e: EventInput) {
  return db
    .prepare(
      `INSERT INTO events (type, name, status, format, date, course_id, layout_id, league_id, source, external_url, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      e.type, e.name, e.status ?? "scheduled", e.format ?? null, e.date ?? null,
      e.course_id ?? null, e.layout_id ?? null, e.league_id ?? null,
      e.source ?? "manual", e.external_url ?? null, e.notes ?? null, e.created_by ?? null,
    )
    .first();
}
export async function updateEvent(db: D1Like, id: number, e: EventPatch) {
  return db
    .prepare(
      `UPDATE events SET type=CASE WHEN ? THEN ? ELSE type END,
        name=CASE WHEN ? THEN ? ELSE name END,
        status=CASE WHEN ? THEN ? ELSE status END,
        format=CASE WHEN ? THEN ? ELSE format END,
        date=CASE WHEN ? THEN ? ELSE date END,
        course_id=CASE WHEN ? THEN ? ELSE course_id END,
        layout_id=CASE WHEN ? THEN ? ELSE layout_id END,
        league_id=CASE WHEN ? THEN ? ELSE league_id END,
        notes=CASE WHEN ? THEN ? ELSE notes END,
        updated_at=datetime('now') WHERE id=? RETURNING *`,
    )
    .bind(
      e.type !== undefined ? 1 : 0, e.type ?? null,
      e.name !== undefined ? 1 : 0, e.name ?? null,
      e.status !== undefined ? 1 : 0, e.status ?? null,
      e.format !== undefined ? 1 : 0, e.format ?? null,
      e.date !== undefined ? 1 : 0, e.date ?? null,
      e.course_id !== undefined ? 1 : 0, e.course_id ?? null,
      e.layout_id !== undefined ? 1 : 0, e.layout_id ?? null,
      e.league_id !== undefined ? 1 : 0, e.league_id ?? null,
      e.notes !== undefined ? 1 : 0, e.notes ?? null,
      id,
    )
    .first();
}
export async function deleteEvent(db: D1Like, id: number) {
  await db.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
}

// ---------------- event players ----------------
export async function addEventPlayer(
  db: D1Like,
  p: { event_id: number; member_id?: string | null; name: string; pdga_no?: string | null; division?: string | null; team?: string | null },
) {
  return db
    .prepare("INSERT INTO event_players (event_id, member_id, name, pdga_no, division, team) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(p.event_id, p.member_id ?? null, p.name, p.pdga_no ?? null, p.division ?? null, p.team ?? null)
    .first();
}
export async function removeEventPlayer(db: D1Like, eventId: number, playerId: number) {
  await db.prepare("DELETE FROM event_players WHERE id = ? AND event_id = ?").bind(playerId, eventId).run();
}

// ---------------- event registration config + registrations (Track G) ----------------
export interface EventConfigPatch {
  registration_open?: number | null;
  entry_fee_cents?: number | null;
  ctp_fee_cents?: number | null;
  ace_fee_cents?: number | null;
  divisions?: string | null; // JSON array
  play_format?: string | null;
  notes?: string | null;
}
export async function getEventConfig(db: D1Like, eventId: number) {
  return db.prepare("SELECT * FROM event_config WHERE event_id = ?").bind(eventId).first();
}
export async function upsertEventConfig(db: D1Like, eventId: number, c: EventConfigPatch) {
  return db
    .prepare(
      `INSERT INTO event_config (event_id, registration_open, entry_fee_cents, ctp_fee_cents, ace_fee_cents, divisions, play_format, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET registration_open=excluded.registration_open, entry_fee_cents=excluded.entry_fee_cents,
         ctp_fee_cents=excluded.ctp_fee_cents, ace_fee_cents=excluded.ace_fee_cents, divisions=excluded.divisions,
         play_format=excluded.play_format, notes=excluded.notes RETURNING *`,
    )
    .bind(eventId, c.registration_open ?? 0, c.entry_fee_cents ?? null, c.ctp_fee_cents ?? null, c.ace_fee_cents ?? null, c.divisions ?? null, c.play_format ?? null, c.notes ?? null)
    .first();
}
/** Open events (scheduled, registration_open) joined with their config — for the member sign-up list. */
export async function listOpenRegistrationEvents(db: D1Like) {
  return (
    await db
      .prepare(
        `SELECT e.id, e.name, e.date, e.type, e.format AS event_format, e.course_id, e.layout_id,
           co.name AS course_name, l.name AS layout_name, l.total_par,
           c.entry_fee_cents, c.ctp_fee_cents, c.ace_fee_cents, c.divisions, c.play_format
         FROM events e JOIN event_config c ON c.event_id = e.id
         LEFT JOIN courses co ON co.id = e.course_id
         LEFT JOIN course_layouts l ON l.id = e.layout_id
         WHERE c.registration_open = 1 AND e.status IN ('scheduled','live') ORDER BY e.date, e.id`,
      )
      .all()
  ).results;
}

export interface RegistrationInput {
  event_id: number;
  member_id: string;
  name: string;
  division?: string | null;
  team?: string | null;
  addons?: string | null;
  email?: string | null; // guest contact (members are reachable via their account)
}
export async function getMyRegistration(db: D1Like, eventId: number, memberId: string) {
  return db.prepare("SELECT * FROM registrations WHERE event_id = ? AND member_id = ?").bind(eventId, memberId).first();
}
export async function getEventStatus(db: D1Like, id: number): Promise<string | null> {
  const r = (await db.prepare("SELECT status FROM events WHERE id = ?").bind(id).first()) as { status?: string } | null;
  return r?.status ?? null;
}
export async function listMyRegistrations(db: D1Like, memberId: string) {
  return (await db.prepare("SELECT * FROM registrations WHERE member_id = ? ORDER BY event_id DESC").bind(memberId).all()).results;
}
export async function listMemberLiveEvents(db: D1Like, memberId: string) {
  return (
    await db
      .prepare(
        `WITH member_events AS (
           SELECT event_id, division FROM registrations WHERE member_id = ?
           UNION ALL
           SELECT event_id, division FROM event_players WHERE member_id = ?
         )
         SELECT e.id, e.name, e.type, e.date, e.status, e.course_id, e.layout_id,
                c.name AS course_name, l.name AS layout_name, MAX(member_events.division) AS division
         FROM member_events
         JOIN events e ON e.id = member_events.event_id
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN course_layouts l ON l.id = e.layout_id
         WHERE e.status = 'live'
         GROUP BY e.id
         ORDER BY e.date DESC, e.id DESC`,
      )
      .bind(memberId, memberId)
      .all()
  ).results;
}
export async function listRegistrations(db: D1Like, eventId: number) {
  return (await db.prepare("SELECT * FROM registrations WHERE event_id = ? ORDER BY division, name").bind(eventId).all()).results;
}
export async function registerForEvent(db: D1Like, r: RegistrationInput) {
  return db
    .prepare(
      `INSERT INTO registrations (event_id, member_id, name, division, team, addons, email) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO UPDATE SET name=excluded.name, division=excluded.division, team=excluded.team, addons=excluded.addons, email=COALESCE(excluded.email, registrations.email)
       RETURNING *`,
    )
    .bind(r.event_id, r.member_id, r.name, r.division ?? null, r.team ?? null, r.addons ?? null, r.email ?? null)
    .first();
}
export async function withdrawRegistration(db: D1Like, eventId: number, memberId: string) {
  await db.prepare("DELETE FROM registrations WHERE event_id = ? AND member_id = ?").bind(eventId, memberId).run();
}
export async function setCheckedIn(db: D1Like, eventId: number, memberId: string, val: boolean) {
  return db.prepare("UPDATE registrations SET checked_in = ? WHERE event_id = ? AND member_id = ? RETURNING *").bind(val ? 1 : 0, eventId, memberId).first();
}
export async function getRegistration(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM registrations WHERE id = ?").bind(id).first();
}
/** Mark a registration paid after a verified PayPal capture (records the order id + captured amount).
 *  Writes only when still unpaid (`paid_entry = 0`) so concurrent captures can't double-credit; returns
 *  null if it was already paid (caller re-reads). */
export async function markRegistrationPaid(db: D1Like, id: number, paymentRef: string, amountCents: number) {
  return db
    .prepare("UPDATE registrations SET paid_entry = 1, payment_ref = ?, amount_paid_cents = ? WHERE id = ? AND paid_entry = 0 RETURNING *")
    .bind(paymentRef, amountCents, id)
    .first();
}
/** Atomically reserve an unpaid registration for exactly one PayPal order id BEFORE capturing, so two
 *  concurrently-approved orders can't both charge the card. Returns true if this caller won the slot
 *  (or already holds it for this order id); false if another order id is mid-capture. */
export async function reserveCapture(db: D1Like, id: number, paymentRef: string): Promise<boolean> {
  const row = await db
    .prepare("UPDATE registrations SET payment_ref = ? WHERE id = ? AND paid_entry = 0 AND (payment_ref IS NULL OR payment_ref = ?) RETURNING id")
    .bind(paymentRef, id, paymentRef)
    .first();
  return row != null;
}
/** Release a capture reservation (call when the capture failed) so the member can retry. No-op once paid. */
export async function releaseCapture(db: D1Like, id: number, paymentRef: string): Promise<void> {
  await db.prepare("UPDATE registrations SET payment_ref = NULL WHERE id = ? AND paid_entry = 0 AND payment_ref = ?").bind(id, paymentRef).run();
}
export type RegistrationPatch = {
  division?: string | null;
  team?: string | null;
  starting_hole?: number | null;
  checked_in?: number;
  paid_entry?: number;
};

export async function adminUpdateRegistration(
  db: D1Like,
  eventId: number,
  id: number,
  p: RegistrationPatch,
) {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (p.division !== undefined) { sets.push("division = ?"); binds.push(p.division); }
  if (p.team !== undefined) { sets.push("team = ?"); binds.push(p.team); }
  if (p.starting_hole !== undefined) { sets.push("starting_hole = ?"); binds.push(p.starting_hole); }
  if (p.checked_in !== undefined) { sets.push("checked_in = ?"); binds.push(p.checked_in); }
  if (p.paid_entry !== undefined) { sets.push("paid_entry = ?"); binds.push(p.paid_entry); }
  if (!sets.length) return db.prepare("SELECT * FROM registrations WHERE id = ? AND event_id = ?").bind(id, eventId).first();
  binds.push(id, eventId);
  return db.prepare(`UPDATE registrations SET ${sets.join(", ")} WHERE id = ? AND event_id = ? RETURNING *`).bind(...binds).first();
}

// ---------------- CTPs + ace pots (Track G G3) ----------------
export async function listCtps(db: D1Like, eventId: number) {
  return (await db.prepare("SELECT * FROM ctps WHERE event_id = ? ORDER BY hole").bind(eventId).all()).results;
}
export async function createCtp(db: D1Like, c: { event_id: number; hole: number; division?: string | null; prize?: string | null }) {
  return db
    .prepare("INSERT INTO ctps (event_id, hole, division, prize) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(c.event_id, c.hole, c.division ?? null, c.prize ?? null)
    .first();
}
export async function setCtpWinner(db: D1Like, id: number, eventId: number, winnerMemberId: string | null, winnerName: string | null) {
  return db
    .prepare("UPDATE ctps SET winner_member_id = ?, winner_name = ? WHERE id = ? AND event_id = ? RETURNING *")
    .bind(winnerMemberId, winnerName, id, eventId)
    .first();
}
export async function deleteCtp(db: D1Like, eventId: number, id: number) {
  await db.prepare("DELETE FROM ctps WHERE id = ? AND event_id = ?").bind(id, eventId).run();
}
export async function getAcePot(db: D1Like, eventId: number) {
  return db.prepare("SELECT * FROM ace_pots WHERE event_id = ?").bind(eventId).first();
}
export async function upsertAcePot(db: D1Like, eventId: number, p: { carryover_in_cents?: number | null; status?: string | null; winner_member_id?: string | null; winner_name?: string | null; payout_cents?: number | null; resolved_at?: string | null }) {
  return db
    .prepare(
      `INSERT INTO ace_pots (event_id, carryover_in_cents, status, winner_member_id, winner_name, payout_cents, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET carryover_in_cents=excluded.carryover_in_cents, status=excluded.status,
         winner_member_id=excluded.winner_member_id, winner_name=excluded.winner_name, payout_cents=excluded.payout_cents,
         resolved_at=excluded.resolved_at RETURNING *`,
    )
    .bind(eventId, p.carryover_in_cents ?? 0, p.status ?? "active", p.winner_member_id ?? null, p.winner_name ?? null, p.payout_cents ?? null, p.resolved_at ?? null)
    .first();
}
/** Number of PAID registrations that opted into the ace pot (the money actually in the pot). */
export async function aceContributors(db: D1Like, eventId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND paid_entry = 1 AND addons LIKE '%\"ace\":true%'").bind(eventId).first();
  return Number((r as { n?: number } | null)?.n || 0);
}

// ---------------- members message board ----------------
export interface BoardPostInput {
  parent_id?: number | null;
  member_id: string;
  author_name: string;
  body: string;
}
/** Recent top-level posts (newest first) with their replies (oldest first) nested under `replies`. */
export async function getBoardFeed(db: D1Like, limit = 50): Promise<Record<string, unknown>[]> {
  const posts = (await db.prepare("SELECT * FROM board_posts WHERE parent_id IS NULL ORDER BY id DESC LIMIT ?").bind(limit).all()).results;
  const ids = posts.map((p) => p.id as number);
  let replies: Record<string, unknown>[] = [];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    replies = (await db.prepare(`SELECT * FROM board_posts WHERE parent_id IN (${placeholders}) ORDER BY id ASC`).bind(...ids).all()).results;
  }
  const byParent = new Map<number, Record<string, unknown>[]>();
  for (const r of replies) {
    const pid = r.parent_id as number;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(r);
  }
  return posts.map((p) => ({ ...p, replies: byParent.get(p.id as number) ?? [] }));
}
export async function getBoardPost(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM board_posts WHERE id = ?").bind(id).first();
}
export async function createBoardPost(db: D1Like, p: BoardPostInput) {
  return db
    .prepare("INSERT INTO board_posts (parent_id, member_id, author_name, body) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(p.parent_id ?? null, p.member_id, p.author_name, p.body)
    .first();
}
export async function deleteBoardPost(db: D1Like, id: number) {
  await db.prepare("DELETE FROM board_posts WHERE id = ?").bind(id).run();
}

// ---------------- fundraisers ----------------
export interface FundraiserInput {
  title: string;
  body_md?: string | null;
  goal_cents?: number | null;
  raised_cents?: number | null;
  paypal_url?: string | null;
  status?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  created_by?: string | null;
}
export async function listFundraisers(db: D1Like) {
  return (await db.prepare("SELECT * FROM fundraisers ORDER BY (status = 'active') DESC, id DESC").all()).results;
}
export async function getFundraiser(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM fundraisers WHERE id = ?").bind(id).first();
}
export async function createFundraiser(db: D1Like, f: FundraiserInput) {
  return db
    .prepare(
      "INSERT INTO fundraisers (title, body_md, goal_cents, raised_cents, paypal_url, status, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(f.title, f.body_md ?? null, f.goal_cents ?? null, f.raised_cents ?? 0, f.paypal_url ?? null, f.status ?? "active", f.starts_at ?? null, f.ends_at ?? null, f.created_by ?? null)
    .first();
}
export type FundraiserPatch = { title?: string | null; body_md?: string | null; goal_cents?: number | null; raised_cents?: number | null; paypal_url?: string | null; status?: string | null; starts_at?: string | null; ends_at?: string | null };
export async function updateFundraiser(db: D1Like, id: number, f: FundraiserPatch) {
  return db
    .prepare(
      `UPDATE fundraisers SET title=COALESCE(?,title), body_md=COALESCE(?,body_md), goal_cents=COALESCE(?,goal_cents),
        raised_cents=COALESCE(?,raised_cents), paypal_url=COALESCE(?,paypal_url), status=COALESCE(?,status),
        starts_at=COALESCE(?,starts_at), ends_at=COALESCE(?,ends_at) WHERE id=? RETURNING *`,
    )
    .bind(f.title ?? null, f.body_md ?? null, f.goal_cents ?? null, f.raised_cents ?? null, f.paypal_url ?? null, f.status ?? null, f.starts_at ?? null, f.ends_at ?? null, id)
    .first();
}
export async function deleteFundraiser(db: D1Like, id: number) {
  await db.prepare("DELETE FROM fundraisers WHERE id = ?").bind(id).run();
}

// ---------------- meetings / minutes ----------------
export interface MeetingInput {
  date: string;
  title: string;
  minutes_md?: string | null;
  action_items?: string | null; // JSON array
  attendees?: string | null; // JSON array
  created_by?: string | null;
}
export async function listMeetings(db: D1Like) {
  return (await db.prepare("SELECT * FROM meetings ORDER BY date DESC, id DESC").all()).results;
}
export async function getMeeting(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
}
export async function createMeeting(db: D1Like, m: MeetingInput) {
  return db
    .prepare("INSERT INTO meetings (date, title, minutes_md, action_items, attendees, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(m.date, m.title, m.minutes_md ?? null, m.action_items ?? null, m.attendees ?? null, m.created_by ?? null)
    .first();
}
export type MeetingPatch = { date?: string | null; title?: string | null; minutes_md?: string | null; action_items?: string | null; attendees?: string | null };
export async function updateMeeting(db: D1Like, id: number, m: MeetingPatch) {
  return db
    .prepare(
      "UPDATE meetings SET date=COALESCE(?,date), title=COALESCE(?,title), minutes_md=COALESCE(?,minutes_md), action_items=COALESCE(?,action_items), attendees=COALESCE(?,attendees) WHERE id=? RETURNING *",
    )
    .bind(m.date ?? null, m.title ?? null, m.minutes_md ?? null, m.action_items ?? null, m.attendees ?? null, id)
    .first();
}
export async function deleteMeeting(db: D1Like, id: number) {
  await db.prepare("DELETE FROM meetings WHERE id = ?").bind(id).run();
}

// ---------------- results (written when a live event is finalized) ----------------
export interface ResultInput {
  event_id: number;
  member_id?: string | null;
  name: string;
  place?: number | null;
  total?: number | null;
  to_par?: number | null;
  rating?: number | null;
  breakdown?: string | null; // JSON {aces,eagles,birdies,pars,bogeys,doubles_plus}
  scorecard?: string | null; // JSON [{hole,par,strokes}] — drives "Add to UDisc"
  weather?: string | null;
}
export async function createResult(db: D1Like, r: ResultInput) {
  return db
    .prepare(
      "INSERT INTO results (event_id, member_id, name, place, total, to_par, rating, breakdown, scorecard, weather) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.event_id, r.member_id ?? null, r.name, r.place ?? null, r.total ?? null, r.to_par ?? null, r.rating ?? null, r.breakdown ?? null, r.scorecard ?? null, r.weather ?? null)
    .first();
}
export async function clearResults(db: D1Like, eventId: number) {
  await db.prepare("DELETE FROM results WHERE event_id = ?").bind(eventId).run();
}
export async function listResults(db: D1Like, eventId: number) {
  return (await db.prepare("SELECT * FROM results WHERE event_id = ? ORDER BY place, total").bind(eventId).all()).results;
}
/** A member's GVDG event history (for the profile/dashboard) — joins results to event names/dates. */
export async function listMemberResults(db: D1Like, memberId: string) {
  return (
    await db
      .prepare(
        `SELECT r.*, e.name AS event_name, e.date AS event_date, e.type AS event_type,
                c.udisc_course_id AS udisc_course_id, c.udisc_url AS udisc_url
         FROM results r JOIN events e ON e.id = r.event_id
         LEFT JOIN courses c ON c.id = e.course_id
         WHERE r.member_id = ? ORDER BY e.date DESC, r.id DESC`,
      )
      .bind(memberId)
      .all()
  ).results;
}

// ---- Casual rounds (durable record of finalized self-organizing rounds; migration 0016) ----
export interface CasualRoundInput {
  round_code: string;
  course_id?: number | null;
  layout_id?: number | null;
  course_name?: string | null;
  layout_name?: string | null;
  holes?: string | null; // JSON [{hole,par,distance_ft}] snapshot as played
  created_by?: string | null;
  started_at?: string | null;
}
/** Remove any prior durable record for a casual round code (cascades to casual_results) so a re-finalize
 *  after a fault/eviction replaces rather than duplicates it — the casual analogue of clearResults(eventId). */
export async function clearCasualRound(db: D1Like, roundCode: string) {
  await db.prepare("DELETE FROM casual_rounds WHERE round_code = ?").bind(roundCode).run();
}
export async function createCasualRound(db: D1Like, r: CasualRoundInput) {
  return db
    .prepare(
      "INSERT INTO casual_rounds (round_code, course_id, layout_id, course_name, layout_name, holes, created_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.round_code, r.course_id ?? null, r.layout_id ?? null, r.course_name ?? null, r.layout_name ?? null, r.holes ?? null, r.created_by ?? null, r.started_at ?? null)
    .first();
}
export interface CasualResultInput {
  casual_round_id: number;
  member_id?: string | null;
  name: string;
  division?: string | null;
  place?: number | null;
  total?: number | null;
  to_par?: number | null;
  breakdown?: string | null; // JSON {aces,eagles,birdies,pars,bogeys,doubles_plus}
  scorecard?: string | null; // JSON [{hole,par,strokes}]
}
export async function createCasualResult(db: D1Like, r: CasualResultInput) {
  return db
    .prepare(
      "INSERT INTO casual_results (casual_round_id, member_id, name, division, place, total, to_par, breakdown, scorecard) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.casual_round_id, r.member_id ?? null, r.name, r.division ?? null, r.place ?? null, r.total ?? null, r.to_par ?? null, r.breakdown ?? null, r.scorecard ?? null)
    .first();
}
/** Finalized results for a casual round by its share code (the most recent finalized round for that code). */
export async function listCasualRoundResults(db: D1Like, roundCode: string) {
  const round = (await db.prepare("SELECT * FROM casual_rounds WHERE round_code = ? ORDER BY id DESC LIMIT 1").bind(roundCode).first()) as { id?: number } | null;
  if (!round?.id) return null;
  const results = (await db.prepare("SELECT * FROM casual_results WHERE casual_round_id = ? ORDER BY place IS NULL, place, total").bind(round.id).all()).results;
  return { round, results };
}
/** A member's finalized CASUAL round history (for the dashboard) — joins the round header for course/layout. */
export async function listMemberCasualResults(db: D1Like, memberId: string) {
  return (
    await db
      .prepare(
        `SELECT cr.*, r.round_code, r.course_name, r.layout_name, r.layout_id, r.finalized_at, r.holes AS round_holes,
                c.udisc_course_id AS udisc_course_id
         FROM casual_results cr JOIN casual_rounds r ON r.id = cr.casual_round_id
         LEFT JOIN courses c ON c.id = r.course_id
         WHERE cr.member_id = ? ORDER BY r.finalized_at DESC, cr.id DESC`,
      )
      .bind(memberId)
      .all()
  ).results;
}

// ---- Tee signs (T1) ----
export interface TeeSignRow {
  id: number; course_id: number; hole_number: number; r2_key: string;
  content_type: string; bytes: number; uploaded_by: string; created_at: string;
  status: string; extracted_json: string | null; extract_source: string | null;
  reviewed_by: string | null; reviewed_at: string | null;
}

export async function insertTeeSign(db: D1Like, t: {
  course_id: number; hole_number: number; r2_key: string; content_type: string; bytes: number; uploaded_by: string;
}) {
  return db.prepare(
    "INSERT INTO tee_signs (course_id, hole_number, r2_key, content_type, bytes, uploaded_by, status) " +
    "VALUES (?, ?, ?, ?, ?, ?, 'candidate') RETURNING *",
  ).bind(t.course_id, t.hole_number, t.r2_key, t.content_type, t.bytes, t.uploaded_by).first();
}

export async function getTeeSign(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM tee_signs WHERE id = ?").bind(id).first() as Promise<TeeSignRow | null>;
}

export async function listMyTeeSigns(db: D1Like, memberId: string) {
  return (await db.prepare(
    "SELECT * FROM tee_signs WHERE uploaded_by = ? ORDER BY created_at DESC",
  ).bind(memberId).all()).results;
}

export async function listTeeSignsByStatus(db: D1Like, status: string) {
  return (await db.prepare(
    "SELECT * FROM tee_signs WHERE status = ? ORDER BY course_id, hole_number, created_at",
  ).bind(status).all()).results;
}

/** Tee signs for a course, restricted to the given statuses (T4 render). Only the columns the UI needs.
 *  `statuses` is a code-controlled allowlist (never user input) so the inlined IN-list is injection-safe. */
export async function listTeeSignsByCourse(db: D1Like, courseId: number, statuses: string[]) {
  if (!statuses.length) return [];
  const placeholders = statuses.map(() => "?").join(",");
  return (await db.prepare(
    `SELECT id, hole_number, status FROM tee_signs WHERE course_id = ? AND status IN (${placeholders}) ORDER BY hole_number, created_at`,
  ).bind(courseId, ...statuses).all()).results;
}

export async function setTeeSignStatus(db: D1Like, id: number, status: string, reviewedBy: string) {
  return db.prepare(
    "UPDATE tee_signs SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? RETURNING *",
  ).bind(status, reviewedBy, id).first();
}

/** Delete a tee-sign row and return its R2 key so the caller can reclaim the stored object. */
export async function deleteTeeSign(db: D1Like, id: number): Promise<string | null> {
  const row = await db.prepare("DELETE FROM tee_signs WHERE id = ? RETURNING r2_key").bind(id).first<{ r2_key: string }>();
  return row?.r2_key ?? null;
}

// ---- Layout matching / defaults ----
export function normalizeLayoutLabel(label: unknown): string {
  return String(label ?? "").toLowerCase().replace(/\b(tees?|layout|pads?)\b/g, "").replace(/\s+/g, " ").trim();
}

export function defaultLayoutName(label: unknown): string {
  const n = normalizeLayoutLabel(label);
  if (n === "long") return "Long";
  if (n === "short") return "Short";
  if (!n) return "Main";
  return n.charAt(0).toUpperCase() + n.slice(1); // title-cased echo of an unknown label (e.g. "Blue")
}

/** Find an existing layout for the course whose name matches the label (normalized), else null. */
/** The (id,name) of every layout on a course — small projection used for label matching. */
export async function listLayoutNames(db: D1Like, courseId: number): Promise<{ id: number; name: string }[]> {
  return (await db.prepare("SELECT id, name FROM course_layouts WHERE course_id = ?").bind(courseId).all()).results as { id: number; name: string }[];
}
/** Pure label→layout match over already-fetched rows, so a caller looping many labels for one course can
 *  fetch that course's layouts once (via listLayoutNames) instead of re-querying per label. */
export function matchLayoutIn(rows: { id: number; name: string }[], label: unknown): { id: number; name: string } | null {
  const want = normalizeLayoutLabel(label) || normalizeLayoutLabel(defaultLayoutName(label));
  for (const r of rows) if (normalizeLayoutLabel(r.name) === want) return { id: r.id, name: r.name };
  return null;
}
export async function matchLayout(db: D1Like, courseId: number, label: unknown): Promise<{ id: number; name: string } | null> {
  return matchLayoutIn(await listLayoutNames(db, courseId), label);
}

/** Ensure the course has Long + Short layouts; returns nothing (idempotent). */
export async function ensureDefaultLayouts(db: D1Like, courseId: number) {
  for (const name of ["Long", "Short"]) {
    if (!(await matchLayout(db, courseId, name))) {
      await createLayout(db, { course_id: courseId, name, holes: [], total_par: null });
    }
  }
}

export interface ApproveRow {
  layoutId?: number | null;
  newLayoutName?: string | null;
  par: number;
  distance_ft?: number | null;
  tee?: string | null;
  target?: string | null;
  color?: string | null;
}

/** Apply confirmed tee-sign rows: for each row resolve/create a layout and write hole `hole` with
 *  {par, distance_ft, tee_sign_key, (tee/target labels)}, then stamp the official photo key on it.
 *  Returns the list of affected layout ids. The official-photo bookkeeping (status flip / demote prior)
 *  is done by the caller via setTeeSignStatus + demoteOtherOfficial. */
export async function applyTeeSignRows(
  db: D1Like, courseId: number, hole: number, rows: ApproveRow[], teeSignKey: string, teeSignId: number,
): Promise<number[]> {
  const affected: number[] = [];
  for (const row of rows) {
    let layoutId = row.layoutId ?? null;
    if (layoutId == null) {
      const name = (row.newLayoutName && String(row.newLayoutName).slice(0, 80)) || "Main";
      const created = (await createLayout(db, { course_id: courseId, name, holes: [], total_par: null })) as { id: number };
      layoutId = created.id;
    }
    const layout = (await getLayout(db, layoutId)) as { holes?: string } | null;
    const holes: Record<string, unknown>[] = JSON.parse(layout?.holes ?? "[]");
    const idx = holes.findIndex((h) => Number(h.hole) === hole);
    // The confirmed sign becomes the hole's VERIFIED (sticky) par + distance. Clearing manual_distance
    // reverts any earlier manual stopgap — verified now owns the value (enrichHoles resolves it).
    const entry: Record<string, unknown> = {
      hole, par: row.par,
      verified: { par: row.par, distance_ft: row.distance_ft ?? null, tee_sign_key: teeSignKey, tee_sign_id: teeSignId },
      manual_distance: null,
      tee: row.tee ? { label: String(row.tee).slice(0, 80) } : null,
      target: row.target ? { label: String(row.target).slice(0, 80) } : null,
      color: row.color ?? null,
      tee_sign_key: teeSignKey,
      tee_sign_id: teeSignId,
    };
    if (idx >= 0) holes[idx] = { ...holes[idx], ...entry }; else holes.push(entry);
    holes.sort((a, b) => Number(a.hole) - Number(b.hole));
    const enriched = enrichHoles(holes as unknown as LayoutHole[]); // resolves verified → distance_ft/source + total_par
    await updateLayout(db, layoutId, { holes: enriched.holes, total_par: enriched.total_par });
    affected.push(layoutId);
  }
  return affected;
}

/** Demote any OTHER official tee sign for the same (course, hole) to 'rejected' so there is one official.
 *  Returns the R2 keys of the demoted signs (no longer referenced) so the caller can reclaim them. */
export async function demoteOtherOfficial(db: D1Like, courseId: number, hole: number, keepId: number): Promise<string[]> {
  const res = await db.prepare(
    "UPDATE tee_signs SET status = 'rejected' WHERE course_id = ? AND hole_number = ? AND status = 'official' AND id != ? RETURNING r2_key",
  ).bind(courseId, hole, keepId).all<{ r2_key: string }>();
  return res.results.map((r) => r.r2_key);
}

/** Store the vision extraction result on a tee sign row (T2). */
export async function setTeeSignExtraction(db: D1Like, id: number, extractedJson: string, source: string | null) {
  await db.prepare("UPDATE tee_signs SET extracted_json = ?, extract_source = ? WHERE id = ?")
    .bind(extractedJson, source, id).run();
}
