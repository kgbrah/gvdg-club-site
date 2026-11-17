// Shared plumbing for the marketplace handlers.

import type { Env } from "./env.js";
import { json } from "./http.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { isSuspended, type Actor } from "./market-store.js";

export type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export interface MarketCtx {
  request: Request;
  env: Env;
  origin: string | null;
  ctx: WaitCtx;
  actor: Actor | null;
}

export function fail(c: MarketCtx, status: number, error: string, field?: string): Response {
  return json(field ? { error, field } : { error }, status, c.origin);
}

export function ok(c: MarketCtx, data: unknown, status = 200): Response {
  return json(data, status, c.origin);
}

export function idOf(value: string | undefined): number | null {
  return value && /^\d{1,12}$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

/** A signed-in member or verified guest who is not suspended. */
export async function requireTrader(c: MarketCtx): Promise<Actor | Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  if (await isSuspended(c.env, c.actor.id)) return fail(c, 403, "suspended");
  return c.actor;
}

export async function requireSeller(c: MarketCtx): Promise<Actor | Response> {
  if (!c.actor) return fail(c, 401, "unauthorized");
  if (c.actor.kind !== "member") return fail(c, 403, "members_only");
  if (await isSuspended(c.env, c.actor.id)) return fail(c, 403, "suspended");
  return c.actor;
}

export async function limited(c: MarketCtx, bucket: string, limit: number, windowSec: number): Promise<Response | null> {
  return (await kvRateLimited(c.env, bucket, limit, windowSec)) ? fail(c, 429, "rate_limited") : null;
}

export function changed(result: { meta?: { changes?: number; rows_written?: number } }): boolean {
  return (result.meta?.changes ?? result.meta?.rows_written ?? 0) > 0;
}
