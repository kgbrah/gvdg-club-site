import { aceHint, buildLivePots } from "../shared/live-pots-model.js";
import { displayMatchStatus } from "../shared/match-status.js";
import { playGroupLabel, playStyleLabel } from "../shared/play-stats.js";

export function relClass(delta) {
  return delta < 0 ? "under" : delta > 0 ? "over" : "even";
}

export function relText(delta) {
  return delta === 0 ? "E" : delta > 0 ? "+" + delta : String(delta);
}

export function scorecardChoices(state) {
  return (state.cardmates || []).filter((player) => player && player.canEnterScorecard !== false);
}

export function scorePendingKey(scorerIndex, index, hole, targetId) {
  return scorerIndex + ":" + (targetId ? ("target:" + targetId) : ("index:" + index)) + ":" + hole;
}

export function isDoublesScoring(state) {
  return Boolean(state.roundConfig && state.roundConfig.groupFormat === "doubles");
}

export function isMatchplayScoring(state) {
  return Boolean(state.roundConfig && state.roundConfig.scoringStyle === "matchplay");
}

export function roundFormatLabel(state) {
  const group = isDoublesScoring(state) ? "doubles" : "singles";
  const style = isMatchplayScoring(state) ? "matchplay" : "stroke";
  return playGroupLabel(group) + " · " + playStyleLabel(style);
}

export function nextHoleScore(current, par, direction) {
  const holePar = typeof par === "number" ? par : 3;
  if (direction === "plus") {
    if (current == null) return holePar;
    return Math.min(30, current + 1);
  }
  if (current == null) return Math.max(1, holePar - 1);
  if (current <= 1) return null;
  return current - 1;
}

export function strokeLabel(strokes, par) {
  if (typeof strokes !== "number" || typeof par !== "number") return null;
  const delta = strokes - par;
  if (strokes === 1) return { text: "ace", className: "under", delta, strokes };
  if (delta <= -3) return { text: "albatross", className: "under", delta, strokes };
  if (delta === -2) return { text: "eagle", className: "under", delta, strokes };
  if (delta === -1) return { text: "birdie", className: "under", delta, strokes };
  if (delta === 0) return { text: "par", className: "even", delta, strokes };
  if (delta === 1) return { text: "bogey", className: "over", delta, strokes };
  if (delta === 2) return { text: "double", className: "over", delta, strokes };
  return { text: "+" + delta, className: "over", delta, strokes };
}

function holeStrokes(player, hole) {
  if (!player || !player.scores) return null;
  const value = player.scores[hole];
  if (typeof value === "number") return value;
  const alt = player.scores[String(hole)];
  return typeof alt === "number" ? alt : null;
}

export function scoreForPlayerIndexes(players, playerIndexes, hole) {
  const list = Array.isArray(players) ? players : [];
  for (const index of playerIndexes || []) {
    const player = list.find((row) => row && row.index === index);
    const strokes = holeStrokes(player, hole);
    if (typeof strokes === "number") return strokes;
  }
  return null;
}

function targetName(target) {
  if (!target) return "Side";
  if (target.label) return target.label;
  const members = Array.isArray(target.members) ? target.members.filter(Boolean) : [];
  return members.length ? members.join(" / ") : "Side";
}

function targetForPlayerIndex(scoreTargets, index) {
  return (Array.isArray(scoreTargets) ? scoreTargets : []).find((target) =>
    target && Array.isArray(target.playerIndexes) && target.playerIndexes.indexOf(index) >= 0) || null;
}

function cardIdForTarget(target, players) {
  const list = Array.isArray(players) ? players : [];
  for (const index of target && target.playerIndexes ? target.playerIndexes : []) {
    const player = list.find((row) => row && row.index === index);
    if (player) return player.cardId == null ? "card:null" : player.cardId;
  }
  return target && target.id ? "target:" + target.id : "card";
}

function matchThru(match) {
  if (!match) return 0;
  const won = Number(match.holesWon);
  const lost = Number(match.holesLost);
  const tied = Number(match.holesTied);
  if (![won, lost, tied].every(Number.isFinite)) return 0;
  return won + lost + tied;
}

function matchCardStatus(match, leadTarget) {
  const status = displayMatchStatus(match);
  const outcome = match && match.outcome;
  if (!outcome || outcome === "draw") return status;
  return targetName(leadTarget) + " " + status;
}

function scoreTargetsOrPlayers(scoreTargets, players) {
  if (Array.isArray(scoreTargets)) return scoreTargets;
  return (Array.isArray(players) ? players : []).map((player) => ({
    id: "player:" + player.index,
    label: player.name,
    playerIndexes: [player.index],
  }));
}

function indexesForLocation(scoreTargets, index) {
  if (Array.isArray(scoreTargets)) {
    const target = targetForPlayerIndex(scoreTargets, index);
    return target ? target.playerIndexes : null;
  }
  return [index];
}

export function watchHoleScoreChips({ hole, par, players, locations, scoreTargets }) {
  return (Array.isArray(locations) ? locations : []).map((loc) => {
    const mate = (Array.isArray(players) ? players : []).find((player) => player && player.index === loc.index);
    const photo = loc.photo || (mate && mate.photo) || null;
    const indexed = photo ? { ...loc, photo } : loc;
    const indexes = indexesForLocation(scoreTargets, loc.index);
    if (!indexes) return indexed;
    const label = strokeLabel(scoreForPlayerIndexes(players, indexes, hole), par);
    if (!label) return indexed;
    return { ...indexed, strokes: label.strokes, label: label.text, relClass: label.className };
  });
}

export function watchStrokeHoleChips({ hole, par, players, scoreTargets }) {
  const chips = [];
  scoreTargetsOrPlayers(scoreTargets, players).forEach((target) => {
    const label = strokeLabel(scoreForPlayerIndexes(players, target.playerIndexes, hole), par);
    if (!label) return;
    chips.push({
      key: target.id || String((target.playerIndexes || [])[0]),
      name: targetName(target),
      strokes: label.strokes,
      label: label.text,
      className: label.className,
    });
  });
  return chips;
}

export function watchHoleThrows(player, hole) {
  if (!player || player.throws == null) return [];
  const rows = player.throws[hole] || player.throws[String(hole)];
  return Array.isArray(rows) ? rows : [];
}

export function watchThrowSignature(player, hole) {
  const rows = watchHoleThrows(player, hole);
  return String(player && player.index) + ":" + rows.map((row) => (row && row.n) + "@" + (row && row.lat) + "," + (row && row.lng)).join("|");
}

export function watchScoreSignature(player, hole) {
  if (!player) return "";
  const scores = player.scores || {};
  const strokes = Object.prototype.hasOwnProperty.call(scores, hole)
    ? scores[hole]
    : scores[String(hole)];
  return String(player.index) + ":" + (strokes == null ? "" : String(strokes));
}

export function watchFollowOptions({ players, hole }) {
  const list = Array.isArray(players) ? players : [];
  const seen = new Set();
  const options = [];
  list.forEach((player) => {
    if (!player || seen.has(player.index)) return;
    const throws = watchHoleThrows(player, hole);
    if (!throws.length) return;
    seen.add(player.index);
    options.push({
      index: player.index,
      name: player.name || ("Player " + (player.index + 1)),
      throws,
      discColor: player.discColor || null,
      throwAt: Number(player.throwAt) || 0,
    });
  });
  options.sort((a, b) => b.throwAt - a.throwAt || a.index - b.index);
  return options;
}

export function watchFollowPlayer({ players, hole, followIndex }) {
  const list = Array.isArray(players) ? players : [];
  if (Number.isInteger(followIndex)) {
    const pinned = list.find((player) => player && player.index === followIndex);
    if (pinned) return pinned;
  }
  const onHole = watchFollowOptions({ players: list, hole });
  if (onHole.length) {
    const index = onHole[0].index;
    return list.find((player) => player && player.index === index) || null;
  }
  let best = null;
  let bestAt = -1;
  list.forEach((player) => {
    const at = Number(player && player.throwAt) || 0;
    if (at > bestAt) {
      best = player;
      bestAt = at;
    }
  });
  return best;
}

export function watchMatchCards({ hole, par, players, scoreTargets, standings }) {
  const targets = Array.isArray(scoreTargets) ? scoreTargets : [];
  const rows = Array.isArray(standings) ? standings : [];
  const groups = new Map();
  targets.forEach((target) => {
    const cardId = cardIdForTarget(target, players);
    if (!groups.has(cardId)) groups.set(cardId, []);
    groups.get(cardId).push(target);
  });
  const cards = [];
  groups.forEach((group, cardId) => {
    if (group.length !== 2) return;
    const left = group[0];
    const right = group[1];
    const leftStanding = rows.find((row) => row && row.targetId === left.id) || null;
    const rightStanding = rows.find((row) => row && row.targetId === right.id) || null;
    const lead = leftStanding && (leftStanding.match?.outcome === "leading" || leftStanding.match?.outcome === "won" || leftStanding.match?.outcome === "draw")
      ? leftStanding
      : (rightStanding || leftStanding);
    const leadTarget = lead === rightStanding ? right : left;
    const leftScore = scoreForPlayerIndexes(players, left.playerIndexes, hole);
    const rightScore = scoreForPlayerIndexes(players, right.playerIndexes, hole);
    const chips = [];
    function pushChip(target, strokes, other) {
      const label = strokeLabel(strokes, par);
      if (!label) return;
      let result = "";
      if (typeof other === "number") result = strokes < other ? "won" : strokes > other ? "lost" : "halved";
      chips.push({
        key: target.id,
        name: targetName(target),
        strokes: label.strokes,
        label: label.text,
        className: label.className,
        result,
      });
    }
    pushChip(left, leftScore, rightScore);
    pushChip(right, rightScore, leftScore);
    cards.push({
      key: cardId,
      title: targetName(left) + " vs " + targetName(right),
      status: matchCardStatus(lead && lead.match, leadTarget),
      thru: matchThru(lead && lead.match),
      chips,
    });
  });
  return cards;
}

export function ctpNomineeEligible(player, ctp) {
  if (!player || player.ctpEligible === false) return false;
  const division = String((ctp && ctp.division) || "").trim().toLowerCase();
  if (!division) return true;
  return String(player.division || "").trim().toLowerCase() === division;
}

export function scoreTargetForPlayer(state, index) {
  return (state.scoreTargets || []).find((target) =>
    target && Array.isArray(target.playerIndexes) && target.playerIndexes.indexOf(index) >= 0) || null;
}

export function scoreRows(state) {
  const cardmates = state.cardmates || [];
  if (!isDoublesScoring(state)) {
    return cardmates.map((player) => ({
      type: "player",
      index: player.index,
      label: player.name + (player.isMe ? " (you)" : ""),
      meta: player.division || "",
      playerIndexes: [player.index],
    }));
  }

  const cardIndexes = new Set(cardmates.map((player) => player.index));
  return (state.scoreTargets || []).reduce((rows, target) => {
    if (target && target.type === "pair" && target.playerIndexes.some((index) => cardIndexes.has(index))) {
      rows.push({
        type: "pair",
        targetId: target.id,
        label: target.label,
        meta: (target.members || []).join(" / "),
        playerIndexes: target.playerIndexes || [],
      });
    }
    return rows;
  }, []);
}

export function strokesFor(state, index, hole, scorerIndex) {
  const cardmate = (state.cardmates || []).find((player) => player.index === index);
  if (!cardmate) return null;

  const votes = cardmate.scorecards && cardmate.scorecards[hole];
  if (scorerIndex != null && votes && typeof votes["player:" + scorerIndex] === "number") {
    return votes["player:" + scorerIndex];
  }

  const value = cardmate.scores ? cardmate.scores[hole] : undefined;
  return typeof value === "number" ? value : null;
}

export function strokesForRow(state, row, hole, scorerIndex) {
  const index = row.playerIndexes && row.playerIndexes[0];
  return Number.isInteger(index) ? strokesFor(state, index, hole, scorerIndex) : null;
}

export function playOrderIndexes(holes, startingHole) {
  const list = Array.isArray(holes) ? holes : [];
  if (!list.length) return [];
  const startNum = Number(startingHole);
  let startIdx = 0;
  if (Number.isInteger(startNum) && startNum > 0) {
    const found = list.findIndex((hole) => hole && hole.hole === startNum);
    if (found >= 0) startIdx = found;
  }
  return list.map((_, offset) => (startIdx + offset) % list.length);
}

export function startingHoleForState(state) {
  const mates = Array.isArray(state && state.cardmates) ? state.cardmates : [];
  const me = mates.find((player) => player && player.isMe) || mates[0];
  return me && me.startingHole;
}

export function playOrderPosition(holes, holeIdx, startingHole) {
  const order = playOrderIndexes(holes, startingHole);
  const pos = order.indexOf(holeIdx);
  return { order, pos: pos < 0 ? 0 : pos };
}

export function playOrderStep(holes, holeIdx, startingHole, delta) {
  const { order, pos } = playOrderPosition(holes, holeIdx, startingHole);
  if (!order.length) return 0;
  const next = pos + (delta === "next" || delta === 1 ? 1 : -1);
  if (next < 0 || next >= order.length) return holeIdx;
  return order[next];
}

export function nextPlayHole(holes, holeIdx, startingHole) {
  const nextIdx = playOrderStep(holes, holeIdx, startingHole, "next");
  if (nextIdx === holeIdx) return null;
  const list = Array.isArray(holes) ? holes : [];
  return list[nextIdx] || null;
}

export function activeHoleIndex({ holes, startingHole, isHoleComplete }) {
  const list = Array.isArray(holes) ? holes : [];
  if (!list.length) return 0;
  const order = playOrderIndexes(list, startingHole);
  const complete = typeof isHoleComplete === "function" ? isHoleComplete : () => false;
  for (const idx of order) {
    const hole = list[idx];
    if (!hole || !complete(hole.hole)) return idx;
  }
  return order[order.length - 1];
}

export function cardHoleComplete(state, hole, scorerIndex) {
  const rows = scoreRows(state);
  if (!rows.length) return false;
  return rows.every((row) => typeof strokesForRow(state, row, hole, scorerIndex) === "number");
}

export function fieldActiveHoleIndex({ holes, players }) {
  const list = Array.isArray(holes) ? holes : [];
  if (!list.length) return 0;
  const votes = new Map();
  (Array.isArray(players) ? players : []).forEach((player) => {
    if (!player) return;
    const order = playOrderIndexes(list, player.startingHole);
    const unfinished = order.some((idx) => {
      const hole = list[idx];
      return hole && typeof holeStrokes(player, hole.hole) !== "number";
    });
    if (!unfinished && order.some((idx) => list[idx] && typeof holeStrokes(player, list[idx].hole) === "number")) {
      return;
    }
    const idx = activeHoleIndex({
      holes: list,
      startingHole: player.startingHole,
      isHoleComplete: (hole) => typeof holeStrokes(player, hole) === "number",
    });
    const holeNum = list[idx] && list[idx].hole;
    if (holeNum == null) return;
    votes.set(holeNum, (votes.get(holeNum) || 0) + 1);
  });
  if (!votes.size) return 0;
  let bestHole = null;
  let bestCount = -1;
  votes.forEach((count, holeNum) => {
    if (count > bestCount || (count === bestCount && (bestHole == null || holeNum < bestHole))) {
      bestCount = count;
      bestHole = holeNum;
    }
  });
  const idx = list.findIndex((hole) => hole && hole.hole === bestHole);
  return idx >= 0 ? idx : 0;
}

function teeDisplayName(label) {
  return String(label || "").replace(/\s+\(you\)$/i, "").trim() || "Player";
}

function teeSequenceText(rows) {
  const names = (Array.isArray(rows) ? rows : []).map((row) => teeDisplayName(row.label));
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return names[0] + " · then " + names.slice(1).join(", ");
}

/** PDGA 802.02: first tee is scorecard order; later tees sort by previous-hole score, lowest first. Ties keep the previous order. */
export function applyTeeOrder(state, rows, holeIdx, scorerIndex) {
  const listed = Array.isArray(rows) ? rows.slice() : [];
  const holes = Array.isArray(state && state.holes) ? state.holes : [];
  const currentIdx = Number.isInteger(holeIdx) ? holeIdx : 0;
  let ordered = listed;
  let lastApplied = -1;
  for (let i = 0; i < currentIdx && i < holes.length; i++) {
    const prev = holes[i];
    if (!prev) break;
    const ranked = ordered.map((row, idx) => ({
      idx,
      row,
      score: strokesForRow(state, row, prev.hole, scorerIndex),
    }));
    if (ranked.some((item) => typeof item.score !== "number")) break;
    ordered = ranked.sort((a, b) => a.score - b.score || a.idx - b.idx).map((item) => item.row);
    lastApplied = i;
  }
  const honorsReady = currentIdx > 0 && lastApplied === currentIdx - 1;
  const sequence = teeSequenceText(ordered);
  let hint = "";
  if (!listed.length) hint = "";
  else if (currentIdx <= 0) hint = sequence ? "Tee order: " + sequence : "";
  else if (honorsReady) hint = sequence ? "Honors: " + sequence : "";
  else {
    const waiting = holes[currentIdx - 1];
    hint = waiting ? "Tee order after hole " + waiting.hole + " scores" : (sequence ? "Tee order: " + sequence : "");
  }
  return { honorsReady, hint, rows: ordered };
}

export function conflictForRow(state, row, hole) {
  if (row.targetId) {
    return (state.conflicts || []).find((conflict) =>
      conflict && conflict.targetId === row.targetId && conflict.hole === hole) || null;
  }
  return (state.conflicts || []).find((conflict) =>
    conflict && conflict.playerIndex === row.index && conflict.hole === hole) || null;
}

export function holeHasConflict(state, hole) {
  return (state.conflicts || []).some((conflict) => conflict && conflict.hole === hole);
}

export function isMatchDormie(state) {
  if (!isMatchplayScoring(state) || !state.snap || !Array.isArray(state.snap.standings)) return false;
  return state.snap.standings.some((standing) => standing.match && standing.match.dormie);
}

export function matchStatusText(state) {
  if (!isMatchplayScoring(state) || !state.snap || !Array.isArray(state.snap.standings)) return "";
  const cardTargets = scoreRows(state).map((row) => row.targetId || ("player:" + row.index));
  const rows = state.snap.standings.filter((standing) => cardTargets.indexOf(standing.targetId) >= 0);
  const leader = rows.find((standing) => standing.match && (standing.match.outcome === "leading" || standing.match.outcome === "won"));
  const draw = rows.find((standing) => standing.match && standing.match.outcome === "draw");
  const withMatch = leader || draw || rows.find((standing) => standing.match && standing.match.status);
  if (!withMatch || !withMatch.match) return "";
  if (withMatch.match.outcome === "draw") return "Match: AS";
  const team = withMatch.scoringGroup && withMatch.scoringGroup.label;
  const status = displayMatchStatus(withMatch.match);
  return "Match: " + (team && String(team) !== String(withMatch.name) ? team + " " + status : status);
}

export function myScoreRow(state) {
  return scoreRows(state).find((row) => row.playerIndexes.indexOf(state.myIndex) >= 0) || null;
}

export function yourTurnHint(state) {
  const hole = holeMeta(state, state.holeIdx);
  const mine = myScoreRow(state);
  if (!mine) return "";
  const myScore = strokesForRow(state, mine, hole.hole, state.scorerIndex ?? state.myIndex);
  if (myScore != null) return "";
  const others = scoreRows(state).some((row) => {
    if (row === mine) return false;
    return strokesForRow(state, row, hole.hole, state.scorerIndex ?? state.myIndex) != null;
  });
  return others ? "Card is waiting on you — hole " + hole.hole : "";
}

function holeMeta(state, index) {
  return state.holes[index] || { hole: index + 1, par: 3 };
}

export function buildScorecardViewState({ state, mode, roundCode, scorerIndex, teeSign }) {
  const hole = holeMeta(state, state.holeIdx);
  const listed = scoreRows(state);
  const tee = applyTeeOrder(state, listed, state.holeIdx, scorerIndex);
  const rows = tee.rows;
  const warning = state.scoreTargetError && state.scoreTargetError.message
    ? state.scoreTargetError.message
    : isDoublesScoring(state) && !rows.length
      ? "Set pairs in Manage before scoring doubles."
      : null;

  const cardmates = state.cardmates || [];
  const rowViews = rows.map((rowData, order) => {
    const conflict = conflictForRow(state, rowData, hole.hole);
    const currentScore = strokesForRow(state, rowData, hole.hole, scorerIndex);
    const delta = currentScore == null ? null : currentScore - hole.par;
    const isMe = (rowData.playerIndexes || []).some((index) => {
      const player = cardmates.find((item) => item && item.index === index);
      return Boolean(player && player.isMe);
    });
    return {
      conflictText: conflict ? "Conflict: " + (conflict.values || []).join(" vs ") + " - set yours to match" : "",
      currentScore,
      honors: tee.honorsReady && order === 0,
      isMe,
      key: rowData.targetId || rowData.index,
      label: rowData.label,
      meta: rowData.meta,
      relative: delta == null ? null : { className: relClass(delta), text: relText(delta) },
      source: rowData,
      teePosition: order + 1,
    };
  });

  const mine = myScoreRow(state);
  let totals = [];
  if (mine) {
    let thru = 0;
    let total = 0;
    let toPar = 0;
    (state.holes || []).forEach((currentHole) => {
      const strokes = strokesForRow(state, mine, currentHole.hole, scorerIndex);
      if (typeof strokes === "number") {
        thru += 1;
        total += strokes;
        toPar += strokes - currentHole.par;
      }
    });
    const resultLabel = isMatchplayScoring(state) ? "Match" : "To par";
    const resultValue = isMatchplayScoring(state)
      ? (matchStatusText(state).replace(/^Match: /, "") || "AS")
      : thru ? relText(toPar) : "E";
    totals = [
      { label: "Thru", value: String(thru) + "/" + state.holes.length },
      { label: "Total", value: total ? String(total) : "-" },
      { label: resultLabel, value: resultValue },
    ];
  }

  const pots = buildLivePots({
    acePot: state.pots && state.pots.acePot,
    ctps: state.pots && state.pots.ctps,
    currentHole: hole && hole.hole,
    roundStatus: state.status,
  });
  const holeScores = (state.cardmates || []).map((player) => player && player.scores ? player.scores[hole.hole] : null);
  const holeGrid = (state.holes || []).map((currentHole, index) => {
    const score = mine ? strokesForRow(state, mine, currentHole.hole, scorerIndex) : null;
    const relative = score == null ? null : strokeLabel(score, currentHole.par);
    return {
      conflict: holeHasConflict(state, currentHole.hole),
      ctp: pots.holeNumbers.indexOf(currentHole.hole) >= 0,
      current: index === state.holeIdx,
      done: score != null,
      hole: currentHole.hole,
      index,
      par: currentHole.par,
      relative,
      score,
    };
  });
  const ctpMeta = pots.currentHoleCtps.length ? " · CTP" : "";
  const liveCtps = state.snap && Array.isArray(state.snap.liveCtps) ? state.snap.liveCtps : [];
  const liveById = new Map(liveCtps.map((ctp) => [String(ctp.id), ctp]));
  const voteIndex = scorerIndex ?? state.myIndex;
  const holeCtps = (pots.currentHoleCtps.length ? pots.currentHoleCtps : liveCtps.filter((ctp) => ctp && ctp.hole === hole.hole)).map((ctp) => {
    const live = liveById.get(String(ctp.id));
    const card = live && Array.isArray(live.cards)
      ? live.cards.find((row) => (row.cardId ?? null) === (state.cardId ?? null))
      : null;
    const votes = card && Array.isArray(card.votes) ? card.votes : [];
    const votedIndexes = new Set(votes.map((vote) => vote.playerIndex));
    const myVote = (votes.find((vote) => vote.playerIndex === voteIndex) || {}).nomineeIndex;
    const missingNames = live && Array.isArray(live.missingNames)
      ? live.missingNames
      : cardmates.filter((player) => !votedIndexes.has(player.index)).map((player) => player.name);
    const nominees = cardmates.filter((player) => ctpNomineeEligible(player, live || ctp)).map((player) => ({
      index: player.index,
      label: player.name + (player.isMe ? " (you)" : ""),
    }));
    return {
      id: live ? live.id : ctp.id,
      hole: live ? live.hole : ctp.hole,
      division: (live && live.division) || ctp.division || "",
      leaderName: live && live.leaderName ? live.leaderName : null,
      myVote: myVote == null ? null : myVote,
      agreed: Boolean(live && (live.agreed || (card && card.agreed))),
      nomineeName: (live && live.nomineeName) || (card && card.nomineeName) || null,
      missingNames,
      needed: live && live.needed != null ? live.needed : cardmates.length,
      voted: live && live.voted != null ? live.voted : votedIndexes.size,
      nominees,
    };
  });

  const blockers = finalizeBlockers(state);
  const locked = Boolean(state.cardLocked) || state.status === "final";
  const startHole = startingHoleForState(state);
  const playPos = playOrderPosition(state.holes, state.holeIdx, startHole);

  return {
    atEnd: playPos.pos >= playPos.order.length - 1,
    atStart: playPos.pos <= 0,
    choices: scorecardChoices(state),
    ctpBadge: pots.currentHoleCtps.length ? pots.currentHoleCtps.map((ctp) => ctp.prize || ctp.division || "CTP").join(" · ") : "",
    ctpClaim: holeCtps.length
      ? {
          ctps: holeCtps,
        }
      : null,
    dormie: isMatchDormie(state),
    hole,
    holeGrid,
    holeMeta: "Par " + hole.par + (hole.distance_ft ? " · " + hole.distance_ft + " ft" : "") + (hole.overridden ? " (today)" : "") + ctpMeta,
    matchStatus: isMatchplayScoring(state) ? matchStatusText(state) : "",
    nextHole: nextPlayHole(state.holes, state.holeIdx, startHole),
    pots,
    potsAceHint: aceHint({ hole: hole && hole.hole, pots, scores: holeScores }),
    roundCode,
    rows: rowViews,
    scorerIndex,
    show: mode === "round",
    showPots: pots.visible,
    showWeather: Boolean(state.weather),
    teeOrderHint: tee.hint,
    teeSign,
    totals,
    udiscCourseId: state.udiscCourseId || "",
    warning,
    weather: state.weather,
    weatherVersion: state.weather && (state.weather.updatedAt || state.weather.nextRefreshAt || (state.weather.current && state.weather.current.fetchedAt) || ""),
    windFromDeg: state.weather && state.weather.current ? state.weather.current.windDirectionDeg : null,
    playerLocations: Array.isArray(state.playerLocations) ? state.playerLocations : [],
    selfMark: selfMapMark(state),
    yourTurn: yourTurnHint({ ...state, scorerIndex }),
    finish: buildFinishView(state, mode, blockers, locked, scorerIndex),
    formatLabel: roundFormatLabel(state),
    holes: Array.isArray(state.holes) ? state.holes : [],
    solo: rowViews.length === 1,
  };
}

function holeIsBehindCurrent(state, holeNumber) {
  const holes = Array.isArray(state.holes) ? state.holes : [];
  const startHole = startingHoleForState(state);
  const { order, pos } = playOrderPosition(holes, state.holeIdx, startHole);
  const index = holes.findIndex((row) => row && row.hole === holeNumber);
  if (index < 0) return false;
  const missingPos = order.indexOf(index);
  return missingPos >= 0 && missingPos < pos;
}

function locateHole(state, holeNumber) {
  const holes = Array.isArray(state.holes) ? state.holes : [];
  const index = holes.findIndex((row) => row && row.hole === holeNumber);
  return { hole: holeNumber, index: index >= 0 ? index : 0 };
}

function skippedUnscoredHoles(state, blockers) {
  return (blockers.missing || [])
    .filter((row) => row && Number.isFinite(Number(row.hole)) && holeIsBehindCurrent(state, Number(row.hole)))
    .map((row) => {
      const hole = Number(row.hole);
      return { ...locateHole(state, hole), kind: "missing", text: "Hole " + hole + " needs a score" };
    });
}

function finishBlocker(state, blockers) {
  const conflict = (blockers.conflicts || [])[0];
  if (conflict && Number.isFinite(Number(conflict.hole))) {
    const values = Array.isArray(conflict.values) ? conflict.values.join(" vs ") : "";
    return { ...locateHole(state, Number(conflict.hole)), kind: "conflict", text: "Hole " + conflict.hole + (values ? ": " + values : "") };
  }
  return skippedUnscoredHoles(state, blockers)[0] || null;
}

function buildFinishView(state, mode, blockers, locked, scorerIndex) {
  const canMode = mode === "round" || mode === "event";
  const attestation = state.cardAttestation && typeof state.cardAttestation === "object" ? state.cardAttestation : {};
  const agreedIndexes = Array.isArray(attestation.agreedIndexes) ? attestation.agreedIndexes : [];
  const review = cardReview(state, scorerIndex, agreedIndexes);
  const skipped = locked || blockers.ready ? [] : skippedUnscoredHoles(state, blockers);
  return {
    locked,
    ready: blockers.ready,
    status: state.status,
    canFinish: canMode && blockers.ready && !locked,
    confirmOpen: Boolean(state.finishConfirmOpen) && !locked,
    review,
    waiting: review.waiting,
    voterIndex: scorerIndex ?? state.myIndex,
    skipped,
    blocker: locked || blockers.ready ? null : finishBlocker(state, blockers),
  };
}

export function cardReview(state, scorerIndex, agreedIndexes) {
  const holes = Array.isArray(state.holes) ? state.holes : [];
  const agreed = Array.isArray(agreedIndexes) ? agreedIndexes : [];
  const rows = scoreRows(state).map((row) => {
    const scores = holes.map((hole) => strokesForRow(state, row, hole.hole, scorerIndex));
    let total = 0;
    let toPar = 0;
    scores.forEach((strokes, index) => {
      if (typeof strokes !== "number") return;
      total += strokes;
      toPar += strokes - (holes[index] && holes[index].par);
    });
    return {
      key: row.targetId || row.index,
      label: row.label,
      scores,
      total,
      toPar,
    };
  });
  const voters = (state.cardmates || []).filter(Boolean).map((player) => ({
    index: player.index,
    label: player.name + (player.isMe ? " (you)" : ""),
    agreed: agreed.indexOf(player.index) >= 0,
  }));
  return {
    holes: holes.map((hole) => hole.hole),
    rows,
    voters,
    waiting: voters.filter((voter) => !voter.agreed).map((voter) => String(voter.label).replace(/ \(you\)$/, "")),
  };
}

export function udiscExportData(state) {
  if (!state.udiscCourseId) return null;
  const me = (state.cardmates || []).find((cardmate) => cardmate.isMe);
  if (!me || !me.scores) return null;
  const scorecard = (state.holes || [])
    .filter((hole) => me.scores[hole.hole] != null)
    .map((hole) => ({ hole: hole.hole, par: hole.par, strokes: me.scores[hole.hole] }));
  return { courseId: state.udiscCourseId, scorecard };
}

function selfMapMark(state) {
  const mates = Array.isArray(state && state.cardmates) ? state.cardmates : [];
  const me = mates.find((player) => player && player.isMe)
    || mates.find((player) => player && player.index === state.myIndex);
  const index = Number.isInteger(state && state.myIndex)
    ? state.myIndex
    : (me && Number.isInteger(me.index) ? me.index : null);
  if (!Number.isInteger(index) && !me) return null;
  const loc = (Array.isArray(state.playerLocations) ? state.playerLocations : [])
    .find((row) => row && row.index === index);
  const name = String((me && me.name) || "");
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const fromName = parts.length
    ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
    : "";
  const initials = String((loc && loc.initials) || fromName).trim().toUpperCase();
  const mark = {
    index: Number.isInteger(index) ? index : undefined,
    initials: initials || undefined,
  };
  const photo = (me && me.photo) || (loc && loc.photo) || "";
  if (photo) mark.photo = photo;
  return mark;
}

export function finalizeBlockers(state) {
  const conflicts = state.conflicts || [];
  const missing = state.missing || [];
  const lines = [];
  conflicts.forEach((conflict) => {
    lines.push("Hole " + conflict.hole + " — " + (conflict.playerName || conflict.label || "a target") + ": scores disagree (" + (Array.isArray(conflict.values) ? conflict.values.join(" vs ") : "?") + ")");
  });
  const shown = missing.slice(0, 4);
  shown.forEach((row) => {
    lines.push("Hole " + row.hole + " — " + (row.playerName || row.label || "a target") + ": no confirmed score yet");
  });
  if (missing.length > shown.length) lines.push("…and " + (missing.length - shown.length) + " more holes without a score");
  return { conflicts, missing, ready: conflicts.length === 0 && missing.length === 0, lines };
}

export function finishRoundHint(blockers, mode, locked) {
  if (locked || (blockers && blockers.status === "final")) {
    return mode === "round" ? "Round finished. Scores are locked." : "This card is submitted. Scores are locked.";
  }
  if (blockers.ready) {
    return mode === "round"
      ? "Anyone on this card can finish. Matching scores on each hole are enough; extra cardmates do not need a second scorecard. Conflicts still block."
      : "Anyone on this card can submit. Matching scores on each hole are enough. Other cards keep playing until an admin finalizes the event.";
  }
  if ((blockers.conflicts || []).length) {
    return "Fix the disagreeing scores first. Extra scorecards are not required unless someone entered a different number.";
  }
  if ((blockers.missing || []).length) {
    return "Each hole needs one confirmed score. You can keep your own card; the round is not waiting for every member to type the same numbers.";
  }
  return "";
}
