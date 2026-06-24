// tee-sign.js — pure, DOM-free renderer for a disc-golf "tee sign" graphic.
// No DOM, no network: returns an SVG *string* with every dynamic value XML-escaped
// and every color sanitized, so it is safe to inject and runnable under node --test.
// Mirrors events.js: pure helpers here; the host page handles insertion + theming.
//
// Public API: escapeXml, sanitizeColor, teeSignModel, teeSignSvg.

// Disc-golf tee/target colors allowed as-is (lowercased). Anything outside this set
// OR a #RGB / #RRGGBB hex is dropped (no swatch) — prevents CSS/markup injection.
const NAMED_COLORS = new Set([
  'blue', 'white', 'red', 'gold', 'yellow', 'green', 'black', 'silver', 'gray',
  'grey', 'orange', 'purple', 'pink', 'brown', 'teal', 'navy',
]);

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Return a safe CSS color (a known name or #hex) or null. Never returns
// attacker-controlled text — the SVG only ever receives a vetted value.
export function sanitizeColor(raw) {
  if (raw == null) return null;
  const c = String(raw).trim().toLowerCase();
  if (NAMED_COLORS.has(c)) return c;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) return c;
  return null;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// Normalize raw inputs into a vetted model: ints clamped, colors sanitized,
// strings coerced. This is the pure logic the unit tests pin down.
export function teeSignModel(input) {
  const src = input && typeof input === 'object' ? input : {};
  const layoutsIn = Array.isArray(src.layouts) ? src.layouts : [];
  const layouts = layoutsIn.map((l) => {
    const row = l && typeof l === 'object' ? l : {};
    return {
      label: row.label != null ? String(row.label) : '',
      color: sanitizeColor(row.color),
      par: clampInt(row.par, 1, 10),
      distance_ft: clampInt(row.distance_ft, 20, 2000),
      distance_source: row.distance_source != null ? String(row.distance_source) : null,
    };
  });
  return {
    hole: clampInt(src.hole, 1, 99),
    courseName: src.courseName != null ? String(src.courseName) : '',
    layouts,
  };
}
