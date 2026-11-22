function parseJson(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function marker(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseThrows(raw) {
  if (!Array.isArray(raw)) return [];
  const throws = [];
  for (const row of raw) {
    const lat = Number(row && row.lat);
    const lng = Number(row && row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    throws.push({ lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), n: throws.length + 1 });
    if (throws.length >= 18) break;
  }
  return throws;
}

function parseHoles(raw) {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hole = Number(item.hole);
    const par = Number(item.par);
    if (!Number.isInteger(hole) || !Number.isInteger(par)) return [];
    const distance = Number(item.distance_ft);
    const points = Number(item.points);
    const tee = marker(item.tee);
    const target = marker(item.target);
    return [{
      hole,
      par,
      distance_ft: Number.isFinite(distance) ? distance : null,
      ...(Number.isInteger(points) && points > 1 ? { points } : {}),
      ...(tee ? { tee } : {}),
      ...(target ? { target } : {}),
    }];
  });
}

function parseScorecard(raw) {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const hole = Number(item.hole);
    const par = Number(item.par);
    const strokes = Number(item.strokes);
    if (!Number.isInteger(hole) || !Number.isInteger(par) || !Number.isInteger(strokes)) return [];
    return [{ hole, par, strokes, throws: parseThrows(item.throws) }];
  });
}

export function watchableLiveSnapshot(data) {
  if (!data || typeof data !== "object") return false;
  if (data.status !== "live" && data.status !== "final") return false;
  return Array.isArray(data.holes) && data.holes.length > 0;
}

/** Public replay built from GET /rounds/:code/results when the live DO snapshot is gone or empty. */
export function casualReplaySnapshot(payload) {
  const round = payload && payload.round;
  if (!round || typeof round !== "object") return null;
  const results = Array.isArray(payload.results) ? payload.results : [];
  const holes = parseHoles(round.holes);
  const mappedIndexes = results.flatMap((row) => Number.isInteger(row?.live_player_index) ? [row.live_player_index] : []);
  let unmappedIndex = Math.max(-1, ...mappedIndexes) + 1;
  const players = results.map((row) => {
    const mapped = Number.isInteger(row?.live_player_index);
    const index = mapped ? row.live_player_index : unmappedIndex++;
    const scorecard = parseScorecard(row && row.scorecard);
    const scores = {};
    const throws = {};
    for (const hole of scorecard) {
      scores[hole.hole] = hole.strokes;
      if (hole.throws.length) throws[hole.hole] = hole.throws;
    }
    return {
      index,
      clipPlayerIndex: mapped ? index : null,
      cardId: "h1",
      name: String((row && row.name) || "Player"),
      division: row && row.division != null ? String(row.division) : null,
      team: null,
      startingHole: null,
      scores,
      scorecards: {},
      throws,
    };
  });
  if (!players.length && !holes.length) return null;
  const holeCount = holes.length;
  const roundConfig = parseJson(round.scoring_config);
  return {
    status: "final",
    rev: 0,
    recoveryRoundId: typeof round.live_generation === "string" ? round.live_generation : null,
    updatedAt: round.finalized_at ?? round.started_at ?? null,
    eventId: null,
    courseId: asInt(round.course_id),
    layoutId: asInt(round.layout_id),
    roundCode: round.round_code == null ? null : String(round.round_code),
    roundConfig: roundConfig && typeof roundConfig === "object" && !Array.isArray(roundConfig) ? roundConfig : null,
    courseName: round.course_name == null ? null : String(round.course_name),
    layoutName: round.layout_name == null ? null : String(round.layout_name),
    holes,
    players,
    scoreTargets: (() => {
      const targets = [];
      const pairIndex = new Map();
      results.forEach((row, index) => {
        const player = players[index];
        const group = parseJson(row && row.scoring_group);
        if (group && group.targetType === "pair" && typeof group.targetId === "string" && group.targetId !== "") {
          const existing = pairIndex.get(group.targetId);
          if (existing != null) {
            targets[existing].playerIndexes.push(player.index);
            if (!targets[existing].members.includes(player.name)) targets[existing].members.push(player.name);
            return;
          }
          pairIndex.set(group.targetId, targets.length);
          const members = Array.isArray(group.members) && group.members.length ? [...group.members] : [player.name];
          targets.push({ type: "pair", id: group.targetId, label: group.label || player.name, playerIndexes: [player.index], members });
          return;
        }
        targets.push({ type: "player", id: "p" + player.index, label: player.name, playerIndexes: [player.index], members: [player.name] });
      });
      return targets;
    })(),
    standings: (() => {
      const standings = [];
      const pairIndex = new Map();
      results.forEach((row, index) => {
        const scorecard = parseScorecard(row && row.scorecard);
        const total = asInt(row && row.total);
        const toPar = asInt(row && row.to_par);
        const name = String((row && row.name) || "Player");
        const player = players[index];
        const thru = scorecard.length || (row && row.place != null && total != null && total > 0 && holeCount ? holeCount : 0);
        const group = parseJson(row && row.scoring_group);
        if (group && group.targetType === "pair" && typeof group.targetId === "string" && group.targetId !== "") {
          const existingIdx = pairIndex.get(group.targetId);
          if (existingIdx != null) {
            standings[existingIdx].playerIndexes.push(player.index);
            if (player.clipPlayerIndex != null) standings[existingIdx].clipPlayerIndexes.push(player.clipPlayerIndex);
            if (!standings[existingIdx].members.includes(player.name)) standings[existingIdx].members.push(player.name);
            return;
          }
          const members = Array.isArray(group.members) && group.members.length ? [...group.members] : [player.name];
          pairIndex.set(group.targetId, standings.length);
          standings.push({
            name: group.label || player.name,
            division: null,
            thru,
            total: total ?? 0,
            toPar: toPar ?? 0,
            targetId: group.targetId,
            targetType: "pair",
            playerIndexes: [player.index],
            clipPlayerIndexes: player.clipPlayerIndex == null ? [] : [player.clipPlayerIndex],
            members,
            scorecard: scorecard.map((hole) => ({ hole: hole.hole, par: hole.par, strokes: hole.strokes })),
            scoringGroup: group,
            match: parseJson(row && row.match_result),
          });
          return;
        }
        standings.push({
          name,
          division: row && row.division != null ? String(row.division) : null,
          thru,
          total: total ?? 0,
          toPar: toPar ?? 0,
          targetId: "p" + player.index,
          targetType: "player",
          playerIndexes: [player.index],
          clipPlayerIndexes: player.clipPlayerIndex == null ? [] : [player.clipPlayerIndex],
          members: [name],
          scorecard: scorecard.map((hole) => ({ hole: hole.hole, par: hole.par, strokes: hole.strokes })),
          scoringGroup: group,
          match: parseJson(row && row.match_result),
        });
      });
      return standings;
    })(),
    liveCtps: [],
    playerLocations: [],
    lockedCardIds: [],
    cardAttestations: {},
    archived: true,
  };
}
