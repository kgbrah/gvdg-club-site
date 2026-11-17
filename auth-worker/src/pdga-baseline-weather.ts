// Historical wind for matched PDGA rounds, so each PDGA SSA can be normalised to no wind before it
// enters a layout baseline. Cron/admin only, a few requests per tick, with backoff.
//
// Measure: Open-Meteo `wind_gusts_10m` in mph, the same field and unit the club's live weather feeds
// the rating engine (weather.ts -> RatingWeather.windGustMph -> weatherSsaAdjustment). PDGA does not
// publish a round's tee time, so we take the maximum hourly gust from 09:00 to 17:00 America/New_York
// on the round's day at the matched course. The host is a fixed constant (like weather.ts and
// pdga.ts); safeFetch's allowlist is for user-supplied import URLs and does not apply.

import type { D1Like, D1StatementLike } from "./db-types.js";
import { queuePdgaLayoutRepairs } from "./pdga-baseline-store.js";

export const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
export const PLAY_HOURS = { first: 9, last: 17 } as const;
export const WEATHER_FETCHES_PER_TICK = 6;
const WEATHER_TIME_ZONE = "America/New_York";
const BACKOFF_HOURS = [1, 4, 12, 24, 72];
const MAX_ATTEMPTS = 6;
// The archive (reanalysis) lags real time by several days: no gusts yet means "try again later" for
// a recent round and "unavailable" for an older one.
const ARCHIVE_LAG_DAYS = 14;
const FETCH_TIMEOUT_MS = 8_000;
const UA = "GreenvilleDiscGolfClub/1.0 (https://gvdgclub.com)";

export function archiveGustUrl(lat: number, lng: number, day: string): string {
  const url = new URL(OPEN_METEO_ARCHIVE);
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lng.toFixed(4));
  url.searchParams.set("start_date", day);
  url.searchParams.set("end_date", day);
  url.searchParams.set("hourly", "wind_gusts_10m");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", WEATHER_TIME_ZONE);
  return url.toString();
}

/** Max hourly gust (mph, one decimal) between 09:00 and 17:00 local on `day`; null when none is reported. */
export function parseArchiveMaxGust(json: unknown, day: string): number | null {
  const hourly = json && typeof json === "object" ? (json as { hourly?: unknown }).hourly : null;
  const times = hourly && typeof hourly === "object" ? (hourly as { time?: unknown }).time : null;
  const gusts = hourly && typeof hourly === "object" ? (hourly as { wind_gusts_10m?: unknown }).wind_gusts_10m : null;
  if (!Array.isArray(times) || !Array.isArray(gusts)) return null;
  let max: number | null = null;
  times.forEach((time, index) => {
    const match = typeof time === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(time) : null;
    const hour = match ? Number(match[2]) : NaN;
    const gust = gusts[index];
    if (!match || match[1] !== day || hour < PLAY_HOURS.first || hour > PLAY_HOURS.last) return;
    if (typeof gust === "number" && Number.isFinite(gust) && gust >= 0 && gust < 200) max = Math.max(max ?? 0, gust);
  });
  return max == null ? null : Math.round(max * 10) / 10;
}

type Due = {
  tourn_id: number; round_number: number; pdga_layout_id: number; round_date: string; weather_attempts: number;
  course_id: number; layout_id: number; lat: number; lng: number;
};
export type WeatherTickSummary = { weatherFetches: number; weatherRounds: number; weatherUnavailable: number; errors: string[] };

function later(now: string, hours: number): string {
  return new Date(Date.parse(now) + hours * 3_600_000).toISOString();
}

async function fetchGust(doFetch: typeof fetch, url: string): Promise<{ ok: true; gust: number | null; day: string } | { ok: false; error: string }> {
  const day = new URL(url).searchParams.get("start_date") ?? "";
  try {
    const response = await doFetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, error: "http-" + response.status };
    return { ok: true, gust: parseArchiveMaxGust(await response.json(), day), day };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "fetch-failed" };
  }
}

/** Fetch wind for matched PDGA rounds that lack it (one request per course and day). */
export async function runPdgaWeatherTick(db: D1Like, doFetch: typeof fetch, now: string, budget = WEATHER_FETCHES_PER_TICK): Promise<WeatherTickSummary> {
  const summary: WeatherTickSummary = { weatherFetches: 0, weatherRounds: 0, weatherUnavailable: 0, errors: [] };
  if (budget <= 0) return summary;
  const due = await db.prepare(`SELECT r.tourn_id, r.round_number, r.pdga_layout_id, r.round_date, r.weather_attempts,
      m.course_id, m.layout_id, c.lat, c.lng
    FROM pdga_rated_rounds r JOIN pdga_layout_matches m ON m.pdga_layout_id = r.pdga_layout_id
    JOIN courses c ON c.id = m.course_id
    WHERE m.review_status IN ('auto', 'confirmed') AND m.layout_id IS NOT NULL AND c.lat IS NOT NULL AND c.lng IS NOT NULL
      AND (r.weather_status = 'pending' OR r.weather_course_id IS NOT m.course_id)
      AND (r.weather_next_at IS NULL OR r.weather_next_at <= ?)
    ORDER BY r.round_date DESC, r.tourn_id, r.round_number, r.pdga_layout_id LIMIT 60`).bind(now).all<Due>();
  const groups = new Map<string, Due[]>();
  for (const row of due.results) {
    const key = row.course_id + "|" + row.round_date;
    if (!groups.has(key) && groups.size >= budget) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const changedLayouts = new Set<number>();
  for (const rows of groups.values()) {
    const first = rows[0]!;
    summary.weatherFetches += 1;
    const result = await fetchGust(doFetch, archiveGustUrl(Number(first.lat), Number(first.lng), first.round_date));
    const stale = Date.parse(first.round_date + "T00:00:00Z") + ARCHIVE_LAG_DAYS * 86_400_000 < Date.parse(now);
    const statements: D1StatementLike[] = rows.map((row) => {
      const key = [row.tourn_id, row.round_number, row.pdga_layout_id] as const;
      if (result.ok && result.gust != null) {
        changedLayouts.add(row.layout_id);
        return db.prepare(`UPDATE pdga_rated_rounds SET wind_gust_mph = ?, weather_status = 'ok', weather_course_id = ?,
            weather_attempts = 0, weather_next_at = NULL WHERE tourn_id = ? AND round_number = ? AND pdga_layout_id = ?`)
          .bind(result.gust, row.course_id, ...key);
      }
      const attempts = result.ok ? row.weather_attempts : row.weather_attempts + 1;
      const giveUp = result.ok ? stale : attempts >= MAX_ATTEMPTS;
      const retryAt = result.ok ? later(now, 24) : later(now, BACKOFF_HOURS[Math.min(attempts, BACKOFF_HOURS.length) - 1]!);
      return db.prepare(`UPDATE pdga_rated_rounds SET weather_attempts = ?, weather_next_at = ?,
          weather_status = CASE WHEN ? THEN 'unavailable' ELSE weather_status END,
          weather_course_id = CASE WHEN ? THEN ? ELSE weather_course_id END,
          wind_gust_mph = CASE WHEN ? THEN NULL ELSE wind_gust_mph END
        WHERE tourn_id = ? AND round_number = ? AND pdga_layout_id = ?`)
        .bind(attempts, giveUp ? null : retryAt, giveUp ? 1 : 0, giveUp ? 1 : 0, row.course_id, giveUp ? 1 : 0, ...key);
    });
    if (result.ok && result.gust != null) summary.weatherRounds += rows.length;
    else if (!result.ok) summary.errors.push("weather " + first.round_date + " " + result.error);
    if (!(result.ok && result.gust != null) && (result.ok ? stale : rows[0]!.weather_attempts + 1 >= MAX_ATTEMPTS)) summary.weatherUnavailable += rows.length;
    if (db.batch) await db.batch(statements);
    else for (const statement of statements) await statement.run();
    // Open-Meteo failing now is unlikely to recover within this tick.
    if (!result.ok) break;
  }
  if (changedLayouts.size) await queuePdgaLayoutRepairs(db, changedLayouts, now);
  return summary;
}
