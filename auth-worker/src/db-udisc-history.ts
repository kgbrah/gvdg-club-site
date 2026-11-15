import type { D1Like } from "./db-types.js";
import { runBatch } from "./db-results.js";
import type { UdiscHistoryRound } from "./imports/udisc-history.js";

export interface UdiscHistoryRow {
  id: number;
  player_name: string;
  course_name: string;
  layout_name: string;
  played_at: string;
  total: number | null;
  to_par: number | null;
  holes: string;
}

export async function listUdiscHistory(db: D1Like, memberId: string, limit: number): Promise<UdiscHistoryRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, player_name, course_name, layout_name, played_at, total, to_par, holes
           FROM udisc_history
          WHERE member_id = ?
          ORDER BY played_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(memberId, limit)
      .all<UdiscHistoryRow>()
  ).results;
  return Array.isArray(rows) ? rows : [];
}

export async function upsertUdiscHistory(db: D1Like, memberId: string, rounds: readonly UdiscHistoryRound[]): Promise<void> {
  const statements = rounds.map((round) =>
    db
      .prepare(
        `INSERT INTO udisc_history (
           member_id, round_key, player_name, course_name, layout_name, played_at, total, to_par, holes, source_played_at, source_finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id, round_key) DO UPDATE SET
           player_name = excluded.player_name,
           course_name = excluded.course_name,
           layout_name = excluded.layout_name,
           played_at = excluded.played_at,
           source_played_at = COALESCE(excluded.source_played_at, udisc_history.source_played_at),
           source_finished_at = COALESCE(excluded.source_finished_at, udisc_history.source_finished_at),
           total = excluded.total,
           to_par = excluded.to_par,
           holes = excluded.holes,
           imported_at = datetime('now')`,
      )
      .bind(
        memberId,
        round.roundKey,
        round.playerName,
        round.courseName,
        round.layoutName,
        round.playedAt,
        round.total,
        round.toPar,
        JSON.stringify(round.holes),
        round.sourcePlayedAt ?? null,
        round.sourceFinishedAt ?? null,
      ),
  );
  for (let i = 0; i < statements.length; i += 40) {
    await runBatch(db, statements.slice(i, i + 40));
  }
}

export async function deleteUdiscHistory(db: D1Like, memberId: string, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM udisc_history WHERE member_id = ? AND id = ?").bind(memberId, id).run();
  const changes = result.meta?.changes ?? result.meta?.rows_written;
  return changes == null ? true : changes > 0;
}

export async function clearUdiscHistory(db: D1Like, memberId: string): Promise<void> {
  await db.prepare("DELETE FROM udisc_history WHERE member_id = ?").bind(memberId).run();
}

export interface UdiscStatSourceRow {
  course_name: string;
  layout_name: string;
  to_par: number | null;
  holes: string;
}

export async function listUdiscStatSources(db: D1Like, memberId: string): Promise<UdiscStatSourceRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT course_name, layout_name, to_par, holes
           FROM udisc_history
          WHERE member_id = ?
          LIMIT 2000`,
      )
      .bind(memberId)
      .all<UdiscStatSourceRow>()
  ).results;
  return Array.isArray(rows) ? rows : [];
}
