// Lost & Found matching: score a found disc against a possible owner. PURE (unit-tested); the DB side lives
// in lf-process.ts. Signals, strongest first:
//   - identity: a phone number or name written on the found disc vs the lost post's PRIVATE "what's written
//     on it", or vs the lost poster's member name (normalised digits / name tokens);
//   - the disc: brand, mold (exact or one typo), plastic, colour family;
//   - where: the same course, or a nearby one;
//   - when: found on or after the day it was lost, the sooner the better.
// Reasons are codes the UI turns into words; they never carry the private text itself.

import { inkKeys, normalizeColor, normalizeName, phoneDigits, type InkKeys } from "./lf-vision.js";

export const STORE_THRESHOLD = 30;
export const STRONG_THRESHOLD = 55;

export interface Where { courseId: number | null; lat: number | null; lng: number | null }

export interface FoundSide extends Where {
  brand: string;
  mold: string;
  plastic: string;
  color: string;
  aiColors: string[];
  date: string | null;
  ink: InkKeys;
}

export interface LostSide extends Where {
  brand: string;
  mold: string;
  plastic: string;
  color: string;
  date: string | null;
  privateInk: string;
  /** The lost poster's roster name when they are a member; null for guests (a chosen display name proves nothing). */
  memberName: string | null;
}

export interface MatchScore {
  score: number;
  reasons: string[];
  /** A phone number or full name matched. */
  identity: boolean;
  strong: boolean;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = temp;
    }
  }
  return prev[b.length]!;
}

export function colorsOf(...values: Array<string | readonly string[]>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const words = Array.isArray(value) ? value : String(value || "").split(/[\s/,&+-]+/);
    for (const word of words) {
      const color = normalizeColor(String(word));
      if (color && !out.includes(color)) out.push(color);
    }
  }
  return out;
}

/** "full": every token of the shorter (2+ token) name is in the other; "surname": a 4+ letter last name. */
export function nameMatch(a: string, b: string): "full" | "surname" | null {
  const x = normalizeName(a).split(" ").filter(Boolean);
  const y = normalizeName(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return null;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 2 && short.every((token) => long.includes(token))) return "full";
  const lastX = x[x.length - 1]!;
  const lastY = y[y.length - 1]!;
  if (lastX.length >= 4 && lastX === lastY) return "surname";
  if (short.length === 1 && short[0]!.length >= 4 && long.includes(short[0]!)) return "surname";
  return null;
}

function initialsOf(name: string): string {
  const parts = normalizeName(name).split(" ").filter(Boolean);
  return parts.length >= 2 ? parts.map((part) => part[0]).join("") : "";
}

function samePhone(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 7 && b.length >= 7 && a.slice(-7) === b.slice(-7);
}

export function distanceKm(a: Where, b: Where): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function dayNumber(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(at) ? Math.round(at / 86_400_000) : null;
}

/** The lost side's private ink split into the same keys as found ink (names, phones, initials). */
export function privateKeys(privateInk: string): InkKeys {
  const lines = privateInk.split(/[\n,;]+/).map((line) => line.trim()).filter(Boolean);
  const keys = inkKeys(lines.map((line) => ({ text: line, type: /\d{5,}/.test(line.replace(/\D/g, "")) ? "phone" as const : "name" as const })));
  for (const phone of phoneDigits(privateInk)) if (!keys.phones.includes(phone)) keys.phones.push(phone);
  return keys;
}

export function scoreMatch(found: FoundSide, lost: LostSide): MatchScore {
  const reasons: string[] = [];
  let identity = 0;
  let strongIdentity = false;
  const lostKeys = privateKeys(lost.privateInk);

  if (found.ink.phones.some((phone) => lostKeys.phones.some((other) => samePhone(phone, other)))) {
    identity += 60; strongIdentity = true; reasons.push("ink_phone");
  }
  let bestInk: "full" | "surname" | null = null;
  for (const name of found.ink.names) {
    for (const other of lostKeys.names) {
      const hit = nameMatch(name, other);
      if (hit === "full" || (hit && !bestInk)) bestInk = hit;
    }
  }
  if (bestInk) { identity += bestInk === "full" ? 50 : 25; reasons.push("ink_name"); if (bestInk === "full") strongIdentity = true; }
  if (lost.memberName) {
    let best: "full" | "surname" | null = null;
    for (const name of found.ink.names) {
      const hit = nameMatch(name, lost.memberName);
      if (hit === "full" || (hit && !best)) best = hit;
    }
    if (best) { identity += best === "full" ? 45 : 20; reasons.push("member_name"); if (best === "full") strongIdentity = true; }
  }
  const targetInitials = [...lostKeys.initials, initialsOf(lost.memberName || "")].filter(Boolean);
  if (found.ink.initials.some((value) => targetInitials.includes(value))) { identity += 12; reasons.push("ink_initials"); }
  let score = Math.min(identity, 70);

  const fb = norm(found.brand), lb = norm(lost.brand);
  if (fb && lb) {
    if (fb === lb) { score += 8; reasons.push("brand"); } else score -= 6;
  }
  const fm = norm(found.mold), lm = norm(lost.mold);
  if (fm && lm) {
    if (fm === lm) { score += 14; reasons.push("mold"); }
    else if ((fm.length >= 4 && lm.length >= 4 && editDistance(fm, lm) <= 1) || (fm.length >= 4 && lm.includes(fm)) || (lm.length >= 4 && fm.includes(lm))) {
      score += 8; reasons.push("mold_close");
    } else { score -= 15; reasons.push("mold_mismatch"); }
  }
  const fp = norm(found.plastic), lp = norm(lost.plastic);
  if (fp && lp && (fp === lp || fp.includes(lp) || lp.includes(fp))) { score += 5; reasons.push("plastic"); }
  const fc = colorsOf(found.color, found.aiColors);
  const lc = colorsOf(lost.color);
  if (fc.length && lc.length) {
    if (fc.some((color) => lc.includes(color))) { score += 8; reasons.push("color"); } else { score -= 10; reasons.push("color_mismatch"); }
  }
  if (found.courseId != null && found.courseId === lost.courseId) { score += 12; reasons.push("course"); }
  else {
    const km = distanceKm(found, lost);
    if (km != null && km <= 25) { score += 5; reasons.push("nearby"); }
  }
  const fd = dayNumber(found.date), ld = dayNumber(lost.date);
  if (fd != null && ld != null) {
    const days = fd - ld;
    if (days < -1) { score -= 20; reasons.push("date_before"); }
    else if (days <= 14) { score += 8; reasons.push("date"); }
    else if (days <= 60) { score += 4; reasons.push("date"); }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, identity: strongIdentity, strong: strongIdentity || score >= STRONG_THRESHOLD };
}

/** The one roster member whose full name is written on the disc, or null when none or several match. */
export function rosterNameMatch(inkNames: readonly string[], members: readonly { memberId: string; name: string }[]): string | null {
  const hits = new Set<string>();
  for (const member of members) {
    if (normalizeName(member.name).split(" ").length < 2) continue;
    if (inkNames.some((name) => nameMatch(name, member.name) === "full" && normalizeName(name).split(" ").length >= 2)) hits.add(member.memberId);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

export const REASON_LABELS: Record<string, string> = {
  ink_phone: "The phone number on the disc matches",
  ink_name: "The name on the disc matches",
  member_name: "The name on the disc matches a club member",
  ink_initials: "The initials on the disc match",
  brand: "Same brand",
  mold: "Same mold",
  mold_close: "Similar mold name",
  plastic: "Same plastic",
  color: "Same colour",
  course: "Same course",
  nearby: "A nearby course",
  date: "Found soon after it was lost",
};

/** Public-safe reason words (negative signals are left out). */
export function reasonLabels(codes: readonly string[]): string[] {
  // One line for the name: "matches" already covers "matches a club member".
  const shown = codes.includes("ink_name") ? codes.filter((code) => code !== "member_name") : codes;
  return shown.map((code) => REASON_LABELS[code]).filter((label): label is string => Boolean(label));
}
