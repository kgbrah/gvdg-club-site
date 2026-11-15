export const MAX_LEDGER_STROKES = 30;
export const SHOT_LIES = ["unknown", "tee", "fairway", "rough", "ob", "drop-zone", "basket"];
export const SHOT_OUTCOMES = ["unknown", "missed", "made"];
export const SHOT_ATTEMPTS = ["unknown", "throw", "putt"];
export const NO_SHOT_ROWS = Object.freeze([]);
export const SHOT_LABELS = Object.freeze({
  unknown: "Unknown", tee: "Tee", fairway: "Fairway", rough: "Rough", ob: "Out of bounds",
  "drop-zone": "Drop zone", basket: "Basket", throw: "Throw", putt: "Putt", penalty: "Penalty",
  missed: "Missed", made: "Made",
});

const SHOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ORDER = /^\d{16}:[0-9a-f-]{36}$/;
const MAX_TIME = 4_102_444_800_000;
const MIN_TIME = 946_684_800_000;

function number(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && number(value, MIN_TIME, MAX_TIME);
}

export function shotPoint(value) {
  if (!value || !number(value.lat, -90, 90) || !number(value.lng, -180, 180)) return null;
  if (value.accuracyM != null && !number(value.accuracyM, 0, 10_000)) return null;
  if (value.observedAt != null && !timestamp(value.observedAt)) return null;
  return {
    lat: Number(value.lat.toFixed(6)), lng: Number(value.lng.toFixed(6)),
    ...(value.accuracyM != null ? { accuracyM: Number(value.accuracyM.toFixed(1)) } : {}),
    ...(value.observedAt != null ? { observedAt: value.observedAt } : {}),
  };
}

function commonFields(raw) {
  if (!raw || typeof raw.id !== "string" || !SHOT_ID.test(raw.id)) return null;
  const landing = raw.landing == null ? null : shotPoint(raw.landing);
  if (raw.landing != null && !landing) return null;
  if (raw.recordedAt != null && !timestamp(raw.recordedAt)) return null;
  const landingLie = raw.landingLie ?? "unknown";
  if (!SHOT_LIES.includes(landingLie)) return null;
  return {
    id: raw.id, landingLie,
    ...(landing ? { landing } : {}),
    ...(raw.recordedAt != null ? { recordedAt: raw.recordedAt } : {}),
  };
}

function parseRow(raw) {
  const common = commonFields(raw);
  if (!common) return null;
  if (raw.kind === "penalty") return { kind: "penalty", ...common };
  if (raw.kind !== "throw") return null;
  const attempt = raw.attempt ?? "unknown";
  const outcome = raw.outcome ?? "unknown";
  const originLie = raw.originLie ?? "unknown";
  if (!SHOT_ATTEMPTS.includes(attempt) || !SHOT_OUTCOMES.includes(outcome) || !SHOT_LIES.includes(originLie)) return null;
  const origin = raw.origin == null ? null : shotPoint(raw.origin);
  if (raw.origin != null && !origin) return null;
  if (raw.distanceFt != null && !number(raw.distanceFt, 0, 4_000)) return null;
  if (raw.puttDistanceFt != null && (attempt !== "putt" || !number(raw.puttDistanceFt, 0, 4_000))) return null;
  const distance = raw.distanceFt == null ? null : Number(raw.distanceFt.toFixed(1));
  const distanceSource = raw.distanceSource ?? "manual";
  if (distance != null && distanceSource !== "manual" && (distanceSource !== "gps" || !origin || !common.landing)) return null;
  const outOfBounds = common.landingLie === "ob";
  const fairway = common.landingLie === "fairway" ? true
    : common.landingLie === "rough" || outOfBounds ? false : null;
  return {
    kind: "throw", ...common, attempt, outcome, originLie,
    ...(origin ? { origin } : {}),
    ...(distance != null ? { distanceFt: distance, distanceSource } : {}),
    ...(raw.puttDistanceFt != null ? { puttDistanceFt: Number(raw.puttDistanceFt.toFixed(1)) } : {}),
    ...(fairway != null ? { fairway } : {}),
    ...(outOfBounds ? { outOfBounds } : {}),
  };
}

export function parseShotRows(value) {
  if (!Array.isArray(value) || value.length > MAX_LEDGER_STROKES) return null;
  const ids = new Set();
  const rows = [];
  for (const item of value) {
    const row = parseRow(item);
    if (!row || ids.has(row.id)) return null;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}

export function validLedgerRevision(value) {
  return value === null || (typeof value === "string" && ORDER.test(value));
}

// A ledger retains the basket and tee that were recorded alongside it, including an unknown position.
export function shotHoleGeometry(hole, ledger) {
  if (!ledger) return hole;
  return { ...hole, tee: ledger.geometry.tee, target: ledger.geometry.target, basket: null };
}

export function shotLedgerQuality(rows, score) {
  if (!rows.length) return "empty";
  if (!Number.isInteger(score) || score <= 0) return "unscored";
  if (rows.length !== score) return "different-count";
  if (rows.some((row) => row.kind === "throw" && row.outcome !== "missed" && row.outcome !== "made")) return "unknown-outcome";
  if (rows.some((row) => row.kind === "throw" && row.attempt === "unknown")) return "unknown-attempt";
  const lastThrow = rows.findLastIndex((row) => row.kind === "throw");
  const firstMade = rows.findIndex((row) => row.kind === "throw" && row.outcome === "made");
  if (firstMade < 0 || firstMade !== lastThrow) return "missing-finish";
  return "complete";
}

export function describeShot(row) {
  const attempt = row.attempt === "unknown" ? "Stroke" : SHOT_LABELS[row.attempt];
  const description = row.kind === "penalty" ? "Penalty" : `${attempt} · ${row.outcome === "unknown" ? "Outcome unknown" : SHOT_LABELS[row.outcome]}`;
  const parts = [description];
  if (row.originLie && row.originLie !== "unknown") parts.push("from " + SHOT_LABELS[row.originLie].toLowerCase());
  if (row.landingLie !== "unknown") parts.push("to " + SHOT_LABELS[row.landingLie].toLowerCase());
  if (Number.isFinite(row.puttDistanceFt)) parts.push(row.puttDistanceFt + " ft to basket");
  if (Number.isFinite(row.distanceFt)) parts.push(row.distanceFt + " ft measured");
  return parts.join(" · ");
}
