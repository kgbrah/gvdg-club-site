import type { D1Like } from "./db-types.js";

export type UdiscImportStatus = "queued" | "imported" | "skipped" | "failed" | "no_url" | "no_layouts";

export interface UdiscImportRow {
  course_id: number;
  status: string;
  udisc_url: string | null;
  layouts_imported: number;
  mapped: number;
  error: string | null;
  attempts: number;
  attempted_at: number | null;
  finished_at: number | null;
}

export interface UdiscImportState {
  id: number;
  hydrated_at: number | null;
  last_course_id: number | null;
  last_status: string | null;
  last_name: string | null;
  last_error: string | null;
  last_run_at: number | null;
}

export async function listUdiscImports(db: D1Like): Promise<UdiscImportRow[]> {
  return (await db.prepare("SELECT * FROM udisc_layout_imports").all<UdiscImportRow>()).results ?? [];
}

export async function getUdiscImportState(db: D1Like): Promise<UdiscImportState | null> {
  return db.prepare("SELECT * FROM udisc_layout_import_state WHERE id = 1").first<UdiscImportState>();
}

export async function markUdiscImportHydrated(db: D1Like, at: number): Promise<void> {
  await db.prepare("UPDATE udisc_layout_import_state SET hydrated_at = COALESCE(hydrated_at, ?) WHERE id = 1").bind(at).run();
}

export async function upsertUdiscImport(
  db: D1Like,
  row: {
    course_id: number;
    status: string;
    udisc_url?: string | null;
    layouts_imported?: number;
    mapped?: number;
    error?: string | null;
    attempts?: number;
    attempted_at?: number | null;
    finished_at?: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO udisc_layout_imports (course_id, status, udisc_url, layouts_imported, mapped, error, attempts, attempted_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(course_id) DO UPDATE SET
         status=excluded.status,
         udisc_url=COALESCE(excluded.udisc_url, udisc_layout_imports.udisc_url),
         layouts_imported=excluded.layouts_imported,
         mapped=excluded.mapped,
         error=excluded.error,
         attempts=excluded.attempts,
         attempted_at=excluded.attempted_at,
         finished_at=excluded.finished_at`,
    )
    .bind(
      row.course_id,
      row.status,
      row.udisc_url ?? null,
      row.layouts_imported ?? 0,
      row.mapped ?? 0,
      row.error ?? null,
      row.attempts ?? 0,
      row.attempted_at ?? null,
      row.finished_at ?? null,
    )
    .run();
}

export async function recordUdiscImportTick(
  db: D1Like,
  tick: {
    last_course_id?: number | null;
    last_status: string;
    last_name?: string | null;
    last_error?: string | null;
    last_run_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE udisc_layout_import_state
       SET last_course_id = ?, last_status = ?, last_name = ?, last_error = ?, last_run_at = ?
       WHERE id = 1`,
    )
    .bind(tick.last_course_id ?? null, tick.last_status, tick.last_name ?? null, tick.last_error ?? null, tick.last_run_at)
    .run();
}
