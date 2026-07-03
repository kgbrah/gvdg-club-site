import * as db from "./db.js";
import { playFormatForRound, scoringFormatForRound, teamNameRequiredForFormat } from "./input.js";

type LiveFormatEnv = {
  readonly DB: db.D1Like;
};
type LiveJson = Record<string, unknown>;
type LiveEventRow = Record<string, unknown> & {
  readonly format?: string | null;
};
type LiveEventConfigRow = {
  readonly play_format?: string | null;
};

export type LiveRoundFormats = {
  readonly format: string;
  readonly playFormat: string;
  readonly teamRequired: boolean;
};

function rowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

export function liveRoundFormats(eventFormat: string | null, playFormat: string | null): LiveRoundFormats | null {
  const scoringFormat = scoringFormatForRound(eventFormat);
  const normalizedPlayFormat = playFormatForRound(playFormat, eventFormat);
  if (!scoringFormat || !normalizedPlayFormat) return null;
  return {
    format: scoringFormat,
    playFormat: normalizedPlayFormat,
    teamRequired: teamNameRequiredForFormat(scoringFormat, normalizedPlayFormat),
  };
}

async function liveEventFormats(env: LiveFormatEnv, eid: number): Promise<LiveRoundFormats | null> {
  const ev = (await db.getEvent(env.DB, eid)) as LiveEventRow | null;
  if (!ev) return null;
  const evConfig = (await db.getEventConfig(env.DB, eid)) as LiveEventConfigRow | null;
  return liveRoundFormats(rowString(ev, "format"), rowString(evConfig ?? {}, "play_format"));
}

export async function enrichLiveEventFormats(env: LiveFormatEnv, eid: number, data: LiveJson, status: number): Promise<LiveJson> {
  if (status !== 200 || (data["status"] !== "live" && data["status"] !== "final")) return data;
  const formats = await liveEventFormats(env, eid);
  return formats ? { ...data, ...formats } : data;
}
