// Ranking for the shared autocomplete (owner: "auto complete for all searches, especially player names, across all
// surfaces"). Pure, so it's node-tested: tests/autocomplete.test.mjs.

/** Lowercase, accents off, punctuation to spaces: "José O'Neil" and "jose oneil" compare equal-ish. */
export function normalizeForMatch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();
}

/** A suggestion as { label, value, hint, key } (plain strings are accepted too). */
export function suggestionItem(raw) {
  if (raw == null) return null;
  if (typeof raw === "string" || typeof raw === "number") {
    const label = String(raw).trim();
    return label ? { label, value: label, hint: "", key: label } : null;
  }
  const label = String(raw.label ?? raw.name ?? "").trim();
  if (!label) return null;
  const value = String(raw.value ?? label);
  return { ...raw, label, value, hint: raw.hint ? String(raw.hint) : "", key: String(raw.key ?? (label + "|" + (raw.hint ?? ""))) };
}

/**
 * How well a suggestion matches what was typed: 0 the label starts with it, 1 a word in the label does, 2 the label
 * contains it, 3 a word of the hint starts with it (a PDGA number, a town), 4 the hint contains it; null no match.
 * Every typed word must match (so "jo sm" finds "John Smith").
 */
export function matchScore(query, item) {
  const typed = normalizeForMatch(query);
  if (!typed) return null;
  const label = normalizeForMatch(item.label);
  const hint = normalizeForMatch(item.hint);
  if (label.startsWith(typed)) return 0;
  const words = typed.split(" ");
  const labelWords = label.split(" ");
  if (words.every((word) => labelWords.some((part) => part.startsWith(word)))) return 1;
  if (label.includes(typed)) return 2;
  const hintWords = hint.split(" ");
  if (hint && words.every((word) => hintWords.some((part) => part.startsWith(word)) || labelWords.some((part) => part.startsWith(word)))) return 3;
  if (hint && hint.includes(typed)) return 4;
  return null;
}

/** The best `max` suggestions for what was typed, best first; nothing once the typed text is exactly a suggestion. */
export function rankSuggestions(query, items, max = 6) {
  const typed = normalizeForMatch(query);
  if (!typed) return [];
  const seen = new Set();
  const ranked = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const item = suggestionItem(raw);
    if (!item) continue;
    const dedupe = normalizeForMatch(item.label) + "|" + normalizeForMatch(item.hint);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const score = matchScore(typed, item);
    if (score != null) ranked.push({ item, score });
  }
  ranked.sort((a, b) => a.score - b.score || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label));
  const best = ranked.slice(0, max).map(({ item }) => item);
  // Typed in full already: nothing left to complete.
  if (best.length === 1 && normalizeForMatch(best[0].value) === typed) return [];
  return best;
}

/** The parts of a label to show bold: [{ text, match }], for the first place the typed text (or a typed word) occurs. */
export function highlightParts(label, query) {
  const text = String(label ?? "");
  const typed = String(query ?? "").trim().toLowerCase();
  if (!typed) return [{ text, match: false }];
  const lower = text.toLowerCase();
  let at = lower.indexOf(typed);
  let length = typed.length;
  if (at < 0) {
    const first = typed.split(/\s+/)[0];
    at = first ? lower.indexOf(first) : -1;
    length = first.length;
  }
  if (at < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, at), match: false },
    { text: text.slice(at, at + length), match: true },
    { text: text.slice(at + length), match: false },
  ].filter((part) => part.text);
}
