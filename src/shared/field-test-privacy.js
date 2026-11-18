// Privacy filter for the field test log. The log may hold this member's own id, round codes, hole numbers,
// scores and timings. It must never hold another player's name or a PDGA number, so every event passes
// through sanitizeFieldEvent() before it is stored, and again when it is exported.

// Keys that carry names, rosters or identity numbers. They are dropped at any depth, whatever the value.
export const FIELD_FORBIDDEN_KEYS = Object.freeze([
  "name", "names", "playerName", "playerNames", "label", "labels", "member", "members", "displayName",
  "cardmates", "players", "standings", "scorecards", "pdga", "pdgaNo", "pdgaNumber", "pdga_number",
  "email", "phone", "token", "pin",
]);
const FORBIDDEN = new Set(FIELD_FORBIDDEN_KEYS.map((key) => key.toLowerCase()));
// Free text typed by a volunteer or produced by the browser. Bare 5-7 digit numbers are removed here too.
const FREE_TEXT_KEYS = new Set(["text", "message", "detail", "reason"]);
const MAX_STRING = 500;
const MAX_DEPTH = 6;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameTerms(names) {
  const terms = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    if (typeof raw !== "string") continue;
    const full = raw.trim().replace(/\s+/g, " ");
    if (full.length < 2) continue;
    terms.add(full);
    // "Jordan Reyes" is also scrubbed as "Jordan" and "Reyes"; very short words are left alone.
    for (const word of full.split(" ")) if (word.length >= 3) terms.add(word);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

// Compiled name patterns for the most recent roster; a recorder asks for the same list many times.
let cached = { key: null, pattern: null };
function namePattern(names) {
  const key = Array.isArray(names) ? names.join("\u0001") : "";
  if (cached.key === key) return cached.pattern;
  const terms = nameTerms(names);
  const pattern = terms.length
    ? new RegExp("(^|[^\\p{L}\\p{N}])(?:" + terms.map(escapeRegExp).join("|") + ")(?=$|[^\\p{L}\\p{N}])", "giu")
    : null;
  cached = { key, pattern };
  return pattern;
}

/** Remove names and PDGA numbers from free text. */
export function scrubFieldText(text, names = [], { freeText = true } = {}) {
  let out = String(text ?? "");
  const pattern = namePattern(names);
  if (pattern) out = out.replace(pattern, "$1[player]");
  out = out.replace(/\bpdga\s*(?:#|no\.?|number)?\s*:?\s*\d{1,7}\b/gi, "PDGA [number]");
  if (freeText) {
    out = out.replace(/#\s?\d{3,7}\b/g, "#[number]").replace(/\b\d{5,7}\b/g, "[number]");
  }
  return out.length > MAX_STRING ? out.slice(0, MAX_STRING) + "…" : out;
}

function clean(value, names, key, depth) {
  if (value == null) return value;
  if (typeof value === "string") return scrubFieldText(value, names, { freeText: FREE_TEXT_KEYS.has(key) });
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => clean(item, names, key, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (FORBIDDEN.has(childKey.toLowerCase())) continue;
      const next = clean(child, names, childKey, depth + 1);
      if (next !== undefined) out[childKey] = next;
    }
    return out;
  }
  return undefined;
}

/** A copy of one log event with forbidden keys dropped and free text scrubbed. */
export function sanitizeFieldEvent(event, { names = [] } = {}) {
  const out = clean(event, names, "", 0);
  return out && typeof out === "object" && !Array.isArray(out) ? out : {};
}
