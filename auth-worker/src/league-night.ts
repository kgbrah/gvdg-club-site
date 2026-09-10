import type { Env } from "./env.js";
import * as db from "./db.js";
import { startLiveEvent } from "./club-live-routes.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";

const MAX_MATCHES = 12;

export type LeagueNightSide = "red" | "blue";

export type LeagueNightMatch = {
  readonly num: number;
  readonly red: readonly string[];
  readonly blue: readonly string[];
};

export type LeagueNightPlan = {
  readonly weekLabel: string;
  readonly date: string | null;
  readonly format: "singles" | "doubles";
  readonly courseId: number | null;
  readonly layoutId: number | null;
  readonly start: boolean;
  readonly matches: readonly LeagueNightMatch[];
};

export type LeagueNightPlanError = {
  readonly error: string;
  readonly message: string;
};

export function parseMatchLines(text: string, format: "singles" | "doubles"): LeagueNightMatch[] | LeagueNightPlanError {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!lines.length) return { error: "invalid_matches", message: "Add at least one match (one Red vs Blue line)." };
  if (lines.length > MAX_MATCHES) return { error: "invalid_matches", message: "A league night can start at most 12 matches." };
  const matches: LeagueNightMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseMatchLine(lines[i]!, i + 1, format);
    if ("error" in parsed) return parsed;
    matches.push(parsed);
  }
  return matches;
}

export function parseMatchLine(line: string, num: number, format: "singles" | "doubles"): LeagueNightMatch | LeagueNightPlanError {
  const parts = line.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) {
    return { error: "invalid_matches", message: `Match ${num} needs "Red vs Blue" names.` };
  }
  const red = splitNames(parts[0] || "");
  const blue = splitNames(parts[1] || "");
  const want = format === "doubles" ? 2 : 1;
  if (red.length !== want || blue.length !== want) {
    return {
      error: "invalid_matches",
      message: format === "doubles"
        ? `Match ${num} needs two Red names and two Blue names.`
        : `Match ${num} needs one Red name and one Blue name.`,
    };
  }
  return { num, red, blue };
}

export function parseLeagueNightPlan(body: Record<string, unknown>): LeagueNightPlan | LeagueNightPlanError {
  const weekLabel = asStr(body.weekLabel, 40) ?? asStr(body.week_label, 40);
  if (!weekLabel) return { error: "invalid_night", message: "Week label is required (for example Week 7)." };
  const format = body.format === "doubles" ? "doubles" : body.format === "singles" ? "singles" : null;
  if (!format) return { error: "invalid_night", message: "Format must be singles or doubles." };
  const date = asStr(body.date, 40);
  const courseId = body.course_id == null || body.course_id === "" ? null : asInt(body.course_id);
  const layoutId = body.layout_id == null || body.layout_id === "" ? null : asInt(body.layout_id);
  const start = body.start === true;
  if (start && layoutId == null) return { error: "invalid_night", message: "Pick a layout before starting live cards." };
  let matches: LeagueNightMatch[];
  if (Array.isArray(body.matches)) {
    const parsed = parseMatchObjects(body.matches, format);
    if ("error" in parsed) return parsed;
    matches = parsed;
  } else {
    const text = asStr(body.matchesText, 4000) ?? asStr(body.matches_text, 4000) ?? "";
    const parsed = parseMatchLines(text, format);
    if ("error" in parsed) return parsed;
    matches = parsed;
  }
  return { weekLabel, date, format, courseId, layoutId, start, matches };
}

export function matchEventName(leagueName: string, plan: LeagueNightPlan, match: LeagueNightMatch): string {
  return `${leagueName} ${plan.weekLabel} #${match.num} - ${match.red.join(" / ")} vs ${match.blue.join(" / ")}`;
}

export async function handleAdminLeagueNight(
  request: Request,
  env: Env,
  origin: string | null,
  adminId: string,
  leagueId: number,
): Promise<Response> {
  const league = await db.getLeague(env.DB, leagueId);
  if (!league) return json({ error: "not_found" }, 404, origin);
  const body = (await readJson(request)) ?? {};
  const plan = parseLeagueNightPlan(body);
  if ("error" in plan) return json(plan, 400, origin);
  if (plan.start && plan.layoutId != null) {
    const holes = await db.getLayoutHoles(env.DB, plan.layoutId);
    if (!holes.length) return json({ error: "no_layout_holes", message: "That layout has no holes/pars yet." }, 400, origin);
  }

  const leagueName = String((league as { name?: unknown }).name || "League");
  const liveConfig = JSON.stringify({ groupFormat: plan.format, scoringStyle: "matchplay" });
  const created: Array<Record<string, unknown>> = [];

  for (const match of plan.matches) {
    const event = await db.createEvent(env.DB, {
      type: "league_round",
      name: matchEventName(leagueName, plan, match),
      status: "scheduled",
      format: "matchplay",
      date: plan.date,
      course_id: plan.courseId,
      layout_id: plan.layoutId,
      league_id: leagueId,
      source: "manual",
      created_by: adminId,
    });
    const eventId = eventIdFrom(event);
    if (eventId == null) return json({ error: "create_failed", message: "Could not create a match event." }, 500, origin);
    for (const name of match.red) {
      await db.addEventPlayer(env.DB, { event_id: eventId, name, team: "Red" });
    }
    for (const name of match.blue) {
      await db.addEventPlayer(env.DB, { event_id: eventId, name, team: "Blue" });
    }
    await db.upsertEventConfig(env.DB, eventId, {
      play_format: plan.format,
      live_scoring_config: liveConfig,
    });
    let status = "scheduled";
    let startError: string | null = null;
    if (plan.start) {
      const started = await startLiveEvent(env, origin, eventId, {
        liveScoringConfig: { groupFormat: plan.format, scoringStyle: "matchplay" },
      });
      if (started.status === 200) status = "live";
      else {
        const data = await started.json().catch(() => ({})) as { error?: unknown };
        startError = typeof data.error === "string" ? data.error : "start_failed";
      }
    }
    created.push({
      id: eventId,
      num: match.num,
      name: matchEventName(leagueName, plan, match),
      status,
      livePath: "score.html?event=" + eventId,
      startError,
    });
  }

  return json({ night: { weekLabel: plan.weekLabel, format: plan.format, date: plan.date, events: created } }, 201, origin);
}

function parseMatchObjects(raw: unknown[], format: "singles" | "doubles"): LeagueNightMatch[] | LeagueNightPlanError {
  if (!raw.length) return { error: "invalid_matches", message: "Add at least one match (one Red vs Blue line)." };
  if (raw.length > MAX_MATCHES) return { error: "invalid_matches", message: "A league night can start at most 12 matches." };
  const matches: LeagueNightMatch[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") return { error: "invalid_matches", message: `Match ${i + 1} is invalid.` };
    const rec = row as Record<string, unknown>;
    const red = Array.isArray(rec.red) ? rec.red.map((name) => String(name || "").trim()).filter(Boolean) : splitNames(String(rec.red || ""));
    const blue = Array.isArray(rec.blue) ? rec.blue.map((name) => String(name || "").trim()).filter(Boolean) : splitNames(String(rec.blue || ""));
    const want = format === "doubles" ? 2 : 1;
    if (red.length !== want || blue.length !== want) {
      return {
        error: "invalid_matches",
        message: format === "doubles"
          ? `Match ${i + 1} needs two Red names and two Blue names.`
          : `Match ${i + 1} needs one Red name and one Blue name.`,
      };
    }
    const num = asInt(rec.num) ?? i + 1;
    matches.push({ num, red, blue });
  }
  return matches;
}

function splitNames(value: string): string[] {
  return value
    .replace(/\s+and\s+/ig, "/")
    .split(/\s*(?:\/|&|,)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function eventIdFrom(event: unknown): number | null {
  if (!event || typeof event !== "object" || !("id" in event)) return null;
  const id = (event as { id?: unknown }).id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}
