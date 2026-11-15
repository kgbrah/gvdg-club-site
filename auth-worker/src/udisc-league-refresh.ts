import type { Env } from "./env.js";
import { loadUdiscLeague } from "./club-admin-imports.js";
import { normalizeUdiscEventsUrl } from "./imports.js";
import { saveUdiscLeague } from "./udisc-league-save.js";

// Sunday 19:00 UTC is 3pm EDT. Sunday 20:00 UTC is 3pm EST. The handler keeps the one that is 3pm Eastern.
export const UDISC_LEAGUE_REFRESH_CRONS = ["0 19 * * 0", "0 20 * * 0"] as const;

const LEAGUE_URL = /https:\/\/(?:www\.)?udisc\.com\/leagues\/[A-Za-z0-9-]+/i;

export function isUdiscLeagueRefreshCron(cron: string): boolean {
  return (UDISC_LEAGUE_REFRESH_CRONS as readonly string[]).includes(cron.trim());
}

export function udiscLeagueUrl(text: string | null | undefined): string | null {
  const match = String(text || "").match(LEAGUE_URL);
  if (!match) return null;
  return match[0].replace(/^https:\/\/www\./i, "https://");
}

export function isEasternSundayAtThree(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  return weekday === "Sun" && hour === "15";
}

export async function refreshImportedUdiscLeagues(env: Env, now = new Date()): Promise<{
  skipped?: string;
  leagues: number;
  updated: { name: string; events: number; results: number }[];
  failed: { name: string; error: string }[];
}> {
  if (!isEasternSundayAtThree(now)) return { skipped: "not_due", leagues: 0, updated: [], failed: [] };
  const rows = (await env.DB.prepare(
    "SELECT id, name, description FROM leagues WHERE description LIKE '%udisc.com/leagues/%' ORDER BY id",
  ).all<{ id: number; name: string; description: string | null }>()).results || [];
  const updated: { name: string; events: number; results: number }[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const row of rows.slice(0, 8)) {
    const url = udiscLeagueUrl(row.description);
    const target = url ? normalizeUdiscEventsUrl(url) : null;
    if (!target) continue;
    try {
      const loaded = await loadUdiscLeague(target);
      const saved = await saveUdiscLeague(env, "udisc-refresh", loaded);
      updated.push({ name: row.name, events: saved.events, results: saved.results });
    } catch (error) {
      failed.push({ name: row.name, error: error instanceof Error ? error.message : "refresh_failed" });
    }
  }
  return { leagues: rows.length, updated, failed };
}
