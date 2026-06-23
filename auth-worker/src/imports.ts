// Event/course import sources (admin-only). All outbound fetches are SSRF-guarded:
// https-only, host-allowlisted, no redirects (a 3xx could bounce to an internal host),
// no userinfo/IP-literal hosts, with response size + time caps.

export class ImportError extends Error {}

/** True only for an https URL whose host is (a subdomain of) an allow-listed base domain. */
export function isAllowedUrl(raw: string, bases: string[]): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // reject https://allowed.com@evil.com tricks
  const host = u.hostname.toLowerCase();
  if (host.includes(":")) return false; // bracketed IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal (e.g. 169.254.169.254)
  return bases.some((b) => host === b || host.endsWith("." + b));
}

export async function safeFetch(
  url: string,
  allowHosts: string[],
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { maxBytes = 1_000_000, timeoutMs = 8000 } = opts;
  if (!isAllowedUrl(url, allowHosts)) throw new ImportError("url_not_allowed");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "manual", // never follow redirects — they can escape the allowlist
      headers: { "User-Agent": "GVDG-club-bot" },
    });
    if (res.status >= 300 && res.status < 400) throw new ImportError("redirect_blocked");
    if (!res.ok) throw new ImportError(`fetch_failed_${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new ImportError("response_too_large");
    return text;
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError("fetch_error");
  } finally {
    clearTimeout(timer);
  }
}

// --- CSV ---
function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse CSV text into row objects keyed by the header row. */
export function parseCsvRows(text: string): Record<string, string>[] {
  const rows = parseCsvLines(text);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
      return o;
    });
}

export interface EventCandidate {
  type: string;
  source: string;
  name: string;
  date: string | null;
  format: string | null;
  external_url: string | null;
  venue?: string | null;
  city?: string | null;
  tier?: string | null;
}

const EVENT_TYPES = new Set(["tournament", "league_round", "fundraiser", "meeting"]);

/** Map the scraper's tournaments.json (object with .tournaments, or a bare array) into candidates. */
export function normalizeDgs(feed: unknown): EventCandidate[] {
  const arr: unknown[] = Array.isArray(feed)
    ? feed
    : feed && typeof feed === "object" && Array.isArray((feed as Record<string, unknown>).tournaments)
      ? ((feed as Record<string, unknown>).tournaments as unknown[])
      : [];
  return arr
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string" && String((t as Record<string, unknown>).name).trim() !== "")
    .map((t) => ({
      type: "tournament",
      source: "dgs",
      name: String(t.name).trim(),
      date: t.date ? String(t.date) : null,
      format: null,
      external_url: typeof t.url === "string" ? t.url : null,
      venue: t.venue != null ? String(t.venue) : null,
      city: t.city != null ? String(t.city) : null,
      tier: t.tier != null ? String(t.tier) : null,
    }));
}

/** Map CSV rows (name,date,type,format,…) into event candidates. */
export function normalizeCsvEvents(rows: Record<string, string>[]): EventCandidate[] {
  return rows
    .filter((r) => (r.name ?? "").trim() !== "")
    .map((r) => {
      const t = (r.type ?? "").trim();
      return {
        type: EVENT_TYPES.has(t) ? t : "tournament",
        source: "csv",
        name: (r.name ?? "").trim(),
        date: (r.date ?? "").trim() || null,
        format: (r.format ?? "").trim() || null,
        external_url: (r.url ?? "").trim() || null,
      };
    });
}

export interface CourseCandidate {
  name: string | null;
  udisc_url: string;
  holes: { hole: number; par: number }[] | null;
  note: string;
}

/** Best-effort parse of a UDisc course page. UDisc has no public API and is JS-heavy,
 *  so we extract the name from the page title and flag that pars need manual entry. */
export function parseUdiscCourse(html: string, url: string): CourseCandidate {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = html.match(/<title>([^<]+)<\/title>/i);
  let name = (og?.[1] ?? title?.[1] ?? "").trim();
  name = name.replace(/\s*[·|\-–]\s*UDisc.*$/i, "").trim(); // drop "· UDisc" suffix
  return {
    name: name || null,
    udisc_url: url,
    holes: null,
    note: "Imported from UDisc (best-effort): name only. Enter the hole pars manually to enable scoring.",
  };
}

// ---- best-effort UDisc layout (pars + tee/target coords) ----
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
// Pull a {lat,lng} from any of UDisc's plausible coordinate shapes.
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
    if (Array.isArray(c) && c.length) { const r = coordOf(c[0]); if (r) return r; }
    const r = coordOf(c);
    if (r) return r;
  }
  return null;
}

// Recursively find the longest array of objects that look like holes (numeric `par`).
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
  // shallow BFS for a `course.name` or a top-level `name` alongside `holes`
  const seen: unknown[] = [node];
  while (seen.length) {
    const n = seen.shift();
    if (n && typeof n === "object" && !Array.isArray(n)) {
      const o = n as Record<string, unknown>;
      if (typeof o.name === "string" && Array.isArray(o.holes)) return o.name;
      for (const v of Object.values(o)) if (v && typeof v === "object") seen.push(v);
    }
  }
  return null;
}

/** Best-effort parse of a UDisc course page into a layout: name, per-hole pars, and tee/target
 *  coordinates plus a position pool for the SAFARI editor. Degrades to "name only" when the page
 *  carries no parseable course JSON (UDisc has no public API and its markup may change). */
export function parseUdiscLayout(html: string, url: string): UdiscLayout {
  const name = titleFromHtml(html) || null;
  const empty: UdiscLayout = {
    name, udisc_url: url, holes: [], positions: [],
    note: "Imported from UDisc (best-effort): name only — enter hole pars manually to enable scoring.",
  };

  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
  let holeObjs: Record<string, unknown>[] = [];
  let jsonName: string | null = null;
  for (const raw of scripts) {
    try {
      const data = JSON.parse(raw.trim());
      const found = findHoleArray(data);
      if (found.length > holeObjs.length) { holeObjs = found; jsonName = findCourseName(data); }
    } catch { /* not valid JSON — skip */ }
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
