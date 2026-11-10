const EMPTY_SCORES = {};

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function defaultPuttingStations() {
  return [
    { distanceFt: 15, putts: 5 },
    { distanceFt: 20, putts: 5 },
    { distanceFt: 25, putts: 5 },
    { distanceFt: 30, putts: 5 },
    { distanceFt: 33, putts: 5 },
  ];
}

function puttingStation(value) {
  const source = objectOrEmpty(value);
  const distance = Number(source.distanceFt);
  const putts = Number(source.putts);
  if (!Number.isInteger(distance) || distance < 8 || distance > 80) return null;
  if (!Number.isInteger(putts) || putts < 1 || putts > 10) return null;
  return { distanceFt: distance, putts };
}

export function puttingStationsFrom(raw) {
  const list = objectOrEmpty(objectOrEmpty(raw).putting).stations;
  const stations = (Array.isArray(list) ? list : []).map(puttingStation).filter(Boolean).slice(0, 12);
  return stations.length ? stations : defaultPuttingStations();
}

export function normalizeConfig(raw, fallbackPlayFormat = null, fallbackEventFormat = null) {
  if (raw && typeof raw === "object") {
    const scoringStyle = raw.scoringStyle === "matchplay" ? "matchplay" : raw.scoringStyle === "putting" ? "putting" : "stroke";
    const config = {
      groupFormat: scoringStyle === "putting" ? "singles" : (fallbackPlayFormat === "doubles" || raw.groupFormat === "doubles" ? "doubles" : "singles"),
      scoringStyle,
      handicap: scoringStyle === "stroke" && raw.handicap === true,
    };
    if (scoringStyle === "putting") config.putting = { stations: puttingStationsFrom(raw) };
    return config;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return normalizeConfig(JSON.parse(raw), fallbackPlayFormat, fallbackEventFormat);
    } catch {
      return normalizeConfig(null, fallbackPlayFormat, fallbackEventFormat);
    }
  }
  const scoringStyle = fallbackEventFormat === "matchplay" ? "matchplay" : fallbackEventFormat === "putting" ? "putting" : "stroke";
  const config = {
    groupFormat: scoringStyle === "putting" ? "singles" : (fallbackPlayFormat === "doubles" ? "doubles" : "singles"),
    scoringStyle,
    handicap: false,
  };
  if (scoringStyle === "putting") config.putting = { stations: defaultPuttingStations() };
  return config;
}

export function normalizeEvent(event) {
  const source = objectOrEmpty(event);
  return {
    courseId: source.course_id == null ? "" : String(source.course_id),
    date: text(source.date),
    eventFormat: text(source.format),
    id: source.id == null ? "" : String(source.id),
    layoutId: source.layout_id == null ? "" : String(source.layout_id),
    liveScoringConfig: source.liveScoringConfig || source.live_scoring_config || source.live_scoring_config_json || null,
    name: text(source.name, "Untitled event") || "Untitled event",
    playFormat: text(source.play_format),
    source,
    status: text(source.status, "scheduled") || "scheduled",
  };
}

export function playableEvents(events) {
  return events.map(normalizeEvent).filter((event) => event.status === "scheduled" || event.status === "live");
}

export function eventConfig(event) {
  return normalizeConfig(event.liveScoringConfig, event.playFormat, event.eventFormat);
}

export function layoutLabel(layout) {
  const source = objectOrEmpty(layout);
  const name = text(source.name, "Layout") || "Layout";
  const totalPar = source.total_par == null ? "?" : source.total_par;
  return `${name} (par ${totalPar})`;
}

export function toPar(value) {
  const n = Number(value || 0);
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : String(n);
}

export function isDoubles(snapshot) {
  return objectOrEmpty(snapshot).roundConfig?.groupFormat === "doubles";
}

export function isMatchplay(snapshot) {
  return objectOrEmpty(snapshot).roundConfig?.scoringStyle === "matchplay";
}

export function isPutting(snapshot) {
  return objectOrEmpty(snapshot).roundConfig?.scoringStyle === "putting";
}

export function playerByIndex(snapshot, index) {
  const players = Array.isArray(snapshot?.players) ? snapshot.players : [];
  return players.find((player) => player && player.index === index) || null;
}

export function scoreRows(snapshot) {
  const snap = objectOrEmpty(snapshot);
  const players = Array.isArray(snap.players) ? snap.players : [];
  if (!isDoubles(snap)) {
    return players.map((player) => ({
      index: player.index,
      label: text(player.name, "Player") || "Player",
      meta: text(player.division, "N/A") || "N/A",
      playerIndexes: [player.index],
      start: player.startingHole == null ? "N/A" : String(player.startingHole),
      type: "player",
    }));
  }
  const targets = Array.isArray(snap.scoreTargets) ? snap.scoreTargets : [];
  return targets.filter((target) => target?.type === "pair").map((target) => {
    const firstPlayer = playerByIndex(snap, Array.isArray(target.playerIndexes) ? target.playerIndexes[0] : null);
    return {
      label: text(target.label, "Pair") || "Pair",
      meta: Array.isArray(target.members) ? target.members.join(" / ") : "",
      playerIndexes: Array.isArray(target.playerIndexes) ? target.playerIndexes : [],
      start: firstPlayer?.startingHole || "N/A",
      targetId: target.id,
      type: "pair",
    };
  });
}

export function scoreForRow(snapshot, row, hole) {
  const player = playerByIndex(snapshot, Array.isArray(row.playerIndexes) ? row.playerIndexes[0] : null);
  const scores = player?.scores || EMPTY_SCORES;
  const value = scores[hole];
  return value == null ? null : value;
}

export function rowTotal(snapshot, row) {
  const holes = Array.isArray(snapshot?.holes) ? snapshot.holes : [];
  return holes.reduce((total, hole) => {
    const score = scoreForRow(snapshot, row, hole.hole);
    return score == null ? total : total + score;
  }, 0);
}

export function conflictForRow(snapshot, row, hole) {
  const conflicts = Array.isArray(snapshot?.conflicts) ? snapshot.conflicts : [];
  if (row.targetId) return conflicts.find((conflict) => conflict?.targetId === row.targetId && conflict.hole === hole) || null;
  return conflicts.find((conflict) => conflict?.playerIndex === row.index && conflict.hole === hole) || null;
}

export function conflictTitle(conflict) {
  const values = Array.isArray(conflict?.values) ? conflict.values.join(" vs ") : "scores do not match";
  return `Score conflict: ${values}`;
}

export function parseLayoutHoles(layout) {
  if (Array.isArray(layout?.holes)) return layout.holes;
  try {
    const parsed = JSON.parse(layout?.holes || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
