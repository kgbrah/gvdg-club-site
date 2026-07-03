// Pure scoring logic for live events — no DO/D1/DOM here so it's unit-testable.

export interface Breakdown {
  aces: number;
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  doubles_plus: number;
}

/** Tally a round's holes into a UDisc-style breakdown. `aces` (hole-in-one) is counted
 *  separately AND in its score-to-par bucket (an ace on a par 3 is also an eagle). */
export function countScores(pars: number[], strokes: number[]): Breakdown {
  const b: Breakdown = { aces: 0, eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles_plus: 0 };
  const n = Math.min(pars.length, strokes.length);
  for (let i = 0; i < n; i++) {
    const par = pars[i];
    const s = strokes[i];
    if (s == null || par == null) continue;
    if (s === 1) b.aces++;
    const d = s - par;
    if (d <= -2) b.eagles++;
    else if (d === -1) b.birdies++;
    else if (d === 0) b.pars++;
    else if (d === 1) b.bogeys++;
    else b.doubles_plus++;
  }
  return b;
}

export interface PlayerState {
  memberId: string | null;
  name: string;
  team?: string | null;
  division?: string | null;
  startingHole?: number | null; // assigned shotgun start (Track G G4); display-only, doesn't affect scoring
  cardId?: string | null; // which scoring card/group this player is on (a player may score only their own card)
  ratingAnchor?: number | null; // private pre-round rating used as an SSA propagator, never exposed publicly
  scores: Record<number, number>; // hole -> strokes
  scorecards?: Record<number, Record<string, number>>;
  scoredBy?: Record<number, string | null>; // hole -> who last set it (for live scoring-conflict detection)
  removed?: boolean; // tombstoned (accidental join / left early / no-show): kept in the array so positional
  // indexes never shift under live scorers, but filtered out of the card, snapshot, and standings.
}

export const DEFAULT_CARD_SIZE = 4;

/** Stamp each player with a stable cardId so players can be authorized to score only their own card.
 *  If shotgun starting holes are assigned, players sharing a starting hole are one card ("h<hole>");
 *  otherwise players are bucketed consecutively into cards of `size` ("c<n>"). Only fills missing ids. */
export function assignCards(players: PlayerState[], size = DEFAULT_CARD_SIZE): void {
  const byHole = players.some((p) => p.startingHole != null);
  players.forEach((p, i) => {
    if (p.cardId != null) return;
    p.cardId = byHole && p.startingHole != null ? "h" + p.startingHole : "c" + Math.floor(i / Math.max(1, size));
  });
}

export interface Standing {
  memberId: string | null;
  name: string;
  team?: string | null;
  division: string | null;
  thru: number;
  total: number;
  toPar: number;
  holesWon?: number;
  holesLost?: number;
  holesTied?: number;
  matchPoints?: number;
  matchLabel?: string;
}

/** Live leaderboard: per player thru/total/to-par over played holes, sorted to-par ↑, total ↑, name. */
export function computeLeaderboard(holes: { hole: number; par: number }[], players: PlayerState[]): Standing[] {
  const parByHole = new Map(holes.map((h) => [h.hole, h.par]));
  const standings: Standing[] = players.filter((p) => !p.removed).map((p) => {
    let thru = 0;
    let total = 0;
    let toPar = 0;
    for (const [holeStr, strokes] of Object.entries(p.scores ?? {})) {
      const par = parByHole.get(Number(holeStr));
      if (par == null || strokes == null) continue;
      thru++;
      total += strokes;
      toPar += strokes - par;
    }
    return { memberId: p.memberId, name: p.name, division: p.division ?? null, thru, total, toPar };
  });
  standings.sort((a, b) => a.toPar - b.toPar || a.total - b.total || a.name.localeCompare(b.name));
  return standings;
}

export type ScoringFormat = "stroke" | "matchplay";
export type PlayFormat = "singles" | "doubles" | "teams";

type Hole = { hole: number; par: number };
type PlayerGroup = {
  key: string;
  memberId: string | null;
  name: string;
  team: string | null;
  division: string | null;
  players: PlayerState[];
};
type UnplacedFinalStanding = Standing & {
  breakdown: Breakdown;
  holes: { hole: number; par: number; strokes: number }[];
};
type MatchStanding = Standing & {
  groupKey: string;
  holesWon: number;
  holesLost: number;
  holesTied: number;
  matchPoints: number;
  matchLabel: string;
};

function scoringFormat(value: string | null | undefined): ScoringFormat {
  return value === "matchplay" ? "matchplay" : "stroke";
}

function playFormat(value: string | null | undefined): PlayFormat {
  return value === "doubles" || value === "teams" ? value : "singles";
}

function cleanedTeam(value: string | null | undefined): string | null {
  const team = String(value ?? "").trim();
  return team ? team : null;
}

function activeGroups(players: PlayerState[], format: PlayFormat): PlayerGroup[] {
  const active = players.map((player, index) => ({ player, index })).filter(({ player }) => !player.removed);
  if (format === "singles") {
    return active.map(({ player, index }) => ({
      key: "player:" + index,
      memberId: player.memberId,
      name: player.name,
      team: cleanedTeam(player.team),
      division: player.division ?? null,
      players: [player],
    }));
  }

  const groups = new Map<string, PlayerGroup>();
  for (const { player, index } of active) {
    const team = cleanedTeam(player.team);
    const key = team ? "team:" + team.toLowerCase() : "player:" + index;
    const existing = groups.get(key);
    if (existing) {
      existing.players.push(player);
      if (existing.division !== (player.division ?? null)) existing.division = null;
    } else {
      groups.set(key, {
        key,
        memberId: null,
        name: team ?? player.name,
        team,
        division: player.division ?? null,
        players: [player],
      });
    }
  }
  return [...groups.values()];
}

function groupScore(group: PlayerGroup, hole: number): number | null {
  let best: number | null = null;
  for (const player of group.players) {
    const score = player.scores?.[hole];
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    best = best == null ? score : Math.min(best, score);
  }
  return best;
}

function standingForGroup(holes: Hole[], group: PlayerGroup): Standing {
  let thru = 0;
  let total = 0;
  let toPar = 0;
  for (const h of holes) {
    const score = groupScore(group, h.hole);
    if (score == null) continue;
    thru++;
    total += score;
    toPar += score - h.par;
  }
  return { memberId: group.memberId, name: group.name, team: group.team, division: group.division, thru, total, toPar };
}

function finalStandingForGroup(holes: Hole[], group: PlayerGroup): UnplacedFinalStanding {
  const pars: number[] = [];
  const strokes: number[] = [];
  const played: { hole: number; par: number; strokes: number }[] = [];
  const standing = standingForGroup(holes, group);
  for (const h of holes) {
    const score = groupScore(group, h.hole);
    if (score == null) continue;
    pars.push(h.par);
    strokes.push(score);
    played.push({ hole: h.hole, par: h.par, strokes: score });
  }
  return { ...standing, breakdown: countScores(pars, strokes), holes: played };
}

function matchLabel(points: number): string {
  return points > 0 ? "+" + points : points < 0 ? String(points) : "E";
}

function computeMatchplayGroupStandings(holes: Hole[], players: PlayerState[], format: PlayFormat): MatchStanding[] {
  const groups = activeGroups(players, format);
  const standings = groups.map((group) => ({
    ...standingForGroup(holes, group),
    groupKey: group.key,
    holesWon: 0,
    holesLost: 0,
    holesTied: 0,
    matchPoints: 0,
    matchLabel: "E",
  }));
  const byKey = new Map(standings.map((standing) => [standing.groupKey, standing]));

  for (const h of holes) {
    const scored = groups
      .map((group) => ({ group, score: groupScore(group, h.hole) }))
      .filter((row): row is { group: PlayerGroup; score: number } => row.score != null);
    if (scored.length < 2) continue;
    const best = Math.min(...scored.map((row) => row.score));
    const winners = scored.filter((row) => row.score === best);
    if (winners.length !== 1) {
      scored.forEach((row) => {
        const standing = byKey.get(row.group.key);
        if (standing) standing.holesTied++;
      });
      continue;
    }
    const winnerKey = winners[0]!.group.key;
    scored.forEach((row) => {
      const standing = byKey.get(row.group.key);
      if (!standing) return;
      if (row.group.key === winnerKey) standing.holesWon++;
      else standing.holesLost++;
    });
  }

  standings.forEach((standing) => {
    standing.matchPoints = standing.holesWon - standing.holesLost;
    standing.matchLabel = matchLabel(standing.matchPoints);
  });
  standings.sort(
    (a, b) =>
      b.matchPoints - a.matchPoints ||
      b.holesWon - a.holesWon ||
      a.holesLost - b.holesLost ||
      a.toPar - b.toPar ||
      a.total - b.total ||
      a.name.localeCompare(b.name),
  );
  return standings;
}

function computeTeamStrokeLeaderboard(holes: Hole[], players: PlayerState[], format: PlayFormat): Standing[] {
  const standings = activeGroups(players, format).map((group) => standingForGroup(holes, group));
  standings.sort((a, b) => a.toPar - b.toPar || a.total - b.total || a.name.localeCompare(b.name));
  return standings;
}

export function computeLeaderboardForFormat(
  holes: Hole[],
  players: PlayerState[],
  rawScoringFormat?: string | null,
  rawPlayFormat?: string | null,
): Standing[] {
  const scoring = scoringFormat(rawScoringFormat);
  const play = playFormat(rawPlayFormat);
  if (scoring === "matchplay") {
    return computeMatchplayGroupStandings(holes, players, play).map(({ groupKey: _groupKey, ...standing }) => standing);
  }
  if (play !== "singles") return computeTeamStrokeLeaderboard(holes, players, play);
  return computeLeaderboard(holes, players);
}

export interface FinalStanding extends Standing {
  /** Competition rank for a completed round; `null` = DNF (no-show or partial round): recorded but
   *  unranked, so it never outranks a real finisher and earns no podium/league points. */
  place: number | null;
  breakdown: Breakdown;
  /** The holes this player actually scored, in layout order — persisted as the result's scorecard so
   *  a player can later open the right UDisc course and tap these in (UDisc has no import API). */
  holes: { hole: number; par: number; strokes: number }[];
}

/** Final results for an event: only players who completed every hole are ranked (ties share a place,
 *  e.g. 1,2,2,4). No-shows and partial cards are recorded as DNF (place null) and sorted to the bottom,
 *  so a registrant who never played can't sit at "even par" ahead of an over-par finisher. */
export function finalizeStandings(holes: { hole: number; par: number }[], players: PlayerState[]): FinalStanding[] {
  const holeCount = holes.length;
  const rows = players.filter((p) => !p.removed).map((p) => {
    const pars: number[] = [];
    const strokes: number[] = [];
    const played: { hole: number; par: number; strokes: number }[] = [];
    let thru = 0;
    let total = 0;
    let toPar = 0;
    for (const h of holes) {
      const s = p.scores?.[h.hole];
      if (s == null) continue;
      pars.push(h.par);
      strokes.push(s);
      played.push({ hole: h.hole, par: h.par, strokes: s });
      thru++;
      total += s;
      toPar += s - h.par;
    }
    return {
      memberId: p.memberId,
      name: p.name,
      division: p.division ?? null,
      thru,
      total,
      toPar,
      breakdown: countScores(pars, strokes),
      holes: played,
    };
  });
  const completed = (r: { thru: number }) => holeCount > 0 && r.thru === holeCount;
  const finishers = rows.filter(completed);
  const dnf = rows.filter((r) => !completed(r));
  finishers.sort((a, b) => a.toPar - b.toPar || a.total - b.total || a.name.localeCompare(b.name));
  dnf.sort((a, b) => b.thru - a.thru || a.name.localeCompare(b.name)); // most-played first; display only
  let place = 0;
  let prevKey = "";
  const ranked: FinalStanding[] = finishers.map((r, i) => {
    const key = r.toPar + "/" + r.total;
    if (key !== prevKey) { place = i + 1; prevKey = key; } // competition ranking: ties share, gaps after
    return { ...r, place };
  });
  const unranked: FinalStanding[] = dnf.map((r) => ({ ...r, place: null }));
  return [...ranked, ...unranked];
}

function completed(holeCount: number, row: { thru: number }): boolean {
  return holeCount > 0 && row.thru === holeCount;
}

function rankFinalRows(
  rows: UnplacedFinalStanding[],
  holeCount: number,
  compare: (a: UnplacedFinalStanding, b: UnplacedFinalStanding) => number,
  key: (row: UnplacedFinalStanding) => string,
): FinalStanding[] {
  const finishers = rows.filter((row) => completed(holeCount, row));
  const dnf = rows.filter((row) => !completed(holeCount, row));
  finishers.sort(compare);
  dnf.sort((a, b) => b.thru - a.thru || a.name.localeCompare(b.name));
  let place = 0;
  let prevKey = "";
  const ranked: FinalStanding[] = finishers.map((row, i) => {
    const rowKey = key(row);
    if (rowKey !== prevKey) {
      place = i + 1;
      prevKey = rowKey;
    }
    return { ...row, place };
  });
  return [...ranked, ...dnf.map((row) => ({ ...row, place: null }))];
}

function finalizeTeamStrokeStandings(holes: Hole[], players: PlayerState[], format: PlayFormat): FinalStanding[] {
  const rows = activeGroups(players, format).map((group) => finalStandingForGroup(holes, group));
  return rankFinalRows(
    rows,
    holes.length,
    (a, b) => a.toPar - b.toPar || a.total - b.total || a.name.localeCompare(b.name),
    (row) => row.toPar + "/" + row.total,
  );
}

function finalizeMatchplayStandings(holes: Hole[], players: PlayerState[], format: PlayFormat): FinalStanding[] {
  const matchByKey = new Map(computeMatchplayGroupStandings(holes, players, format).map((row) => [row.groupKey, row]));
  const rows = activeGroups(players, format).map((group) => {
    const base = finalStandingForGroup(holes, group);
    const match = matchByKey.get(group.key);
    return {
      ...base,
      holesWon: match?.holesWon ?? 0,
      holesLost: match?.holesLost ?? 0,
      holesTied: match?.holesTied ?? 0,
      matchPoints: match?.matchPoints ?? 0,
      matchLabel: match?.matchLabel ?? "E",
    };
  });
  return rankFinalRows(
    rows,
    holes.length,
    (a, b) =>
      (b.matchPoints ?? 0) - (a.matchPoints ?? 0) ||
      (b.holesWon ?? 0) - (a.holesWon ?? 0) ||
      (a.holesLost ?? 0) - (b.holesLost ?? 0) ||
      a.toPar - b.toPar ||
      a.total - b.total ||
      a.name.localeCompare(b.name),
    (row) => [row.matchPoints ?? 0, row.holesWon ?? 0, row.holesLost ?? 0].join("/"),
  );
}

export function finalizeStandingsForFormat(
  holes: Hole[],
  players: PlayerState[],
  rawScoringFormat?: string | null,
  rawPlayFormat?: string | null,
): FinalStanding[] {
  const scoring = scoringFormat(rawScoringFormat);
  const play = playFormat(rawPlayFormat);
  if (scoring === "matchplay") return finalizeMatchplayStandings(holes, players, play);
  if (play !== "singles") return finalizeTeamStrokeStandings(holes, players, play);
  return finalizeStandings(holes, players);
}

// ---------------- league standings ----------------
export interface LeagueStanding {
  member_id: string | null;
  name: string;
  events: number;
  wins: number;
  podiums: number;
  total_to_par: number;
  best_place: number | null;
  points: number;
}

// Season points by finishing place (tunable).
const placePoints = (place: number | null): number =>
  place == null ? 0 : place === 1 ? 10 : place === 2 ? 7 : place === 3 ? 5 : place === 4 ? 3 : place <= 10 ? 1 : 0;

/** Aggregate a league's per-event result rows into a season standings table: points/wins/podiums/
 *  cumulative to-par per player. Members keyed by member_id; guests grouped by name. */
export function computeLeagueStandings(
  rows: { member_id: string | null; name: string; place: number | null; to_par: number | null }[],
): LeagueStanding[] {
  const map = new Map<string, LeagueStanding>();
  for (const r of rows) {
    const key = r.member_id || "name:" + r.name;
    let s = map.get(key);
    if (!s) {
      s = { member_id: r.member_id ?? null, name: r.name, events: 0, wins: 0, podiums: 0, total_to_par: 0, best_place: null, points: 0 };
      map.set(key, s);
    }
    s.name = r.name; // keep the most recent display name
    s.events++;
    if (r.place === 1) s.wins++;
    if (r.place != null && r.place <= 3) s.podiums++;
    if (r.to_par != null) s.total_to_par += r.to_par;
    if (r.place != null && (s.best_place == null || r.place < s.best_place)) s.best_place = r.place;
    s.points += placePoints(r.place);
  }
  return [...map.values()].sort(
    (a, b) => b.points - a.points || b.wins - a.wins || a.total_to_par - b.total_to_par || a.name.localeCompare(b.name),
  );
}
