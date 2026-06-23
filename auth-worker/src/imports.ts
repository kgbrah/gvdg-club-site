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
