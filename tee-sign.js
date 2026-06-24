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
