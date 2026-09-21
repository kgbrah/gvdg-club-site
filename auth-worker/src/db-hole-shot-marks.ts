import type { D1Like } from "./db-types.js";
import { runBatch } from "./db-results.js";
import { readD1OrFallback } from "./d1-retry.js";
import {
  HEATMAP_HARVEST_ROUNDS,
  marksFromScorecard,
  marksFromThrows,
  shotMemberKey,
  shotRoundKey,
  type HeatmapPoint,
  type ShotMark,
} from "./hole-shot-marks.js";

const INSERT_MARK_SQL =
  `INSERT OR REPLACE INTO hole_shot_marks (layout_id, hole, throw_n, lat, lng, member_id, round_code)
   VALUES (?, ?, ?, ?, ?, ?, ?)`;

function insertMarkStmt(
  db: D1Like,
  layoutId: number,
  hole: number,
  mark: HeatmapPoint,
  memberId: string,
  roundCode: string,
) {
  return db.prepare(INSERT_MARK_SQL).bind(layoutId, hole, mark.n, mark.lat, mark.lng, memberId, roundCode);
}

async function writePlayerHoleMarks(
  db: D1Like,
  layoutId: number,
  hole: number,
  roundCode: string,
  memberId: string,
  throws: HeatmapPoint[],
): Promise<void> {
  if (!throws.length) return;
  await runBatch(
    db,
    throws.map((mark) => insertMarkStmt(db, layoutId, hole, mark, memberId, roundCode)),
  );
}

export async function replacePlayerHoleMarks(
  db: D1Like,
  input: {
    layoutId: number;
    hole: number;
    roundCode: string;
    memberId: string;
    throws: unknown;
  },
): Promise<void> {
  const layoutId = Number(input.layoutId);
  const hole = Number(input.hole);
  if (!Number.isInteger(layoutId) || layoutId <= 0) return;
  if (!Number.isInteger(hole) || hole < 1 || hole > 36) return;
  const roundCode = shotRoundKey(input.roundCode);
  const memberId = shotMemberKey(input.memberId);
  const throws = marksFromThrows(input.throws);
  await db
    .prepare("DELETE FROM hole_shot_marks WHERE layout_id = ? AND hole = ? AND round_code = ? AND member_id = ?")
    .bind(layoutId, hole, roundCode, memberId)
    .run();
  await writePlayerHoleMarks(db, layoutId, hole, roundCode, memberId, throws);
}

export async function ingestScorecardMarks(
  db: D1Like,
  input: {
    layoutId: number;
    roundCode: string;
    memberId: string;
    scorecard: unknown;
  },
): Promise<number> {
  const holes = marksFromScorecard(input.scorecard);
  for (const hole of holes) {
    await replacePlayerHoleMarks(db, {
      layoutId: input.layoutId,
      hole: hole.hole,
      roundCode: input.roundCode,
      memberId: input.memberId,
      throws: hole.throws,
    });
  }
  return holes.reduce((sum, hole) => sum + hole.throws.length, 0);
}

export async function listHoleShotMarks(db: D1Like, layoutId: number, hole: number): Promise<ShotMark[]> {
  const rows = (await readD1OrFallback(
    () =>
      db
        .prepare(
          `SELECT lat, lng, throw_n, member_id
             FROM hole_shot_marks
            WHERE layout_id = ? AND hole = ?
            ORDER BY throw_n, id
            LIMIT 800`,
        )
        .bind(layoutId, hole)
        .all(),
    () => ({ results: [], success: true }),
  )).results as Record<string, unknown>[];
  return rows.flatMap((row) => {
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    const n = Number(row.throw_n);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    return [{
      lat,
      lng,
      n: Number.isInteger(n) && n >= 1 ? n : 1,
      memberId: String(row.member_id || ""),
    }];
  });
}

export async function harvestLayoutScorecardMarks(db: D1Like, layoutId: number): Promise<number> {
  const id = Number(layoutId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const claimed = await db.prepare("INSERT OR IGNORE INTO hole_shot_harvest (layout_id) VALUES (?)").bind(id).run();
  if (claimed && claimed.meta && claimed.meta.changes === 0) return 0;
  let wrote = 0;
  try {
    const casual = (await readD1OrFallback(
      () =>
        db
          .prepare(
            `SELECT r.round_code, cr.member_id, cr.scorecard
               FROM casual_results cr
               JOIN casual_rounds r ON r.id = cr.casual_round_id
              WHERE r.layout_id = ? AND cr.scorecard IS NOT NULL
              ORDER BY cr.id DESC
              LIMIT ?`,
          )
          .bind(id, HEATMAP_HARVEST_ROUNDS)
          .all(),
      () => ({ results: [], success: true }),
    )).results as Record<string, unknown>[];
    for (const row of casual) {
      wrote += await ingestScorecardMarks(db, {
        layoutId: id,
        roundCode: shotRoundKey(String(row.round_code || "")),
        memberId: shotMemberKey(row.member_id == null ? "" : String(row.member_id)),
        scorecard: row.scorecard,
      });
    }
    const events = (await readD1OrFallback(
      () =>
        db
          .prepare(
            `SELECT e.id AS event_id, res.member_id, res.scorecard
               FROM results res
               JOIN events e ON e.id = res.event_id
              WHERE e.layout_id = ? AND res.scorecard IS NOT NULL
              ORDER BY res.id DESC
              LIMIT ?`,
          )
          .bind(id, HEATMAP_HARVEST_ROUNDS)
          .all(),
      () => ({ results: [], success: true }),
    )).results as Record<string, unknown>[];
    for (const row of events) {
      wrote += await ingestScorecardMarks(db, {
        layoutId: id,
        roundCode: shotRoundKey(null, Number(row.event_id)),
        memberId: shotMemberKey(row.member_id == null ? "" : String(row.member_id)),
        scorecard: row.scorecard,
      });
    }
  } catch (error) {
    await db.prepare("DELETE FROM hole_shot_harvest WHERE layout_id = ?").bind(id).run();
    throw error;
  }
  return wrote;
}

export type { HeatmapPoint };
