import type { D1Like } from "./db-types.js";

export interface LiveRoundIndexRow {
  key: string;
  course_id?: number | null;
  course_name?: string | null;
  layout_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  started_at?: string | null;
}

export async function rememberLiveRound(db: D1Like, row: LiveRoundIndexRow): Promise<void> {
  const key = String(row.key || "").trim();
  if (!key) return;
  await db.prepare(
    `INSERT INTO live_round_index (key, course_id, course_name, layout_name, lat, lng, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       course_id = excluded.course_id,
       course_name = excluded.course_name,
       layout_name = excluded.layout_name,
       lat = excluded.lat,
       lng = excluded.lng,
       started_at = excluded.started_at`,
  ).bind(
    key,
    row.course_id ?? null,
    row.course_name ?? null,
    row.layout_name ?? null,
    row.lat ?? null,
    row.lng ?? null,
    row.started_at || new Date().toISOString(),
  ).run();
}

export async function forgetLiveRound(db: D1Like, key: string): Promise<void> {
  const id = String(key || "").trim();
  if (!id) return;
  await db.prepare("DELETE FROM live_round_index WHERE key = ?").bind(id).run();
}

export async function listLiveRoundIndex(db: D1Like): Promise<LiveRoundIndexRow[]> {
  const listed = await db.prepare(
    "SELECT key, course_id, course_name, layout_name, lat, lng, started_at FROM live_round_index ORDER BY started_at DESC LIMIT 40",
  ).all<LiveRoundIndexRow>();
  return listed.results || [];
}
