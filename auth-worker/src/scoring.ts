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
  division?: string | null;
  startingHole?: number | null; // assigned shotgun start (Track G G4); display-only, doesn't affect scoring
  scores: Record<number, number>; // hole -> strokes
}

export interface Standing {
  memberId: string | null;
  name: string;
  division: string | null;
  thru: number;
  total: number;
  toPar: number;
}

/** Live leaderboard: per player thru/total/to-par over played holes, sorted to-par ↑, total ↑, name. */
export function computeLeaderboard(holes: { hole: number; par: number }[], players: PlayerState[]): Standing[] {
  const parByHole = new Map(holes.map((h) => [h.hole, h.par]));
  const standings: Standing[] = players.map((p) => {
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

export interface FinalStanding extends Standing {
  place: number;
  breakdown: Breakdown;
}

/** Final results for an event: sorted standings with competition ranks (ties share a place, e.g.
 *  1,2,2,4) and each player's score breakdown over the holes they played. Used at finalize. */
export function finalizeStandings(holes: { hole: number; par: number }[], players: PlayerState[]): FinalStanding[] {
  const rows = players.map((p) => {
    const pars: number[] = [];
    const strokes: number[] = [];
    let thru = 0;
    let total = 0;
    let toPar = 0;
    for (const h of holes) {
      const s = p.scores?.[h.hole];
      if (s == null) continue;
      pars.push(h.par);
      strokes.push(s);
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
    };
  });
  rows.sort((a, b) => a.toPar - b.toPar || a.total - b.total || a.name.localeCompare(b.name));
  let place = 0;
  let prevKey = "";
  return rows.map((r, i) => {
    const key = r.toPar + "/" + r.total;
    if (key !== prevKey) { place = i + 1; prevKey = key; } // competition ranking: ties share, gaps after
    return { ...r, place };
  });
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
