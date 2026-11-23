import type { D1Like, D1StatementLike } from "./db-types.js";
import type { TagAssignment } from "./bag-tags.js";
import type { BagChallengeRow } from "./db-bag-tags.js";

// Imported bag-tag league ladders. Challenge rows live in bag_tag_challenges with
// series_id = 0 and league_id set. Every statement is parameterized.

export const LEAGUE_EXPIRED_NOTE = "expired: ladder refreshed from UDisc";

export interface LeagueLadderRow {
  league_id: number;
  tag_number: number;
  player_name: string;
  member_id: string | null;
  held_since: string;
}

export interface LeagueMoveRow {
  id: number;
  league_id: number;
  kind: string;
  summary: string;
  superseded: number;
  created_at: string;
}

export interface LeagueLinkRow {
  league_id: number;
  player_key: string;
  player_name: string;
  member_id: string;
}

export interface UdiscTagRow {
  name: string;
  place: number;
  member_id: string | null;
}

const LADDER_COLUMNS = "league_id, tag_number, player_name, member_id, held_since";

async function runAll(db: D1Like, statements: D1StatementLike[]): Promise<void> {
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export async function leagueName(db: D1Like, leagueId: number): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM leagues WHERE id = ?").bind(leagueId).first<{ name: string }>();
  return row ? row.name : null;
}

export async function leagueHasState(db: D1Like, leagueId: number): Promise<boolean> {
  const row = await db.prepare("SELECT league_id FROM bag_tag_league_state WHERE league_id = ?").bind(leagueId).first();
  return row != null;
}

/** Leagues whose UDisc import carried a bag-tag order, whether or not the ladder was built yet. */
export async function tagLeagueIds(db: D1Like): Promise<number[]> {
  const seeded = await db.prepare("SELECT league_id FROM bag_tag_league_state ORDER BY league_id").all<{ league_id: number }>();
  const fresh = await db.prepare(
    `SELECT DISTINCT e.league_id AS league_id
     FROM results r JOIN events e ON e.id = r.event_id
     WHERE e.league_id IS NOT NULL
       AND r.breakdown LIKE '%"udisc_bag_tag":true%'
       AND r.breakdown LIKE '%"udisc_current":true%'
       AND e.league_id NOT IN (SELECT league_id FROM bag_tag_league_state)
     ORDER BY e.league_id`,
  ).all<{ league_id: number }>();
  const ids = new Set<number>();
  for (const row of [...seeded.results, ...fresh.results]) ids.add(Number(row.league_id));
  return [...ids].sort((a, b) => a - b);
}

/** UDisc's current tag order for a league: the current event's rows, place = tag number. */
export async function udiscTagRows(db: D1Like, leagueId: number): Promise<UdiscTagRow[]> {
  const rows = await db.prepare(
    `SELECT r.name AS name, r.place AS place, r.member_id AS member_id, r.breakdown AS breakdown,
            r.event_id AS event_id, e.date AS date
     FROM results r JOIN events e ON e.id = r.event_id
     WHERE e.league_id = ? AND r.place IS NOT NULL AND r.breakdown LIKE '%"udisc_bag_tag":true%'
     ORDER BY r.place, r.name`,
  ).bind(leagueId).all<{ name: string; place: number; member_id: string | null; breakdown: string | null; event_id: number; date: string | null }>();
  const current: { row: (typeof rows.results)[number] }[] = [];
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(String(row.breakdown || "")) as { udisc_bag_tag?: unknown; udisc_current?: unknown };
      if (parsed.udisc_bag_tag === true && parsed.udisc_current === true) current.push({ row });
    } catch {
      // not a UDisc tag row
    }
  }
  // If an older round is still flagged current, only the newest round's order counts.
  let newest: (typeof rows.results)[number] | null = null;
  for (const { row } of current) {
    if (!newest || String(row.date || "") > String(newest.date || "")
      || (String(row.date || "") === String(newest.date || "") && row.event_id > newest.event_id)) newest = row;
  }
  return current
    .filter(({ row }) => newest != null && row.event_id === newest.event_id)
    .map(({ row }) => ({ name: row.name, place: Number(row.place), member_id: row.member_id || null }));
}

export async function listLadder(db: D1Like, leagueId: number): Promise<LeagueLadderRow[]> {
  const rows = await db.prepare(
    `SELECT ${LADDER_COLUMNS} FROM bag_tag_league_ladder WHERE league_id = ? ORDER BY tag_number`,
  ).bind(leagueId).all<LeagueLadderRow>();
  return rows.results;
}

export async function ladderByMember(db: D1Like, leagueId: number, memberId: string): Promise<LeagueLadderRow | null> {
  return db.prepare(
    `SELECT ${LADDER_COLUMNS} FROM bag_tag_league_ladder WHERE league_id = ? AND member_id = ?`,
  ).bind(leagueId, memberId).first<LeagueLadderRow>();
}

/** Replace the whole ladder with UDisc's order. Closes open challenges and marks app swaps as superseded. */
export async function resetLadder(
  db: D1Like,
  leagueId: number,
  players: readonly { tag: number; name: string; memberId: string | null }[],
): Promise<number> {
  const statements: D1StatementLike[] = [
    db.prepare("DELETE FROM bag_tag_league_ladder WHERE league_id = ?").bind(leagueId),
  ];
  const seenMembers = new Set<string>();
  for (const player of players) {
    const memberId = player.memberId && !seenMembers.has(player.memberId) ? player.memberId : null;
    if (memberId) seenMembers.add(memberId);
    statements.push(db.prepare(
      "INSERT INTO bag_tag_league_ladder (league_id, tag_number, player_name, member_id) VALUES (?, ?, ?, ?)",
    ).bind(leagueId, player.tag, player.name, memberId));
  }
  statements.push(db.prepare(
    `INSERT INTO bag_tag_league_state (league_id, imported_at, linked_at) VALUES (?, datetime('now'), NULL)
     ON CONFLICT(league_id) DO UPDATE SET imported_at = datetime('now'), linked_at = NULL`,
  ).bind(leagueId));
  statements.push(db.prepare(
    `UPDATE bag_tag_challenges SET status = 'expired', closed_note = ?, closed_at = datetime('now')
     WHERE league_id = ? AND status = 'pending'`,
  ).bind(LEAGUE_EXPIRED_NOTE, leagueId));
  statements.push(db.prepare(
    "UPDATE bag_tag_moves SET superseded = 1 WHERE league_id = ? AND superseded = 0 AND kind = 'challenge'",
  ).bind(leagueId));
  statements.push(db.prepare(
    "INSERT INTO bag_tag_moves (series_id, league_id, kind, summary, actor_id) VALUES (0, ?, 'import', ?, NULL)",
  ).bind(leagueId, `Ladder reset to UDisc's order (${players.length} players)`));
  await runAll(db, statements);
  return players.length;
}

export async function setLadderMember(db: D1Like, leagueId: number, tag: number, memberId: string | null): Promise<void> {
  await db.prepare(
    "UPDATE bag_tag_league_ladder SET member_id = ? WHERE league_id = ? AND tag_number = ?",
  ).bind(memberId, leagueId, tag).run();
}

/** Clear and reassign ladder member links in a single batch so promotions/swaps never collide on the unique index mid-update. */
export async function setLadderMembers(
  db: D1Like,
  leagueId: number,
  updates: readonly { tag: number; memberId: string | null }[],
): Promise<void> {
  if (!updates.length) return;
  const statements: D1StatementLike[] = updates.map(({ tag }) =>
    db.prepare("UPDATE bag_tag_league_ladder SET member_id = NULL WHERE league_id = ? AND tag_number = ?").bind(leagueId, tag),
  );
  for (const { tag, memberId } of updates) {
    if (memberId !== null) {
      statements.push(
        db.prepare("UPDATE bag_tag_league_ladder SET member_id = ? WHERE league_id = ? AND tag_number = ?").bind(memberId, leagueId, tag),
      );
    }
  }
  await runAll(db, statements);
}

export async function markLinked(db: D1Like, leagueId: number): Promise<void> {
  await db.prepare("UPDATE bag_tag_league_state SET linked_at = datetime('now') WHERE league_id = ?").bind(leagueId).run();
}

/** True when member links were never resolved, or not in the last hour, and a row is still unlinked. */
export async function linkingDue(db: D1Like, leagueId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS due FROM bag_tag_league_state s
     WHERE s.league_id = ? AND (s.linked_at IS NULL OR s.linked_at < datetime('now', '-1 hour'))
       AND EXISTS (SELECT 1 FROM bag_tag_league_ladder l WHERE l.league_id = s.league_id AND l.member_id IS NULL)`,
  ).bind(leagueId).first();
  return row != null;
}

export async function listLinks(db: D1Like, leagueId: number): Promise<LeagueLinkRow[]> {
  const rows = await db.prepare(
    "SELECT league_id, player_key, player_name, member_id FROM bag_tag_league_links WHERE league_id = ?",
  ).bind(leagueId).all<LeagueLinkRow>();
  return rows.results;
}

export async function setLink(
  db: D1Like,
  input: { leagueId: number; playerKey: string; playerName: string; memberId: string | null; actorId: string },
): Promise<void> {
  if (!input.memberId) {
    await db.prepare("DELETE FROM bag_tag_league_links WHERE league_id = ? AND player_key = ?")
      .bind(input.leagueId, input.playerKey).run();
    return;
  }
  await db.prepare(
    `INSERT INTO bag_tag_league_links (league_id, player_key, player_name, member_id, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(league_id, player_key) DO UPDATE SET member_id = excluded.member_id, player_name = excluded.player_name, created_by = excluded.created_by`,
  ).bind(input.leagueId, input.playerKey, input.playerName, input.memberId, input.actorId).run();
}

/** Swap tags among the players on a confirmed challenge. Records one app-only move. */
export async function replaceLadderTags(
  db: D1Like,
  leagueId: number,
  assignments: readonly (TagAssignment & { memberId: string })[],
  move: { summary: string; actorId: string },
): Promise<void> {
  const statements: D1StatementLike[] = assignments.map((assignment) => db.prepare(
    "DELETE FROM bag_tag_league_ladder WHERE league_id = ? AND tag_number = ?",
  ).bind(leagueId, assignment.tagNumber));
  for (const assignment of assignments) {
    statements.push(db.prepare(
      "INSERT INTO bag_tag_league_ladder (league_id, tag_number, player_name, member_id) VALUES (?, ?, ?, ?)",
    ).bind(leagueId, assignment.tagNumber, assignment.name, assignment.memberId));
  }
  statements.push(db.prepare(
    "INSERT INTO bag_tag_moves (series_id, league_id, kind, summary, actor_id) VALUES (0, ?, 'challenge', ?, ?)",
  ).bind(leagueId, move.summary, move.actorId));
  await runAll(db, statements);
}

/** Atomically verify both league ladder tags still match, claim the challenge, swap if needed, and record the move. */
export async function confirmLeagueChallenge(
  db: D1Like,
  input: {
    challengeId: number;
    leagueId: number;
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
     WHERE id = ? AND status = 'pending' AND league_id = ?
       AND EXISTS (SELECT 1 FROM bag_tag_league_ladder WHERE league_id = ? AND member_id = ? AND tag_number = ?)
       AND EXISTS (SELECT 1 FROM bag_tag_league_ladder WHERE league_id = ? AND member_id = ? AND tag_number = ?)`,
  ).bind(
    token, input.challengeId, input.leagueId,
    input.leagueId, input.challengerId, input.challengerTag,
    input.leagueId, input.defenderId, input.defenderTag,
  );
  const tail: D1StatementLike[] = [];
  if (input.swapped) {
    tail.push(
      db.prepare(
        `DELETE FROM bag_tag_league_ladder
         WHERE league_id = ?
           AND ((member_id = ? AND tag_number = ?) OR (member_id = ? AND tag_number = ?))
           AND EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
      ).bind(
        input.leagueId,
        input.challengerId, input.challengerTag,
        input.defenderId, input.defenderTag,
        input.challengeId, token,
      ),
      db.prepare(
        `INSERT INTO bag_tag_league_ladder (league_id, tag_number, player_name, member_id)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
      ).bind(input.leagueId, input.defenderTag, input.challengerName, input.challengerId, input.challengeId, token),
      db.prepare(
        `INSERT INTO bag_tag_league_ladder (league_id, tag_number, player_name, member_id)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
      ).bind(input.leagueId, input.challengerTag, input.defenderName, input.defenderId, input.challengeId, token),
    );
  }
  tail.push(
    db.prepare(
      `INSERT INTO bag_tag_moves (series_id, league_id, kind, summary, actor_id)
       SELECT 0, ?, 'challenge', ?, ? WHERE EXISTS (SELECT 1 FROM bag_tag_challenges WHERE id = ? AND closed_note = ?)`,
    ).bind(input.leagueId, input.summary, input.actorId, input.challengeId, token),
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

export async function recordLeagueMove(
  db: D1Like,
  move: { leagueId: number; summary: string; actorId: string },
): Promise<void> {
  await db.prepare(
    "INSERT INTO bag_tag_moves (series_id, league_id, kind, summary, actor_id) VALUES (0, ?, 'challenge', ?, ?)",
  ).bind(move.leagueId, move.summary, move.actorId).run();
}

export async function listLeagueMoves(db: D1Like, leagueId: number): Promise<LeagueMoveRow[]> {
  const rows = await db.prepare(
    `SELECT id, league_id, kind, summary, superseded, created_at FROM bag_tag_moves
     WHERE league_id = ? ORDER BY id DESC LIMIT 20`,
  ).bind(leagueId).all<LeagueMoveRow>();
  return rows.results;
}

export async function openLeagueChallenge(db: D1Like, leagueId: number, challengerId: string): Promise<BagChallengeRow | null> {
  return db.prepare(
    "SELECT * FROM bag_tag_challenges WHERE league_id = ? AND challenger_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
  ).bind(leagueId, challengerId).first<BagChallengeRow>();
}

export async function pendingLeagueChallenges(db: D1Like, leagueId: number | null, memberId?: string): Promise<BagChallengeRow[]> {
  const where = ["league_id IS NOT NULL", "status = 'pending'"];
  const binds: unknown[] = [];
  if (leagueId != null) {
    where.push("league_id = ?");
    binds.push(leagueId);
  }
  if (memberId) {
    where.push("(challenger_id = ? OR defender_id = ?)");
    binds.push(memberId, memberId);
  }
  const rows = await db.prepare(
    `SELECT * FROM bag_tag_challenges WHERE ${where.join(" AND ")} ORDER BY id DESC`,
  ).bind(...binds).all<BagChallengeRow>();
  return rows.results;
}

/** Challenges that closed without a settle in the last two weeks (expired by an import, or cancelled). */
export async function recentClosedLeagueChallenges(
  db: D1Like,
  leagueId: number | null,
  memberId?: string,
): Promise<BagChallengeRow[]> {
  const where = ["league_id IS NOT NULL", "status IN ('expired', 'cancelled')", "closed_at >= datetime('now', '-14 days')"];
  const binds: unknown[] = [];
  if (leagueId != null) {
    where.push("league_id = ?");
    binds.push(leagueId);
  }
  if (memberId) {
    where.push("(challenger_id = ? OR defender_id = ?)");
    binds.push(memberId, memberId);
  }
  const rows = await db.prepare(
    `SELECT * FROM bag_tag_challenges WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 20`,
  ).bind(...binds).all<BagChallengeRow>();
  return rows.results;
}
