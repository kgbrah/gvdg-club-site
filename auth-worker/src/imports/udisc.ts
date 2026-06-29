export interface CourseCandidate {
  name: string | null;
  udisc_url: string;
  holes: { hole: number; par: number }[] | null;
  note: string;
}

export interface UdiscPosition {
  kind: "tee" | "target";
  label: string;
  lat: number | null;
  lng: number | null;
}

export interface UdiscHole {
  hole: number;
  par: number;
  tee: { label: string; lat: number | null; lng: number | null } | null;
  target: { label: string; lat: number | null; lng: number | null } | null;
}

export interface UdiscLayout {
  name: string | null;
  udisc_url: string;
  holes: UdiscHole[];
  positions: UdiscPosition[];
  note: string;
}

export function parseUdiscCourse(html: string, url: string): CourseCandidate {
  const name = titleFromHtml(html) || null;
  return {
    name,
    udisc_url: url,
    holes: null,
    note: "Imported from UDisc (best-effort): name only. Enter the hole pars manually to enable scoring.",
  };
}

function titleFromHtml(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = html.match(/<title>([^<]+)<\/title>/i);
  let name = (og?.[1] ?? title?.[1] ?? "").trim();
  name = name.replace(/&middot;/gi, "·").replace(/&amp;/gi, "&");
  return name.replace(/\s*[·|\-–]\s*UDisc.*$/i, "").trim();
}

function asCoord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function coordOf(obj: unknown): { lat: number | null; lng: number | null } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const lat = asCoord(o.latitude) ?? asCoord(o.lat);
  const lng = asCoord(o.longitude) ?? asCoord(o.lng) ?? asCoord(o.lon);
  if (lat == null && lng == null) return null;
  return { lat, lng };
}

function firstCoord(...cands: unknown[]): { lat: number | null; lng: number | null } | null {
  for (const c of cands) {
    if (Array.isArray(c) && c.length) {
      const r = coordOf(c[0]);
      if (r) return r;
    }
    const r = coordOf(c);
    if (r) return r;
  }
  return null;
}

function findHoleArray(node: unknown, best: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    const looksLikeHoles = node.length > 0 && node.every((x) => x && typeof x === "object" && typeof (x as Record<string, unknown>).par === "number");
    if (looksLikeHoles && node.length > best.length) best = node as Record<string, unknown>[];
    for (const item of node) best = findHoleArray(item, best);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) best = findHoleArray(v, best);
  }
  return best;
}

function findCourseName(node: unknown): string | null {
  const seen: unknown[] = [node];
  while (seen.length) {
    const n = seen.shift();
    if (n && typeof n === "object" && !Array.isArray(n)) {
      const o = n as Record<string, unknown>;
      if (typeof o.name === "string" && Array.isArray(o.holes)) return o.name;
      for (const v of Object.values(o)) {
        if (v && typeof v === "object") seen.push(v);
      }
    }
  }
  return null;
}

// --- Embedded-JSON extraction across UDisc's rendering strategies ---
// UDisc has moved from a Pages-Router `__NEXT_DATA__` blob to an App-Router build that streams its
// data through `self.__next_f.push([n,"<escaped json>"])` chunks. To be resilient to both (and to
// plain inline JSON), we gather hole arrays from three sources and keep the richest one.

// Typed <script type="application/json"> / ld+json blocks (Pages Router __NEXT_DATA__, JSON-LD).
function scriptJsonBlocks(html: string): string[] {
  return [...html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
}

// Concatenate the unescaped string payloads of every `self.__next_f.push([n,"..."])` chunk back into
// the original RSC flight text, which contains the course/holes JSON as ordinary substrings.
function nextFlightText(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g)) {
    try {
      out += JSON.parse(m[1]!) as string; // m[1] is a JSON string literal — parse unescapes it
    } catch {
      /* skip malformed chunk */
    }
  }
  return out;
}

// Return the substring spanning the balanced [..] or {..} that starts at openIdx, respecting strings
// and escapes. null if it never closes. Lets us pull a JSON array out of arbitrary surrounding text.
function extractBalanced(text: string, openIdx: number): string | null {
  const open = text[openIdx];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return null;
}

function isHoleish(x: unknown): x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  return typeof o.par === "number" || typeof o.holeNumber === "number" || typeof o.number === "number";
}

// Pull every plausible `"holes":[ ... ]` array out of a text blob (raw HTML or flight text). Accepts
// an array only if it is mostly hole-shaped objects, so we don't grab an unrelated array named holes.
function holeArraysFromText(text: string): Record<string, unknown>[][] {
  const found: Record<string, unknown>[][] = [];
  for (const m of text.matchAll(/"holes"\s*:\s*\[/g)) {
    const bracket = text.indexOf("[", m.index! + m[0].length - 1);
    if (bracket < 0) continue;
    const arrStr = extractBalanced(text, bracket);
    if (!arrStr) continue;
    try {
      const arr = JSON.parse(arrStr) as unknown[];
      if (Array.isArray(arr) && arr.length > 0 && arr.length <= 40 && arr.filter(isHoleish).length >= Math.ceil(arr.length / 2)) {
        found.push(arr as Record<string, unknown>[]);
      }
    } catch {
      /* not valid JSON at this position — skip */
    }
  }
  return found;
}

export function parseUdiscLayout(html: string, url: string): UdiscLayout {
  const name = titleFromHtml(html) || null;
  const empty: UdiscLayout = {
    name,
    udisc_url: url,
    holes: [],
    positions: [],
    note: "Imported from UDisc (best-effort): name only — enter hole pars manually to enable scoring.",
  };

  const candidates: Record<string, unknown>[][] = [];
  let jsonName: string | null = null;

  // 1) Typed JSON script blocks: parse fully and search for the largest par-bearing array anywhere.
  for (const raw of scriptJsonBlocks(html)) {
    try {
      const data = JSON.parse(raw.trim());
      const found = findHoleArray(data);
      if (found.length) {
        candidates.push(found);
        if (!jsonName) jsonName = findCourseName(data);
      }
    } catch {
      continue;
    }
  }

  // 2) App Router RSC flight payload, and 3) any other inline "holes":[...] in the raw HTML.
  for (const arr of holeArraysFromText(nextFlightText(html))) candidates.push(arr);
  for (const arr of holeArraysFromText(html)) candidates.push(arr);

  if (!candidates.length) return empty;
  // Keep the richest array (most holes) found across every strategy.
  const holeObjs = candidates.reduce((best, arr) => (arr.length > best.length ? arr : best));

  const positions: UdiscPosition[] = [];
  const holes: UdiscHole[] = holeObjs.map((h, i) => {
    const num = typeof h.holeNumber === "number" ? h.holeNumber : typeof h.number === "number" ? h.number : i + 1;
    const par = typeof h.par === "number" ? h.par : 3;
    const teeC = firstCoord(h.teePositions, h.tees, h.teePads, h.teePosition, h.tee);
    const tgtC = firstCoord(h.targetPositions, h.baskets, h.targetPosition, h.basket, h.pin);
    const tee = teeC ? { label: `Hole ${num} tee`, lat: teeC.lat, lng: teeC.lng } : null;
    const target = tgtC ? { label: `Hole ${num} basket`, lat: tgtC.lat, lng: tgtC.lng } : null;
    if (tee) positions.push({ kind: "tee", ...tee });
    if (target) positions.push({ kind: "target", ...target });
    return { hole: num, par, tee, target };
  });

  return {
    name: jsonName ?? name,
    udisc_url: url,
    holes,
    positions,
    note: `Imported ${holes.length} holes from UDisc (best-effort). Review pars and distances before scoring.`,
  };
}
