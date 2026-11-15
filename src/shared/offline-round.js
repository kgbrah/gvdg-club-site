import { layoutQuality, mapCoordinates } from "./course-quality.js";
import { parseShotRows, shotPoint } from "./shot-ledger.js";

export const MAX_OFFLINE_PLAYERS = 16;
export const OFFLINE_ROUND_VERSION = 1;
export const OFFLINE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function record(raw) { return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null; }
function text(value, limit) { return typeof value === "string" && value.trim() && value.length <= limit ? value.trim() : null; }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value ? value : null;
}

function marker(value) {
  const coords = mapCoordinates(value);
  const label = text(value?.label, 120);
  return coords || label ? { label: label || "", lat: coords?.lat ?? null, lng: coords?.lng ?? null } : null;
}

export function offlineLayoutSnapshot(pack) {
  const quality = layoutQuality(pack?.layout);
  if (!quality.scorable || !pack?.course || !pack?.layout) return null;
  return parseSource({
    courseId: pack.course.id, courseName: pack.course.name, layoutId: pack.layout.id, layoutName: pack.layout.name,
    savedAt: pack.savedAt, revision: pack.revision, contentRevision: pack.contentRevision,
    holes: pack.layout.holes.map((row) => ({ ...row, hole: Number(row.hole), par: Number(row.par) })),
  });
}

function parseSource(value) {
  const source = record(value);
  if (!source || !integer(source.courseId, 1, Number.MAX_SAFE_INTEGER) || !integer(source.layoutId, 1, Number.MAX_SAFE_INTEGER)) return null;
  const courseName = text(source.courseName, 160);
  const layoutName = text(source.layoutName, 160);
  const revision = text(source.revision, 512);
  const contentRevision = text(source.contentRevision, 512);
  const savedAt = isoDate(source.savedAt);
  if (!courseName || !layoutName || !revision || !contentRevision || !savedAt ||
      !Array.isArray(source.holes) || source.holes.length < 1 || source.holes.length > 36) return null;
  const seen = new Set();
  const holes = [];
  for (const row of source.holes) {
    if (!row || !integer(row.hole, 1, 36) || seen.has(row.hole) || !integer(row.par, 1, 15)) return null;
    seen.add(row.hole);
    if (row.distance_ft != null && !(typeof row.distance_ft === "number" && Number.isFinite(row.distance_ft) && row.distance_ft > 0 && row.distance_ft <= 30_000)) return null;
    holes.push({
      hole: row.hole, par: row.par, par_source: text(row.par_source, 30),
      distance_ft: row.distance_ft ?? null, distance_source: text(row.distance_source, 30), tee: marker(row.tee), target: marker(row.target),
    });
  }
  return { courseId: source.courseId, courseName, layoutId: source.layoutId, layoutName, savedAt, revision, contentRevision, holes };
}

function supportedFormat(value) {
  const { groupFormat, scoringStyle } = value || {};
  return ["singles", "doubles"].includes(groupFormat) && ["stroke", "matchplay"].includes(scoringStyle) ? { groupFormat, scoringStyle } : null;
}

function parsePlayers(value, format) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OFFLINE_PLAYERS) return null;
  if (format.groupFormat === "doubles" && value.length % 2) return null;
  if (format.scoringStyle === "matchplay" && value.length !== (format.groupFormat === "doubles" ? 4 : 2)) return null;
  const ids = new Set();
  const players = [];
  for (const row of value) {
    const name = text(row?.name, 60);
    if (!name || typeof row?.id !== "string" || !OFFLINE_ID.test(row.id) || ids.has(row.id)) return null;
    ids.add(row.id);
    players.push({ id: row.id, name });
  }
  return players;
}

export function offlineTargets(round) {
  if (round.format.groupFormat === "singles") return round.players.map((player, index) => ({
    id: `player:${index}`, type: "player", label: player.name, playerIndexes: [index], members: [player.name],
  }));
  return round.players.flatMap((player, index) => index % 2 ? [] : [{
    id: `pair:team ${index / 2 + 1}`, type: "pair", label: `Team ${index / 2 + 1}`,
    playerIndexes: [index, index + 1], members: [player.name, round.players[index + 1].name],
  }]);
}

export function offlineRoundOutcome(round) {
  const holes = round.source.holes;
  const targets = offlineTargets(round);
  let required = holes;
  let match = null;
  if (round.format.scoringStyle === "matchplay") {
    const [left, right] = targets;
    let lead = 0;
    let played = 0;
    for (const [index, hole] of holes.entries()) {
      const a = round.scores[left.id]?.[hole.hole];
      const b = round.scores[right.id]?.[hole.hole];
      if (a == null || b == null) break;
      lead += Math.sign(b - a);
      played = index + 1;
      if (Math.abs(lead) > holes.length - played) { required = holes.slice(0, played); break; }
    }
    const remaining = holes.length - played;
    const final = played === holes.length || Math.abs(lead) > remaining;
    const leader = lead ? (lead > 0 ? left.id : right.id) : null;
    match = { played, lead, remaining, final, leader, label: lead ? `${Math.abs(lead)}${remaining ? final ? `&${remaining}` : " UP" : " UP"}` : "AS" };
  }
  const missing = required.flatMap(({ hole }) => targets.filter((target) => round.scores[target.id]?.[hole] == null)
    .map((target) => ({ hole, targetId: target.id, playerName: target.label, label: target.label })));
  const summaries = targets.map((target) => {
    const scored = required.filter((hole) => round.scores[target.id]?.[hole.hole] != null);
    const total = scored.reduce((sum, hole) => sum + round.scores[target.id][hole.hole], 0);
    return { ...target, thru: scored.length, total, toPar: total - scored.reduce((sum, hole) => sum + hole.par, 0) };
  });
  return { missing, complete: missing.length === 0, summaries, match, requiredHoles: required.map(({ hole }) => hole) };
}

function parseScores(raw, round) {
  const values = record(raw);
  if (!values) return null;
  const validTargets = new Set(offlineTargets(round).map((target) => target.id));
  const validHoles = new Set(round.source.holes.map(({ hole }) => String(hole)));
  const scores = {};
  for (const target of Object.keys(values).sort()) {
    if (!validTargets.has(target) || !record(values[target])) return null;
    const board = {};
    for (const [hole, score] of Object.entries(values[target])) {
      if (!validHoles.has(hole) || !integer(score, 1, 30)) return null;
      board[hole] = score;
    }
    if (Object.keys(board).length) scores[target] = board;
  }
  return scores;
}

function parseEvidence(round, rawShots, rawMarks) {
  const shots = record(rawShots);
  const marks = record(rawMarks);
  if (!shots || !marks) return null;
  const index = new Set(round.source.holes.map(({ hole }) => String(hole)));
  const evidence = { shots: {}, marks: {} };
  for (const [hole, rows] of Object.entries(shots)) {
    const ledger = parseShotRows(rows);
    if (!index.has(hole) || !ledger) return null;
    if (ledger.length) evidence.shots[hole] = ledger;
  }
  for (const [hole, rows] of Object.entries(marks)) {
    if (!index.has(hole) || !Array.isArray(rows) || rows.length > 18) return null;
    const points = rows.map((row, i) => {
      const point = shotPoint(row);
      return point ? { lat: point.lat, lng: point.lng, n: i + 1 } : null;
    });
    if (points.some((row) => !row)) return null;
    if (points.length) evidence.marks[hole] = points;
  }
  return evidence;
}

export function offlineOwner(value) {
  const owner = record(value);
  const id = text(owner?.id, 180);
  return id && ["member", "open"].includes(owner.kind) ? { kind: owner.kind, id } : null;
}

export function createLocalRound({ pack, owner, names, format, now = new Date(), uuid = () => crypto.randomUUID() }) {
  const source = offlineLayoutSnapshot(pack);
  const config = supportedFormat(format);
  const players = config ? parsePlayers(names.map((name) => ({ id: uuid(), name })), config) : null;
  if (!source || !players) return null;
  const boundOwner = offlineOwner(owner);
  return {
    version: OFFLINE_ROUND_VERSION, localId: uuid(), owner: boundOwner, startedAs: boundOwner ? "account" : "device",
    source, format: config, players, scores: {}, shots: {}, marks: {}, startedAt: now.toISOString(), finishedAt: null,
    revision: 1, sealedAt: null, receipt: null, uploadError: null, retryAt: null, attempts: 0,
  };
}

/** Canonicalizes an untrusted complete card. Player slots and score targets are always derived. */
export function parseOfflineRound(value) {
  const raw = record(value);
  if (!raw || raw.version !== OFFLINE_ROUND_VERSION || typeof raw.localId !== "string" || !OFFLINE_ID.test(raw.localId)) return null;
  const owner = offlineOwner(raw.owner);
  const source = parseSource(raw.source);
  const format = supportedFormat(raw.format);
  const players = format && parsePlayers(raw.players, format);
  const startedAt = isoDate(raw.startedAt);
  const finishedAt = isoDate(raw.finishedAt);
  if (!owner || !source || !format || !players || !startedAt || !finishedAt || finishedAt < startedAt ||
      !["account", "device"].includes(raw.startedAs)) return null;
  const round = { version: OFFLINE_ROUND_VERSION, localId: raw.localId, owner, startedAs: raw.startedAs, source, format, players, startedAt, finishedAt };
  const scores = parseScores(raw.scores, round);
  const evidence = parseEvidence(round, raw.shots, raw.marks);
  if (!scores || !evidence || !offlineRoundOutcome({ ...round, scores }).complete) return null;
  return { ...round, scores, ...evidence };
}
