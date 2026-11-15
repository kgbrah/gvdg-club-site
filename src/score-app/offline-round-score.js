import { offlineRoundOutcome, offlineTargets } from "../shared/offline-round.js";
import { buildScorecardViewState } from "./score-view-model.js";
import { shotLedgerState, shotLedgerTarget, statsFromShotLedgers } from "./shot-ledger-model.js";

export function offlineScorecard(round, holeIdx, confirmOpen) {
  const outcome = offlineRoundOutcome(round);
  const scoreTargets = offlineTargets(round);
  const ownerTarget = scoreTargets[0];
  const target = shotLedgerTarget(scoreTargets, 0);
  const holes = round.source.holes;
  const cardmates = round.players.map((player, index) => {
    const scoreTarget = scoreTargets.find((entry) => entry.playerIndexes.includes(index));
    return { index, name: player.name, isMe: index === 0, canEnterScorecard: index === 0, cardId: "offline",
      scores: round.scores[scoreTarget.id], startingHole: holes[0].hole, throws: index === 0 ? round.marks : undefined };
  });
  const shotLedgers = {};
  for (const [hole, rows] of Object.entries(round.shots)) {
    const geometry = holes.find((entry) => entry.hole === Number(hole));
    shotLedgers[hole] = { targetId: target.id, binding: target.binding, rows, revision: round.revision,
      geometry: { tee: geometry.tee, target: geometry.target } };
  }
  const state = {
    holes, holeIdx, cardmates, scoreTargets, cardId: "offline", myIndex: 0,
    status: "live", roundConfig: round.format, shotLedgers: { 0: shotLedgers },
    snap: { courseName: round.source.courseName },
  };
  const view = buildScorecardViewState({ state, mode: "round", roundCode: null, scorerIndex: 0 });
  const hole = view.hole.hole;
  const ownScore = round.scores[ownerTarget.id]?.[hole] ?? null;
  const missing = outcome.missing.find((row) => holes.findIndex((entry) => entry.hole === row.hole) < holeIdx)
    || (view.atEnd ? outcome.missing[0] : null);
  const leader = scoreTargets.find((entry) => entry.id === outcome.match?.leader);
  const matchLabel = outcome.match ? [leader?.label, outcome.match.label].filter(Boolean).join(" ") : "";
  return {
    ...view, offline: true, show: false, choices: [],
    holeMeta: view.holeMeta + (view.hole.par_source === "placeholder" ? " · Estimated par" : "")
      + (["geo", "par_estimate"].includes(view.hole.distance_source) ? " · Estimated distance" : ""),
    shotLedger: { ...shotLedgerState(state, 0, view.hole), hole, revision: round.revision },
    shotStats: statsFromShotLedgers(state, 0, round.marks),
    ledgerScore: ownScore,
    matchStatus: outcome.match ? "Match: " + matchLabel : "",
    dormie: Boolean(outcome.match?.lead && !outcome.match.final && Math.abs(outcome.match.lead) === outcome.match.remaining),
    totals: view.totals.map((total) => total.label === "Match" ? { ...total, value: matchLabel } : total),
    finish: {
      ...view.finish, ready: outcome.complete, canFinish: outcome.complete, confirmOpen,
      review: { ...view.finish.review, rows: view.finish.review.rows.map((row, index) => ({ ...row,
        total: outcome.summaries[index].total, toPar: outcome.summaries[index].toPar })) },
      blocker: missing ? { kind: "missing", hole: missing.hole, index: holes.findIndex((entry) => entry.hole === missing.hole),
        text: "Score hole " + missing.hole } : null, skipped: [],
    },
  };
}
