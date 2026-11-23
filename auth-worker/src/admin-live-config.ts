import type { Env } from "./env.js";
import * as db from "./db.js";
import { isLiveFormatError, normalizeLiveScoringConfig, normalizeLiveScoringConfigFromLegacy, normalizeStoredLiveScoringConfig } from "./live-format.js";

export class AdminLiveConfigError extends Error {
  constructor() {
    super("invalid live scoring config");
    this.name = "AdminLiveConfigError";
  }
}

export async function withPreservedPuttingStations(
  dbLike: Env["DB"],
  eventId: number,
  raw: unknown,
): Promise<unknown> {
  if (!isObjectRecord(raw) || raw["scoringStyle"] !== "putting" || hasField(raw, "putting")) return raw;
  const existingConfig = await db.getEventConfig(dbLike, eventId);
  const existing = normalizeStoredLiveScoringConfig(existingConfig?.live_scoring_config);
  if (existing?.scoringStyle === "putting" && existing.putting) {
    return { ...raw, putting: existing.putting };
  }
  return raw;
}

export async function adminLiveScoringConfigJson(input: {
  readonly env: Env;
  readonly eventId: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly playFormat: string | null;
}): Promise<string> {
  const liveConfigInput = liveScoringConfigInput(input.body);
  try {
    if (liveConfigInput.hasInput) {
      const raw = await withPreservedPuttingStations(input.env.DB, input.eventId, liveConfigInput.value);
      return JSON.stringify(normalizeLiveScoringConfig(raw));
    }
    const [existingConfig, event] = await Promise.all([db.getEventConfig(input.env.DB, input.eventId), db.getEvent(input.env.DB, input.eventId)]);
    return JSON.stringify(normalizeLiveScoringConfigFromLegacy({
      live_scoring_config: existingConfig?.live_scoring_config,
      play_format: input.playFormat ?? existingConfig?.play_format,
      event_format: fieldValue(event, "format"),
    }));
  } catch (error) {
    if (isLiveFormatError(error)) throw new AdminLiveConfigError();
    throw error;
  }
}

function liveScoringConfigInput(body: Readonly<Record<string, unknown>>): { readonly hasInput: boolean; readonly value: unknown } {
  if (hasField(body, "liveScoringConfig")) return { hasInput: true, value: body.liveScoringConfig };
  if (hasField(body, "live_scoring_config")) return { hasInput: true, value: body.live_scoring_config };
  return { hasInput: false, value: undefined };
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasField(body: Readonly<Record<string, unknown>>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function fieldValue(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key === field) return item;
  }
  return undefined;
}
