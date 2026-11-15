import { NO_SHOT_ROWS, shotHoleGeometry } from "../shared/shot-ledger.js";

export function shotLedgerTarget(targets, scorerIndex) {
  const target = (targets || []).find((row) => row.playerIndexes.includes(scorerIndex));
  return target && { id: target.id, binding: target.playerIndexes.join(","), label: target.label, scope: target.type === "pair" ? "team" : "player" };
}

function matches(ledger, target) {
  return ledger && target && ledger.targetId === target.id && ledger.binding === target.binding;
}

export function shotLedgerState(state, scorerIndex, hole) {
  const target = shotLedgerTarget(state.scoreTargets, scorerIndex);
  if (!target) return null;
  const committed = state.shotLedgers?.[scorerIndex]?.[hole.hole];
  const currentTarget = matches(committed, target);
  let revision = committed?.revision ?? null;
  let rows = currentTarget ? committed.rows : NO_SHOT_ROWS;
  let geometry = currentTarget && committed.rows.length ? committed.geometry : { tee: hole.tee ?? null, target: hole.target ?? null };
  let review = null;
  let pending = false;
  for (const item of state.recoveryItems || []) {
    const body = item.body;
    if (item.kind !== "shots" || body.scorerIndex !== scorerIndex || body.hole !== hole.hole) continue;
    if (item.state === "error" || !matches(body.ledger, target)) {
      review = item;
      continue;
    }
    if (item.order === revision) continue; // A committed write may still be waiting for its network acknowledgement.
    if (item.previous !== revision) {
      review = item;
      continue;
    }
    rows = body.ledger.rows;
    geometry = body.ledger.geometry;
    revision = item.order;
    if (!rows.length) geometry = { tee: hole.tee ?? null, target: hole.target ?? null };
    pending = true;
  }
  return { target, rows, revision, geometry, pending, review, previousTeam: committed && !currentTarget ? committed : null };
}

export function statsFromShotLedgers(state, scorerIndex, legacyThrows) {
  const throws = { ...legacyThrows };
  const holes = (state.holes || []).map((hole) => {
    const ledger = shotLedgerState(state, scorerIndex, hole);
    if (!ledger?.rows.length) return hole;
    throws[hole.hole] = ledger.rows;
    return shotHoleGeometry(hole, ledger);
  });
  return { holes, throws };
}
