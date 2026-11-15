export const SHOT_STATS_VERSION = "gvdg-shots-2";
export const TAP_IN_METERS = 3.3;
export const CIRCLE1_M = 10;
export const CIRCLE2_M = 20;
export const PARKED_FT = 10;
export const FAIRWAY_WIDTH_FT = 45;

export const SHOT_STAT_DEFINITIONS = Object.freeze({
  version: SHOT_STATS_VERSION,
  tapInMeters: TAP_IN_METERS,
  circle1Meters: CIRCLE1_M,
  circle2Meters: CIRCLE2_M,
  parkedFeet: PARKED_FT,
  estimatedFairwayOffsetFeet: FAIRWAY_WIDTH_FT,
  putting: "C1: up to 10 m; C1X: over 3.3 m through 10 m (excludes tap-in distances); C2: over 10 m through 20 m. Boundaries use unrounded distances.",
  legacy: "Marked lies are distance and outcome estimates, used only when the ordered lie count matches the score minus one. Matching the count does not verify that the player recorded every throw or confirm whether a stroke was a penalty. Legacy scorecards without recoverable as-played positions retain their original estimates separately.",
  fairway: "First throw fairway landing or, when inferred, within 45 ft of the straight tee-to-basket segment. This estimate does not follow doglegs or establish out-of-bounds status.",
  regulation: "C1/C2 and parked measure the lie after par minus two strokes; C2 in regulation includes C1. Parked is no more than 10 ft from the basket. A hole completed before the regulation checkpoint has no marked-lie sample.",
  scramble: "Par or better among holes where the known regulation lie missed Circle 1.",
  unavailable: "No sample for unknown distances, incomplete shot sequences, or unlabeled team marks. A score can count without yielding any throw statistics.",
});

function finite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function point(value) {
  const lat = finite(value?.lat);
  const lng = finite(value?.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function distanceMeters(a, b) {
  if (!a || !b) return null;
  const rad = (degrees) => degrees * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineOffsetFt(raw, a, b) {
  const p = point(raw);
  const start = point(a);
  const end = point(b);
  if (!p || !start || !end) return null;
  const toXY = (sample) => ({
    x: (sample.lng - start.lng) * 111320 * Math.cos(start.lat * Math.PI / 180) * 3.28084,
    y: (sample.lat - start.lat) * 111320 * 3.28084,
  });
  const B = toXY(end);
  const P = toXY(p);
  const lengthSquared = B.x * B.x + B.y * B.y;
  if (lengthSquared === 0) return null;
  const t = Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / lengthSquared));
  return Math.hypot(P.x - t * B.x, P.y - t * B.y);
}

export function fairwayHit(drive, tee, basket) {
  const offset = lineOffsetFt(drive, tee, basket);
  return offset == null ? null : offset <= FAIRWAY_WIDTH_FT;
}

export function regulationStrokes(par) {
  const n = finite(par);
  return n != null && n >= 2 ? Math.max(1, Math.round(n) - 2) : 1;
}

const sample = (hit) => ({ att: 1, hit: Number(hit) });

export function puttingBuckets(meters) {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return [];
  if (meters <= TAP_IN_METERS) return ["c1Putt"];
  if (meters <= CIRCLE1_M) return ["c1Putt", "c1xPutt"];
  if (meters <= CIRCLE2_M) return ["c2Putt"];
  return [];
}

// `throws` can be legacy ordered lies or a reconciled ledger entered by a scorer. A
// ledger's penalty entries consume a score stroke but never count as a putt or throw.
export function holePlayStats(hole, throws, score) {
  const rows = Array.isArray(throws) ? throws : [];
  const strokes = finite(score);
  const scored = Number.isInteger(strokes) && strokes > 0;
  const tee = point(hole?.tee);
  const basket = point(hole?.target) || point(hole?.basket);
  const par = finite(hole?.par);
  const stats = {
    fir: null, c1r: null, c2r: null, parked: null, scramble: null,
    c1Putt: null, c1xPutt: null, c2Putt: null,
    shotQuality: !scored ? "unscored" : rows.length ? "incomplete" : strokes === 1 ? "not-applicable" : "missing",
  };
  if (!scored) return stats;

  const hasLedgerEntries = rows.some((row) => row?.kind != null);
  const reg = par != null && par > 0 ? regulationStrokes(par) : null;
  const putting = [];
  let regulationLie = null;
  if (hasLedgerEntries) {
    if (rows.length !== strokes || !rows.every((row) => row?.kind === "penalty" ||
      (row?.kind === "throw" && (row.outcome === "missed" || row.outcome === "made")))) return stats;
    const madeIndex = rows.findIndex((row) => row.kind === "throw" && row.outcome === "made");
    if (madeIndex < 0 || rows.slice(madeIndex + 1).some((row) => row.kind !== "penalty")) return stats;
    stats.shotQuality = "recorded";
    const drive = rows.find((row) => row.kind === "throw");
    if (drive?.outOfBounds === true) stats.fir = sample(false);
    else if (drive?.outcome !== "made" && typeof drive?.fairway === "boolean") stats.fir = sample(drive.fairway);
    // Only a legal lie at the stroke checkpoint supplies regulation evidence. A penalty
    // can expressly supply a drop zone, including a rethrow from the same position.
    if (reg != null && reg <= madeIndex) {
      const step = rows[reg - 1];
      const next = rows[reg];
      regulationLie = step.outOfBounds === true ? null : point(step.landing) || (next?.kind === "throw" ? point(next.origin) : null);
    }
    for (const row of rows) {
      if (row.kind === "throw" && row.attempt === "putt") {
        putting.push({ meters: distanceMeters(point(row.origin), basket), made: row.outcome === "made" });
      }
    }
  } else {
    if (strokes === 1 || rows.length !== strokes - 1) return stats;
    const lies = rows.map(point);
    if (lies.some((lie, i) => !lie || (rows[i].n != null && finite(rows[i].n) !== i + 1))) return stats;
    stats.shotQuality = "estimated";
    const fairway = fairwayHit(lies[0], tee, basket);
    if (fairway != null) stats.fir = sample(fairway);
    if (reg != null) regulationLie = lies[reg - 1];
    for (const [index, lie] of lies.entries()) {
      putting.push({ meters: distanceMeters(lie, basket), made: index === lies.length - 1 });
    }
  }

  const regulationDistance = distanceMeters(regulationLie, basket);
  if (regulationDistance != null) {
    stats.c1r = sample(regulationDistance <= CIRCLE1_M);
    stats.c2r = sample(regulationDistance <= CIRCLE2_M);
    stats.parked = sample(regulationDistance * 3.28084 <= PARKED_FT);
    if (stats.c1r.hit === 0) stats.scramble = sample(strokes <= par);
  }
  for (const { meters, made } of putting) {
    for (const key of puttingBuckets(meters)) {
      const bucket = stats[key] || (stats[key] = { att: 0, hit: 0 });
      bucket.att += 1;
      bucket.hit += Number(made);
    }
  }
  return stats;
}
