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
export async function deleteLayout(db: D1Like, id: number) {
  await db.prepare("DELETE FROM course_layouts WHERE id = ?").bind(id).run();
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
