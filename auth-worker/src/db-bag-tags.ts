import type { D1Like, D1StatementLike } from "./db-types.js";
import type { TagAssignment } from "./bag-tags.js";

export interface BagSeriesRow {
  id: number;
  name: string;
  season: string | null;
  active: number;
}

export interface BagHolderRow {
  series_id: number;
  tag_number: number;
  member_id: string;
  member_name: string;
  held_since: string;
}

export interface BagMoveRow {
  id: number;
  series_id: number;
  kind: string;
  summary: string;
  actor_id: string | null;
  created_at: string;
}

export interface BagChallengeRow {
  id: number;
  series_id: number;
  challenger_id: string;
  challenger_name: string;
  defender_id: string;
  defender_name: string;
  challenger_tag: number;
  defender_tag: number;
  challenger_score: number;
  defender_score: number;
  status: string;
  created_at: string;
  league_id?: number | null;
  closed_note?: string | null;
  closed_at?: string | null;
}

export async function activeSeries(db: D1Like): Promise<BagSeriesRow | null> {
  return db.prepare(
    "SELECT id, name, season, active FROM bag_tag_series WHERE active = 1 ORDER BY id DESC LIMIT 1",
  ).first<BagSeriesRow>();
}

export async function getSeries(db: D1Like, id: number): Promise<BagSeriesRow | null> {
  return db.prepare(
    "SELECT id, name, season, active FROM bag_tag_series WHERE id = ?",
  ).bind(id).first<BagSeriesRow>();
}

export async function createSeries(
  db: D1Like,
  input: { name: string; season: string | null; createdBy: string },
): Promise<BagSeriesRow | null> {
  await db.prepare("UPDATE bag_tag_series SET active = 0 WHERE active = 1").run();
  return db.prepare(
    "INSERT INTO bag_tag_series (name, season, active, created_by) VALUES (?, ?, 1, ?) RETURNING id, name, season, active",
  ).bind(input.name, input.season, input.createdBy).first<BagSeriesRow>();
}

export async function listHolders(db: D1Like, seriesId: number): Promise<BagHolderRow[]> {
  const rows = await db.prepare(
    "SELECT series_id, tag_number, member_id, member_name, held_since FROM bag_tag_holders WHERE series_id = ? ORDER BY tag_number",
  ).bind(seriesId).all<BagHolderRow>();
  return rows.results;
}

export async function listMoves(db: D1Like, seriesId: number): Promise<BagMoveRow[]> {
  const rows = await db.prepare(
    "SELECT id, series_id, kind, summary, actor_id, created_at FROM bag_tag_moves WHERE series_id = ? ORDER BY id DESC LIMIT 20",
  ).bind(seriesId).all<BagMoveRow>();
  return rows.results;
}

export async function holderByMember(db: D1Like, seriesId: number, memberId: string): Promise<BagHolderRow | null> {
  return db.prepare(
    "SELECT series_id, tag_number, member_id, member_name, held_since FROM bag_tag_holders WHERE series_id = ? AND member_id = ?",
  ).bind(seriesId, memberId).first<BagHolderRow>();
}

export async function holderByTag(db: D1Like, seriesId: number, tagNumber: number): Promise<BagHolderRow | null> {
  return db.prepare(
    "SELECT series_id, tag_number, member_id, member_name, held_since FROM bag_tag_holders WHERE series_id = ? AND tag_number = ?",
  ).bind(seriesId, tagNumber).first<BagHolderRow>();
}

export async function recordMove(
  db: D1Like,
  move: { seriesId: number; kind: string; summary: string; actorId: string },
): Promise<void> {
  await db.prepare(
    "INSERT INTO bag_tag_moves (series_id, kind, summary, actor_id) VALUES (?, ?, ?, ?)",
  ).bind(move.seriesId, move.kind, move.summary, move.actorId).run();
}

export async function giveTag(
  db: D1Like,
  input: { seriesId: number; tagNumber: number; memberId: string; memberName: string },
): Promise<void> {
  await runAll(db, [
    db.prepare("DELETE FROM bag_tag_holders WHERE series_id = ? AND member_id = ?")
      .bind(input.seriesId, input.memberId),
    db.prepare("INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES (?, ?, ?, ?)")
      .bind(input.seriesId, input.tagNumber, input.memberId, input.memberName),
  ]);
}

export async function releaseTag(db: D1Like, seriesId: number, memberId: string): Promise<void> {
  await db.prepare(
    "DELETE FROM bag_tag_holders WHERE series_id = ? AND member_id = ?",
  ).bind(seriesId, memberId).run();
}

async function runAll(db: D1Like, statements: D1StatementLike[]): Promise<void> {
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export async function replaceTags(
  db: D1Like,
  seriesId: number,
  assignments: readonly TagAssignment[],
  move: { kind: string; summary: string; actorId: string },
): Promise<void> {
  const statements = assignments.map((assignment) => db.prepare(
    "DELETE FROM bag_tag_holders WHERE series_id = ? AND tag_number = ?",
  ).bind(seriesId, assignment.tagNumber));
  for (const assignment of assignments) {
    statements.push(db.prepare(
      "INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES (?, ?, ?, ?)",
    ).bind(seriesId, assignment.tagNumber, assignment.memberId, assignment.name));
  }
  statements.push(db.prepare(
    "INSERT INTO bag_tag_moves (series_id, kind, summary, actor_id) VALUES (?, ?, ?, ?)",
  ).bind(seriesId, move.kind, move.summary, move.actorId));
  await runAll(db, statements);
}

/** Atomically verify the series is active and both holders still match, claim the challenge, swap if needed, and record the move. */
export async function confirmSeriesChallenge(
  db: D1Like,
  input: {
    challengeId: number;
    seriesId: number;
    challengerId: string;
    challengerName: string;
    challengerTag: number;
    defenderId: string;
    defenderName: string;
    defenderTag: number;
    swapped: boolean;
    summary: string;
    actorId: string;
  },
): Promise<boolean> {
  const token = `settling:${crypto.randomUUID()}`;
  const claimStmt = db.prepare(
    `UPDATE bag_tag_challenges
     SET status = 'settled', closed_note = ?, closed_at = datetime('now')
     WHERE id = ? AND status = 'pending' AND series_id = ? AND league_id IS NULL
       AND EXISTS (SELECT 1 FROM bag_tag_series WHERE id = ? AND active = 1)
       AND EXISTS (SELECT 1 FROM bag_tag_holders WHERE series_id = ? AND member_id = ? AND tag_number = ?)
       AND EXISTS (SELECT 1 FROM bag_tag_holders WHERE series_id = ? AND member_id = ? AND tag_number = ?)`,
  ).bind(
    token, input.challengeId, input.seriesId, input.seriesId,
    input.seriesId, input.challengerId, input.challengerTag,
    input.seriesId, input.defenderId, input.defenderTag,
  );
  const tail: D1StatementLike[] = [];
  if (input.swapped) {
    tail.push(
      db.prepare(
        `DELETE FROM bag_tag_holders
         WHERE series_id = ?
           AND ((member_id = ? AND tag_number = ?) OR (member_id = ? AND tag_number = ?))
           AND EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
      ).bind(
        input.seriesId,
        input.challengerId, input.challengerTag,
        input.defenderId, input.defenderTag,
        input.challengeId, token,
      ),
      db.prepare(
        `INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
      ).bind(input.seriesId, input.defenderTag, input.challengerId, input.challengerName, input.challengeId, token),
      db.prepare(
        `INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
      ).bind(input.seriesId, input.challengerTag, input.defenderId, input.defenderName, input.challengeId, token),
    );
  }
  tail.push(
    db.prepare(
      `INSERT INTO bag_tag_moves (series_id, kind, summary, actor_id)
       SELECT ?, 'challenge', ?, ? WHERE EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
    ).bind(input.seriesId, input.summary, input.actorId, input.challengeId, token),
    db.prepare(
      "UPDATE bag_tag_challenges SET closed_note = NULL WHERE id = ? AND closed_note = ?",
    ).bind(input.challengeId, token),
  );
  if (db.batch) {
    const res = await db.batch([claimStmt, ...tail]) as Array<{ meta?: { changes?: number } }>;
    return Number(res[0]?.meta?.changes) > 0;
  }
  const claimed = await claimStmt.run() as { meta?: { changes?: number } };
  if (!(Number(claimed.meta?.changes) > 0)) return false;
  for (const stmt of tail) await stmt.run();
  return true;
}

export async function openChallengeBetween(
  db: D1Like,
  seriesId: number,
  challengerId: string,
): Promise<BagChallengeRow | null> {
  return db.prepare(
    "SELECT * FROM bag_tag_challenges WHERE series_id = ? AND league_id IS NULL AND challenger_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
  ).bind(seriesId, challengerId).first<BagChallengeRow>();
}

export async function createChallenge(
  db: D1Like,
  input: {
    seriesId: number;
    challengerId: string;
    challengerName: string;
    defenderId: string;
    defenderName: string;
    challengerTag: number;
    defenderTag: number;
    challengerScore: number;
    defenderScore: number;
    /** Set for an imported league ladder; seriesId is 0 then. */
    leagueId?: number | null;
  },
): Promise<BagChallengeRow | null> {
  return db.prepare(
    `INSERT INTO bag_tag_challenges (
      series_id, challenger_id, challenger_name, defender_id, defender_name,
      challenger_tag, defender_tag, challenger_score, defender_score, league_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(
    input.seriesId,
    input.challengerId,
    input.challengerName,
    input.defenderId,
    input.defenderName,
    input.challengerTag,
    input.defenderTag,
    input.challengerScore,
    input.defenderScore,
    input.leagueId ?? null,
  ).first<BagChallengeRow>();
}

export async function getChallenge(db: D1Like, id: number): Promise<BagChallengeRow | null> {
  return db.prepare("SELECT * FROM bag_tag_challenges WHERE id = ?").bind(id).first<BagChallengeRow>();
}

/** One confirm wins. A second click finds the row already closed. */
export async function claimChallenge(
  db: D1Like,
  id: number,
  status: "settled" | "declined" | "cancelled",
  note: string | null = null,
): Promise<boolean> {
  const row = await db.prepare(
    "UPDATE bag_tag_challenges SET status = ?, closed_note = ?, closed_at = datetime('now') WHERE id = ? AND status = 'pending' RETURNING id",
  ).bind(status, note, id).first<{ id: number }>();
  return row != null;
}

/** Reopens a claimed challenge to pending when post-claim settlement fails. */
export async function reopenChallenge(db: D1Like, id: number): Promise<void> {
  await db.prepare(
    "UPDATE bag_tag_challenges SET status = 'pending', closed_note = NULL, closed_at = NULL WHERE id = ? AND status = 'settled'",
  ).bind(id).run();
}

export interface BagRequestRow {
  series_id: number;
  member_id: string;
  member_name: string;
  created_at: string;
}

export async function pendingChallenges(db: D1Like, seriesId: number, memberId?: string): Promise<BagChallengeRow[]> {
  if (memberId) {
    const rows = await db.prepare(
      `SELECT * FROM bag_tag_challenges
       WHERE series_id = ? AND league_id IS NULL AND status = 'pending' AND (challenger_id = ? OR defender_id = ?)
       ORDER BY id DESC`,
    ).bind(seriesId, memberId, memberId).all<BagChallengeRow>();
    return rows.results;
  }
  const rows = await db.prepare(
    "SELECT * FROM bag_tag_challenges WHERE series_id = ? AND league_id IS NULL AND status = 'pending' ORDER BY id DESC",
  ).bind(seriesId).all<BagChallengeRow>();
  return rows.results;
}

export async function requestByMember(db: D1Like, seriesId: number, memberId: string): Promise<BagRequestRow | null> {
  return db.prepare(
    "SELECT series_id, member_id, member_name, created_at FROM bag_tag_requests WHERE series_id = ? AND member_id = ?",
  ).bind(seriesId, memberId).first<BagRequestRow>();
}

export async function listRequests(db: D1Like, seriesId: number): Promise<BagRequestRow[]> {
  const rows = await db.prepare(
    "SELECT series_id, member_id, member_name, created_at FROM bag_tag_requests WHERE series_id = ? ORDER BY created_at, member_id",
  ).bind(seriesId).all<BagRequestRow>();
  return rows.results;
}

/** Inserts a request, or returns the one already waiting. Does not assign a number. */
export async function askForTag(
  db: D1Like,
  input: { seriesId: number; memberId: string; memberName: string },
): Promise<{ row: BagRequestRow; created: boolean }> {
  const inserted = await db.prepare(
    `INSERT INTO bag_tag_requests (series_id, member_id, member_name)
     VALUES (?, ?, ?)
     ON CONFLICT(series_id, member_id) DO NOTHING
     RETURNING series_id, member_id, member_name, created_at`,
  ).bind(input.seriesId, input.memberId, input.memberName).first<BagRequestRow>();
  if (inserted) return { row: inserted, created: true };
  const existing = await requestByMember(db, input.seriesId, input.memberId);
  if (!existing) throw new Error("bag tag request missing after conflict");
  return { row: existing, created: false };
}

export async function clearRequest(db: D1Like, seriesId: number, memberId: string): Promise<void> {
  await db.prepare(
    "DELETE FROM bag_tag_requests WHERE series_id = ? AND member_id = ?",
  ).bind(seriesId, memberId).run();
}
