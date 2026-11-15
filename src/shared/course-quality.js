export const COVERAGE_LABELS = Object.freeze({
  listed: "Listed",
  scorable: "Scorable",
  partial: "Partially mapped",
  full: "Fully mapped",
});

export const COVERAGE_ORDER = Object.freeze({ listed: 0, scorable: 1, partial: 2, full: 3 });

function numeric(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mapCoordinates(value) {
  const lat = numeric(value?.lat);
  const lng = numeric(value?.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

export function mappedHole(hole) {
  const tee = mapCoordinates(hole?.tee);
  const target = mapCoordinates(hole?.target);
  return Boolean(tee && target && (Math.abs(tee.lat - target.lat) >= 1e-8 || Math.abs(tee.lng - target.lng) >= 1e-8));
}

export function layoutRows(layout) {
  let holes = layout?.map_holes ?? layout?.holes;
  if (typeof holes === "string") {
    try { holes = JSON.parse(holes); } catch { return []; }
  }
  return Array.isArray(holes) ? holes : [];
}

function holeNumber(value) {
  const number = numeric(value);
  return Number.isInteger(number) && number >= 1 && number <= 36 ? number : null;
}

function effectivePar(hole) {
  const actual = numeric(hole?.par);
  return Number.isInteger(actual) && actual >= 1 && actual <= 15 ? actual : null;
}

function parProvenance(hole, template) {
  if (effectivePar(hole) == null) return "missing";
  const approved = numeric(hole.verified?.par) === effectivePar(hole) && typeof hole.verified?.tee_sign_key === "string" && hole.verified.tee_sign_key.length > 0;
  if (approved || hole.par_source === "tee-sign") return "tee-sign";
  if (hole.par_source === "placeholder" || (!hole.par_source && template && Number(hole.par) === 3)) return "placeholder";
  return hole.par_source === "udisc" ? "udisc" : "recorded";
}

export function layoutQuality(layout) {
  const rows = layoutRows(layout);
  const template = String(layout?.name || "").trim().toLowerCase() === "default (par 3s)";
  const seen = new Set();
  const holes = [];
  let invalidRows = 0;
  for (const row of rows) {
    const hole = holeNumber(row?.hole ?? row?.number);
    if (hole == null || seen.has(hole)) {
      invalidRows += 1;
      continue;
    }
    seen.add(hole);
    const tee = Boolean(mapCoordinates(row.tee));
    const basket = Boolean(mapCoordinates(row.target));
    const mapped = mappedHole(row);
    const parSource = parProvenance(row, template);
    const missing = [];
    if (!tee) missing.push("tee");
    if (!basket) missing.push("basket");
    if (tee && basket && !mapped) missing.push("distinct-positions");
    if (parSource === "missing") missing.push("par");
    if (parSource === "placeholder") missing.push("confirmed-par");
    holes.push({ hole, par: effectivePar(row), parSource, tee, basket, mapped, missing });
  }
  const expected = holeNumber(layout?.expected_holes ?? layout?.hole_count);
  const unlistedHoles = expected == null ? 0 : Math.max(0, expected - holes.length);
  const holeCount = Math.max(holes.length, expected ?? 0);
  const mappedCount = holes.filter((hole) => hole.mapped).length;
  const positioned = holes.some((hole) => hole.tee || hole.basket);
  const placeholderPars = holes.filter((hole) => hole.parSource === "placeholder").length;
  const teeSignPars = holes.filter((hole) => hole.parSource === "tee-sign").length;
  const scorable = holeCount > 0 && unlistedHoles === 0 && invalidRows === 0 && holes.every((hole) => hole.par != null);
  const full = scorable && mappedCount === holeCount && placeholderPars === 0;
  return {
    status: full ? "full" : positioned ? "partial" : scorable ? "scorable" : "listed",
    holeCount, mappedCount, invalidRows, unlistedHoles, placeholderPars, teeSignPars, scorable, holes,
  };
}

export function courseCoverage(course) {
  if (course?.coverage && Object.hasOwn(COVERAGE_ORDER, course.coverage)) return course.coverage;
  if (Array.isArray(course?.layouts) && course.layouts.length) {
    return course.layouts.reduce((best, layout) => {
      const status = layoutQuality(layout).status;
      return COVERAGE_ORDER[status] > COVERAGE_ORDER[best] ? status : best;
    }, "listed");
  }
  if (course?.holes) return layoutQuality(course).status;
  return Number(course?.mapped) === 1 || Number(course?.has_map) === 1 ? "partial" : "listed";
}

export function layoutRevision(layout) {
  const rows = layoutRows(layout).map((row) => [
    row?.hole ?? row?.number, row?.par, row?.par_source, row?.verified?.par, row?.verified?.tee_sign_id ?? row?.tee_sign_id,
    row?.distance_ft, row?.distance_source, row?.tee?.label, row?.tee?.source, row?.target?.label, row?.target?.source,
    mapCoordinates(row?.tee), mapCoordinates(row?.target),
  ]);
  const input = JSON.stringify([layout?.name, layout?.expected_holes ?? layout?.hole_count, rows]);
  let digest = 2166136261;
  for (let index = 0; index < input.length; index += 1) digest = Math.imul(digest ^ input.charCodeAt(index), 16777619);
  return "layout-" + (digest >>> 0).toString(16).padStart(8, "0");
}
