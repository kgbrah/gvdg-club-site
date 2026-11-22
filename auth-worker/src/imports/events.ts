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
