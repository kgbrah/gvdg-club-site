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
