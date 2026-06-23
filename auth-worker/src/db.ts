// D1 data-access layer for club operations (Phase 1).
// ALL queries are parameterized via .bind() — never string-interpolate user input.

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
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
      "INSERT INTO courses (name, location, udisc_url, lat, lng, is_default, created_by) VALUES (?, ?, ?, ?, ?, 0, ?) RETURNING *",
    )
    .bind(c.name, c.location ?? null, c.udisc_url ?? null, c.lat ?? null, c.lng ?? null, c.created_by ?? null)
    .first();
}
// Patch types: a null field means "leave unchanged" (COALESCE), matching the asStr()/asInt() helpers.
export type CoursePatch = { name?: string | null; location?: string | null; udisc_url?: string | null; lat?: number | null; lng?: number | null };
export type EventPatch = {
  name?: string | null; status?: string | null; format?: string | null; date?: string | null;
  course_id?: number | null; layout_id?: number | null; league_id?: number | null; notes?: string | null;
};

export async function updateCourse(db: D1Like, id: number, c: CoursePatch) {
  return db
    .prepare(
      "UPDATE courses SET name=COALESCE(?,name), location=COALESCE(?,location), udisc_url=COALESCE(?,udisc_url), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=? RETURNING *",
    )
    .bind(c.name ?? null, c.location ?? null, c.udisc_url ?? null, c.lat ?? null, c.lng ?? null, id)
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
    .prepare("INSERT INTO course_positions (course_id, kind, label, lat, lng) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(p.course_id, p.kind, p.label, p.lat ?? null, p.lng ?? null)
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
export async function deleteLeague(db: D1Like, id: number) {
  await db.prepare("DELETE FROM leagues WHERE id = ?").bind(id).run();
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
      `UPDATE events SET name=COALESCE(?,name), status=COALESCE(?,status), format=COALESCE(?,format),
        date=COALESCE(?,date), course_id=COALESCE(?,course_id), layout_id=COALESCE(?,layout_id),
        league_id=COALESCE(?,league_id), notes=COALESCE(?,notes), updated_at=datetime('now') WHERE id=? RETURNING *`,
    )
    .bind(e.name ?? null, e.status ?? null, e.format ?? null, e.date ?? null, e.course_id ?? null,
      e.layout_id ?? null, e.league_id ?? null, e.notes ?? null, id)
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
}
export async function createResult(db: D1Like, r: ResultInput) {
  return db
    .prepare(
      "INSERT INTO results (event_id, member_id, name, place, total, to_par, rating, breakdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(r.event_id, r.member_id ?? null, r.name, r.place ?? null, r.total ?? null, r.to_par ?? null, r.rating ?? null, r.breakdown ?? null)
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
        `SELECT r.*, e.name AS event_name, e.date AS event_date, e.type AS event_type
         FROM results r JOIN events e ON e.id = r.event_id
         WHERE r.member_id = ? ORDER BY e.date DESC, r.id DESC`,
      )
      .bind(memberId)
      .all()
  ).results;
}
