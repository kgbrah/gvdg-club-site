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

export function parseUdiscLayout(html: string, url: string): UdiscLayout {
  const name = titleFromHtml(html) || null;
  const empty: UdiscLayout = {
    name,
    udisc_url: url,
    holes: [],
    positions: [],
    note: "Imported from UDisc (best-effort): name only — enter hole pars manually to enable scoring.",
  };

  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
  let holeObjs: Record<string, unknown>[] = [];
  let jsonName: string | null = null;
  for (const raw of scripts) {
    try {
      const data = JSON.parse(raw.trim());
      const found = findHoleArray(data);
      if (found.length > holeObjs.length) {
        holeObjs = found;
        jsonName = findCourseName(data);
      }
    } catch {
      continue;
    }
  }
  if (!holeObjs.length) return empty;

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
