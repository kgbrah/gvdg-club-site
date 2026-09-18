function finite(value) {
  if (value == null || value === "") return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function holePoint(value) {
  if (!value || typeof value !== "object") return null;
  const lat = finite(value.lat);
  const lng = finite(value.lng);
  if (lat == null || lng == null) return null;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  return { lat, lng, label };
}

function haversineMeters(a, b) {
  const radiusMeters = 6371000;
  const rad = (degrees) => degrees * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function haversineFt(a, b) {
  return Math.round(haversineMeters(a, b) * 3.28084);
}

export const CIRCLE1_M = 10;
export const CIRCLE2_M = 20;
export const CIRCLE1_FT = CIRCLE1_M * 3.28084;
export const CIRCLE2_FT = CIRCLE2_M * 3.28084;
const FOCUS_C1_PAD_M = 16;
const FOCUS_C2_PAD_M = 28;

export function remainingFt(from, to) {
  const a = holePoint(from);
  const b = holePoint(to);
  if (!a || !b) return null;
  return haversineFt(a, b);
}

export function puttingCircle(from, to) {
  const a = holePoint(from);
  const b = holePoint(to);
  if (!a || !b) return null;
  const meters = haversineMeters(a, b);
  if (meters <= CIRCLE1_M) return "C1";
  if (meters <= CIRCLE2_M) return "C2";
  return null;
}

export function mapFocusFromRemaining(ft) {
  const n = finite(ft);
  if (n == null) return "hole";
  if (n <= CIRCLE1_FT) return "c1";
  if (n <= CIRCLE2_FT) return "c2";
  return "hole";
}

export function resolveMapFocus(userFocus, remainingFt) {
  if (userFocus === "hole" || userFocus === "c1" || userFocus === "c2") return userFocus;
  return mapFocusFromRemaining(remainingFt);
}

export function rangeHud({ from, to, mode, holeFt } = {}) {
  if (mode === "hole") {
    const ft = finite(holeFt);
    if (ft == null || ft <= 0) return null;
    return { caption: "hole", circle: null, ft: Math.round(ft), mode: "hole" };
  }
  const ft = remainingFt(from, to);
  if (ft == null) return null;
  const circle = puttingCircle(from, to);
  if (mode === "throw") {
    return { caption: "throw", circle, ft, mode: "throw" };
  }
  return {
    caption: circle ? "in " + circle : "to basket",
    circle,
    ft,
    mode: "remaining",
  };
}

export const GPS_REMAINING_MAX_FT = 2500;
export const GPS_WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 8000,
  timeout: 60000,
};

export function gpsErrorPolicy(code, hasFix) {
  if (Number(code) === 1) {
    return { keepFix: true, restart: false, retryMs: 0, status: "denied" };
  }
  return {
    keepFix: true,
    restart: true,
    retryMs: 2000,
    status: hasFix ? "ready" : "watching",
  };
}

export function nextTeeHud(gps, nextHole) {
  const ft = remainingFt(gps, nextHole && nextHole.tee);
  if (ft == null || ft <= 0 || ft > GPS_REMAINING_MAX_FT) return null;
  return { caption: "next tee", ft };
}

export function gpsHudPrompt(status, mode) {
  if (mode === "remaining" || mode === "throw") return "";
  if (status === "denied") return "GPS blocked";
  if (status === "watching") return "Finding GPS…";
  if (status === "unavailable") return "GPS unavailable";
  if (status === "ready" && mode !== "hole") return "";
  return "Tap for GPS";
}

export function withSelfLocation(players, gps) {
  const rows = Array.isArray(players) ? players.slice() : [];
  if (!gps || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lng)) return rows;
  return rows.concat([{ initials: "ME", lat: gps.lat, lng: gps.lng, relClass: "self" }]);
}

export function currentRangeHud(hole, gps, measure) {
  const holeFt = finite(hole && hole.distance_ft);
  const holeHud = rangeHud({ holeFt, mode: "hole" });
  let primary = null;
  if (measure && measure.a && measure.b) {
    primary = rangeHud({ from: measure.a, mode: "throw", to: measure.b });
  } else if (measure && measure.a && gps) {
    primary = rangeHud({ from: measure.a, mode: "throw", to: gps });
  } else if (measure && measure.a && hole && hole.target) {
    primary = rangeHud({ from: measure.a, to: hole.target });
  } else if (gps && hole && hole.target) {
    primary = rangeHud({ from: gps, to: hole.target });
  }
  if (!primary) return holeHud;
  if (holeFt == null || holeFt <= 0) return primary;
  return { ...primary, holeFt: Math.round(holeFt) };
}


export function headingDeg(from, to) {
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

export function teePadRotationDeg(tee, basket) {
  if (!tee || !basket) return 0;
  const dx = Number(basket.x) - Number(tee.x);
  const dy = Number(basket.y) - Number(tee.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return 0;
  // Local pad +Y is the long throwing axis. Align it with the on-screen
  // tee→basket line, not geographic heading (the 16:9 map is stretched).
  return Number(((Math.atan2(dy, dx) * 180 / Math.PI) - 90).toFixed(2));
}

export function windBlowToDeg(windFromDeg) {
  const from = finite(windFromDeg);
  return from == null ? null : (from + 180) % 360;
}

const SATELLITE_EXPORT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export";
export const SATELLITE_CREDIT = "Imagery: Esri, Maxar, Earthstar Geographics";
const BOUNDS_PAD_RATIO = 0.7;
const BOUNDS_MIN_DEG = 0.00032;

function paddedBounds(tee, basket) {
  const minLat = Math.min(tee.lat, basket.lat);
  const maxLat = Math.max(tee.lat, basket.lat);
  const minLng = Math.min(tee.lng, basket.lng);
  const maxLng = Math.max(tee.lng, basket.lng);
  const midLat = (minLat + maxLat) / 2;
  const latPad = Math.max((maxLat - minLat) * BOUNDS_PAD_RATIO, BOUNDS_MIN_DEG);
  const lngPad = Math.max((maxLng - minLng) * BOUNDS_PAD_RATIO, BOUNDS_MIN_DEG / Math.max(Math.cos(midLat * Math.PI / 180), 0.2));
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLng: minLng - lngPad,
    maxLng: maxLng + lngPad,
  };
}

function focusBounds(basket, radiusMeters) {
  const meters = finite(radiusMeters) || FOCUS_C2_PAD_M;
  const dLat = meters / 111320;
  const cosLat = Math.max(Math.cos(basket.lat * Math.PI / 180), 0.2);
  const dLng = meters / (111320 * cosLat);
  return {
    minLat: basket.lat - dLat,
    maxLat: basket.lat + dLat,
    minLng: basket.lng - dLng,
    maxLng: basket.lng + dLng,
  };
}

function boundsForFocus(tee, basket, focus) {
  if (focus === "c1") return focusBounds(basket, FOCUS_C1_PAD_M);
  if (focus === "c2") return focusBounds(basket, FOCUS_C2_PAD_M);
  return paddedBounds(tee, basket);
}

export function satelliteImageUrl(bounds, width, height) {
  if (!bounds) return "";
  const spanLng = bounds.maxLng - bounds.minLng;
  const spanLat = bounds.maxLat - bounds.minLat;
  if (!(spanLng > 0) || !(spanLat > 0)) return "";
  const params = new URLSearchParams({
    bbox: [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat].map((value) => value.toFixed(7)).join(","),
    bboxSR: "4326",
    imageSR: "4326",
    size: Math.round(width) + "," + Math.round(height),
    format: "jpg",
    f: "image",
  });
  return SATELLITE_EXPORT + "?" + params.toString();
}

function mapXy(bounds, width, height, lng, lat) {
  const spanLng = Math.max(bounds.maxLng - bounds.minLng, 1e-7);
  const spanLat = Math.max(bounds.maxLat - bounds.minLat, 1e-7);
  return {
    x: Number((((lng - bounds.minLng) / spanLng) * width).toFixed(2)),
    y: Number((((bounds.maxLat - lat) / spanLat) * height).toFixed(2)),
  };
}

export function circleEllipse(map, radiusMeters) {
  const basket = holePoint(map && map.basket);
  if (!map || !map.bounds || !basket) return null;
  const meters = finite(radiusMeters);
  if (meters == null || meters <= 0) return null;
  const dLat = meters / 111320;
  const cosLat = Math.max(Math.cos(basket.lat * Math.PI / 180), 0.2);
  const dLng = meters / (111320 * cosLat);
  const north = mapXy(map.bounds, map.width, map.height, basket.lng, basket.lat + dLat);
  const east = mapXy(map.bounds, map.width, map.height, basket.lng + dLng, basket.lat);
  const rx = Math.abs(east.x - map.basket.x);
  const ry = Math.abs(north.y - map.basket.y);
  if (!(rx > 0) || !(ry > 0)) return null;
  return {
    cx: map.basket.x,
    cy: map.basket.y,
    rx: Number(rx.toFixed(2)),
    ry: Number(ry.toFixed(2)),
  };
}

export function latLngFromMapPoint(map, x, y) {
  if (!map || !map.bounds) return null;
  const spanLng = Math.max(map.bounds.maxLng - map.bounds.minLng, 1e-7);
  const spanLat = Math.max(map.bounds.maxLat - map.bounds.minLat, 1e-7);
  const width = map.width || 1;
  const height = map.height || 1;
  const lng = map.bounds.minLng + (Number(x) / width) * spanLng;
  const lat = map.bounds.maxLat - (Number(y) / height) * spanLat;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function projectHoleMap(hole, options = {}) {
  const tee = holePoint(hole && hole.tee);
  const basket = holePoint(hole && hole.target);
  if (!tee || !basket) return null;
  if (Math.abs(tee.lat - basket.lat) < 1e-8 && Math.abs(tee.lng - basket.lng) < 1e-8) return null;

  const width = finite(options.width) || 640;
  const height = finite(options.height) || 360;
  const focus = options.focus === "c1" || options.focus === "c2" ? options.focus : "hole";
  const bounds = boundsForFocus(tee, basket, focus);

  const teePt = { ...mapXy(bounds, width, height, tee.lng, tee.lat), lat: tee.lat, lng: tee.lng, label: tee.label || "Tee" };
  const basketPt = { ...mapXy(bounds, width, height, basket.lng, basket.lat), lat: basket.lat, lng: basket.lng, label: basket.label || "Basket" };
  const distanceFt = finite(hole && hole.distance_ft) || haversineFt(tee, basket);
  const windFrom = finite(options.windFromDeg);
  return {
    width,
    height,
    bounds,
    focus,
    satelliteUrl: satelliteImageUrl(bounds, width, height),
    tee: teePt,
    basket: basketPt,
    headingDeg: headingDeg(tee, basket),
    teeRotationDeg: teePadRotationDeg(teePt, basketPt),
    distanceFt,
    windBlowToDeg: windBlowToDeg(windFrom),
    windFromDeg: windFrom,
    circle1: circleEllipse({ bounds, width, height, basket: basketPt }, CIRCLE1_M),
    circle2: circleEllipse({ bounds, width, height, basket: basketPt }, CIRCLE2_M),
  };
}


export function holeMapLabel(map, holeNumber) {
  if (!map) return "";
  const hole = holeNumber ? `Hole ${holeNumber} map` : "Hole map";
  const distance = map.distanceFt ? `, ${map.distanceFt} ft` : "";
  const wind = map.windFromDeg == null ? "" : `, wind from ${Math.round(map.windFromDeg)} degrees`;
  return `${hole}${distance}${wind}`;
}

export function projectMapPoint(map, lat, lng) {
  if (!map || !map.bounds) return null;
  const pointLat = finite(lat);
  const pointLng = finite(lng);
  if (pointLat == null || pointLng == null) return null;
  const pad = 0.00012;
  if (pointLat < map.bounds.minLat - pad || pointLat > map.bounds.maxLat + pad) return null;
  if (pointLng < map.bounds.minLng - pad || pointLng > map.bounds.maxLng + pad) return null;
  return mapXy(map.bounds, map.width, map.height, pointLng, pointLat);
}


export function playerMarksOnMap(map, players) {
  const rows = Array.isArray(players) ? players : [];
  const marks = [];
  rows.forEach((player) => {
    const pt = projectMapPoint(map, player && player.lat, player && player.lng);
    if (!pt) return;
    const initials = String((player && player.initials) || "").trim().slice(0, 3).toUpperCase();
    if (!initials) return;
    marks.push({
      key: player.index != null ? String(player.index) : `${initials}:${pt.x}:${pt.y}`,
      initials,
      x: pt.x,
      y: pt.y,
      strokes: player.strokes,
      label: player.label,
      relClass: player.relClass,
    });
  });
  marks.sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 1; i < marks.length; i += 1) {
    const prev = marks[i - 1];
    const dx = marks[i].x - prev.x;
    const dy = marks[i].y - prev.y;
    if (dx * dx + dy * dy < 256) {
      marks[i] = { ...marks[i], x: marks[i].x + 14, y: marks[i].y - 10 };
    }
  }
  return marks;
}

export function scoreChipAnchor(mark, width, height) {
  const spanX = width > 0 ? width : 1;
  const spanY = height > 0 ? height : 1;
  return {
    x: (mark && mark.x) / spanX > 0.72 ? "left" : "right",
    y: (mark && mark.y) / spanY < 0.18 ? "below" : "above",
  };
}
