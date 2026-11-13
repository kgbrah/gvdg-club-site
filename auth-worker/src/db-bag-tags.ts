import type { D1Like } from "./db-types.js";
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
  await db.prepare(
    "DELETE FROM bag_tag_holders WHERE series_id = ? AND member_id = ?",
  ).bind(input.seriesId, input.memberId).run();
  await db.prepare(
    "INSERT INTO bag_tag_holders (series_id, tag_number, member_id, member_name) VALUES (?, ?, ?, ?)",
  ).bind(input.seriesId, input.tagNumber, input.memberId, input.memberName).run();
}

export async function releaseTag(db: D1Like, seriesId: number, memberId: string): Promise<void> {
  await db.prepare(
    "DELETE FROM bag_tag_holders WHERE series_id = ? AND member_id = ?",
  ).bind(seriesId, memberId).run();
}

async function runAll(db: D1Like, statements: ReturnType<D1Like["prepare"]>[]): Promise<void> {
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

export async function openChallengeBetween(
  db: D1Like,
  seriesId: number,
  challengerId: string,
): Promise<BagChallengeRow | null> {
  return db.prepare(
    "SELECT * FROM bag_tag_challenges WHERE series_id = ? AND challenger_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
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
  },
): Promise<BagChallengeRow | null> {
  return db.prepare(
    `INSERT INTO bag_tag_challenges (
      series_id, challenger_id, challenger_name, defender_id, defender_name,
      challenger_tag, defender_tag, challenger_score, defender_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
  ).first<BagChallengeRow>();
}

export async function getChallenge(db: D1Like, id: number): Promise<BagChallengeRow | null> {
  return db.prepare("SELECT * FROM bag_tag_challenges WHERE id = ?").bind(id).first<BagChallengeRow>();
}

/** One confirm wins. A second click finds the row already closed. */
export async function claimChallenge(db: D1Like, id: number, status: "settled" | "declined"): Promise<boolean> {
  const row = await db.prepare(
    "UPDATE bag_tag_challenges SET status = ? WHERE id = ? AND status = 'pending' RETURNING id",
  ).bind(status, id).first<{ id: number }>();
  return row != null;
}

export async function pendingChallenges(db: D1Like, seriesId: number, memberId?: string): Promise<BagChallengeRow[]> {
  if (memberId) {
    const rows = await db.prepare(
      `SELECT * FROM bag_tag_challenges
       WHERE series_id = ? AND status = 'pending' AND (challenger_id = ? OR defender_id = ?)
       ORDER BY id DESC`,
    ).bind(seriesId, memberId, memberId).all<BagChallengeRow>();
    return rows.results;
  }
  const rows = await db.prepare(
    "SELECT * FROM bag_tag_challenges WHERE series_id = ? AND status = 'pending' ORDER BY id DESC",
  ).bind(seriesId).all<BagChallengeRow>();
  return rows.results;
}
