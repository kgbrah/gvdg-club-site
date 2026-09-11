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

function haversineFt(a, b) {
  const radiusMeters = 6371000;
  const rad = (degrees) => degrees * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h))) * 3.28084);
}

export function headingDeg(from, to) {
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

export function windBlowToDeg(windFromDeg) {
  const from = finite(windFromDeg);
  return from == null ? null : (from + 180) % 360;
}

export function projectHoleMap(hole, options = {}) {
  const tee = holePoint(hole && hole.tee);
  const basket = holePoint(hole && hole.target);
  if (!tee || !basket) return null;
  if (Math.abs(tee.lat - basket.lat) < 1e-8 && Math.abs(tee.lng - basket.lng) < 1e-8) return null;

  const width = finite(options.width) || 320;
  const height = finite(options.height) || 168;
  const pad = finite(options.pad) || 28;
  const midLat = (tee.lat + basket.lat) / 2;
  const lngScale = Math.cos(midLat * Math.PI / 180) || 1;
  const points = [
    { key: "tee", x: tee.lng * lngScale, y: tee.lat, source: tee },
    { key: "basket", x: basket.lng * lngScale, y: basket.lat, source: basket },
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-7);
  const spanY = Math.max(maxY - minY, 1e-7);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const scale = Math.min(innerW / spanX, innerH / spanY);

  function xy(x, y) {
    return {
      x: Number((pad + (x - minX) * scale + (innerW - spanX * scale) / 2).toFixed(2)),
      y: Number((height - (pad + (y - minY) * scale + (innerH - spanY * scale) / 2)).toFixed(2)),
    };
  }

  const teePt = { ...xy(points[0].x, points[0].y), label: tee.label || "Tee" };
  const basketPt = { ...xy(points[1].x, points[1].y), label: basket.label || "Basket" };
  const distanceFt = finite(hole && hole.distance_ft) || haversineFt(tee, basket);
  const windFrom = finite(options.windFromDeg);
  return {
    width,
    height,
    tee: teePt,
    basket: basketPt,
    headingDeg: headingDeg(tee, basket),
    distanceFt,
    windBlowToDeg: windBlowToDeg(windFrom),
    windFromDeg: windFrom,
  };
}

export function holeMapLabel(map, holeNumber) {
  if (!map) return "";
  const hole = holeNumber ? `Hole ${holeNumber} map` : "Hole map";
  const distance = map.distanceFt ? `, ${map.distanceFt} ft` : "";
  const wind = map.windFromDeg == null ? "" : `, wind from ${Math.round(map.windFromDeg)} degrees`;
  return `${hole}${distance}${wind}`;
}
