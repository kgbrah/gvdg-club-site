// Shared matchplay winner-coloring helpers (used by score.html, events.html). Pure + framework-free so it
// unit-tests under node --test. A hole is won by the team with the LOWER score (fewer strokes); equal = a
// halve/tie; if either side hasn't scored the hole yet, the winner is unknown (null). Team colors are fixed
// (not theme tokens) so Red/Blue read the same in light + dark; ties are yellow.
export const TEAM_COLORS = { red: '#dc3545', blue: '#2f6fd0', tie: '#e6b400' };

// Normalize a team label ("Red"/"Blue"/"Juan Team"/"Jesus Team"…) to a side key, or null.
export function teamSide(team) {
  const t = String(team == null ? '' : team).toLowerCase();
  if (t.includes('red')) return 'red';
  if (t.includes('blue')) return 'blue';
  return null;
}

// Winner of one hole from the two teams' scores. Numbers only; anything else → not-yet-decided (null).
export function holeWinner(redScore, blueScore) {
  if (typeof redScore !== 'number' || typeof blueScore !== 'number') return null;
  if (redScore < blueScore) return 'red';
  if (blueScore < redScore) return 'blue';
  return 'tie';
}

// Per-hole winners for a whole round. holes: [{hole}]; players: [{team, scores:{hole:strokes}}]. For doubles
// (alt-shot) each partner shares the one pair score, so the first non-null score for a side is that side's
// hole score. Returns { [hole]: 'red'|'blue'|'tie'|null }.
export function holeWinners(holes, players) {
  const list = Array.isArray(players) ? players : [];
  const sideScore = (side, hole) => {
    for (const p of list) {
      if (teamSide(p && p.team) !== side) continue;
      const v = p.scores ? p.scores[hole] : undefined;
      if (typeof v === 'number') return v;
    }
    return null;
  };
  const out = {};
  for (const h of Array.isArray(holes) ? holes : []) {
    if (h && h.hole != null) out[h.hole] = holeWinner(sideScore('red', h.hole), sideScore('blue', h.hole));
  }
  return out;
}

// The color to tint a hole/round by its winner. `tie` option = false suppresses the yellow tie color (the
// scoring app keeps halved holes as-is); default shows yellow (tee signs / scoreboard / standings).
export function winnerColor(winner, opts) {
  if (winner === 'red' || winner === 'blue') return TEAM_COLORS[winner];
  if (winner === 'tie' && !(opts && opts.tie === false)) return TEAM_COLORS.tie;
  return null;
}

// Build the holeWinners `players` shape from finalized result rows (each has a team label + a scorecard
// array [{hole,strokes}]). Rounds without scorecards (e.g. sheet-backfilled) yield empty score maps → no
// per-hole coloring, which is the intended graceful degradation.
export function playersFromResults(results) {
  return (Array.isArray(results) ? results : []).map((r) => {
    let team = null;
    try { team = JSON.parse(r.scoring_group || 'null'); } catch (_e) { team = null; }
    const scores = {};
    let card = [];
    try { card = JSON.parse(r.scorecard || '[]'); } catch (_e) { card = []; }
    for (const h of Array.isArray(card) ? card : []) {
      if (h && h.hole != null && typeof h.strokes === 'number') scores[h.hole] = h.strokes;
    }
    return { team: team && team.label ? team.label : null, scores };
  });
}

// Also expose as a global for classic (non-module) pages like score.html (mirrors safe-url.js).
if (typeof window !== 'undefined') {
  window.GVDGMatchplay = { TEAM_COLORS, teamSide, holeWinner, holeWinners, winnerColor, playersFromResults };
}
