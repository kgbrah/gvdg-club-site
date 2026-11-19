// Warm the satellite tiles of the holes around the one in view (and, data allowing, the whole round) so the next map is
// already on the phone. The tiles are the ones the map shows (hole-map-model satelliteTileLayers: the zoom depends on
// the place, not the screen), and the service worker keeps them, so a hole is fetched once.
import {
  HOLE_MAP_SIZE,
  projectHoleMap,
  satelliteTileLayers,
} from "./hole-map-model.js";

const warmed = new Set();

export function satelliteUrlForHole(hole, options = {}) {
  const map = projectHoleMap(hole, {
    focus: options.focus,
    fitViewport: options.fitViewport,
    height: options.height,
    width: options.width,
  });
  return map && map.satelliteUrl ? map.satelliteUrl : "";
}

/** The tile URLs a hole's map shows at this size and focus. */
export function satelliteTileUrlsForHole(hole, options = {}) {
  const map = projectHoleMap(hole, {
    focus: options.focus,
    fitViewport: options.fitViewport,
    height: options.height,
    width: options.width,
  });
  return map ? satelliteTileLayers(map.bounds, map.width, map.height).map((tile) => tile.url) : [];
}

/** Tiles for the hole before, the one in view and `ahead` after (plus its C1 / C2 zooms), or every hole with `all`. */
export function satelliteUrlsForRound(holes, options = {}) {
  const rows = Array.isArray(holes) ? holes : [];
  const active = Math.max(0, Math.min(rows.length - 1, Number(options.activeIndex) || 0));
  const ahead = options.ahead == null ? 2 : Math.max(0, Number(options.ahead) || 0);
  const size = options.size || HOLE_MAP_SIZE;
  const start = options.all ? 0 : Math.max(0, active - 1);
  const end = options.all ? rows.length - 1 : Math.min(rows.length - 1, active + ahead);
  const urls = [];
  const seen = new Set();
  function add(hole, focus) {
    for (const url of satelliteTileUrlsForHole(hole, { ...size, focus, fitViewport: options.fitViewport })) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  for (let i = start; i <= end; i += 1) {
    add(rows[i], "hole");
    if (options.zooms && i === active) {
      add(rows[i], "c1");
      add(rows[i], "c2");
    }
  }
  return urls;
}

export function preloadSatelliteUrls(urls, loader) {
  const load = typeof loader === "function" ? loader : defaultImageLoader;
  const list = [];
  (Array.isArray(urls) ? urls : []).forEach((url) => {
    const href = String(url || "");
    if (!href || warmed.has(href)) return;
    warmed.add(href);
    list.push(href);
    load(href);
  });
  return list;
}

/** Data Saver on: only the holes around the one in view, never the whole round. */
function savingData() {
  try { return globalThis.navigator?.connection?.saveData === true; } catch { return false; }
}

export function preloadRoundMaps(holes, options = {}) {
  const now = satelliteUrlsForRound(holes, { ...options, all: false });
  const rest = options.all && !(options.saveData ?? savingData())
    ? satelliteUrlsForRound(holes, { ...options, all: true }).filter((url) => !now.includes(url))
    : [];
  preloadSatelliteUrls(now, options.loader);
  scheduleIdle(() => preloadSatelliteUrls(rest, options.loader), options.scheduleIdle);
  return { now, later: rest };
}

function defaultImageLoader(url) {
  if (typeof Image !== "function") return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  } catch {
    // Ignore environments that cannot fetch images.
  }
}

function scheduleIdle(fn, custom) {
  if (typeof custom === "function") {
    custom(fn);
    return;
  }
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => fn(), { timeout: 2500 });
    return;
  }
  if (typeof setTimeout === "function") setTimeout(fn, 400);
}
