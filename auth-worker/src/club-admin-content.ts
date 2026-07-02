import type { Env } from "./env.js";
import * as db from "./db.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, jsonStringArray } from "./input.js";

type FundraiserStatus = "active" | "closed";

type FundraiserStatusPatchInput = {
  readonly status: FundraiserStatus | null;
  readonly body: Record<string, unknown>;
  readonly origin: string | null;
};

export type FundraiserStatusPatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly response: Response };

type ParsedFundraiserInput = {
  readonly title: string | null;
  readonly body_md: string | null;
  readonly goal_cents: number | null;
  readonly raised_cents: number | null;
  readonly paypal_url: string | null;
  readonly status: FundraiserStatus | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
};

export async function handleAdminLeagues(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  adminId: string,
  id: number | null,
): Promise<Response | null> {
  if (method === "POST") {
    const b = await readJson(request);
    const name = b && asStr(b.name, 120);
    if (!b || !name) return json({ error: "invalid_league" }, 400, origin);
    const row = await db.createLeague(env.DB, { name, season: asStr(b.season, 40), format: asStr(b.format, 20), description: asStr(b.description, 2000), created_by: adminId });
    return json({ league: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    const row = await db.updateLeague(env.DB, id, { name: asStr(b.name, 120), season: asStr(b.season, 40), format: asStr(b.format, 20), description: asStr(b.description, 2000) });
    return row ? json({ league: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    const b = (await readJson(request)) ?? {};
    if (b.confirm_league_delete !== true) return json({ error: "league_delete_confirmation_required" }, 409, origin);
    await db.deleteLeague(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}

export function confirmFundraiserStatusPatch(input: FundraiserStatusPatchInput): FundraiserStatusPatchResult {
  if (input.status == null) return { ok: true };
  if (input.body.confirm_fundraiser_status_change !== true) {
    return { ok: false, response: json({ error: "fundraiser_status_confirmation_required" }, 409, input.origin) };
  }
  return { ok: true };
}

const fundraiserInput = (b: Record<string, unknown>): ParsedFundraiserInput | null => {
  const paypal = b.paypal_url == null ? null : asStr(b.paypal_url, 1000);
  if (b.paypal_url != null && paypal && !/^https:\/\//.test(paypal)) return null;
  const status = b.status == null ? null : (b.status === "active" || b.status === "closed" ? b.status : undefined);
  if (status === undefined) return null;
  return {
    title: asStr(b.title, 200), body_md: asStr(b.body_md, 20000), goal_cents: b.goal_cents == null ? null : asInt(b.goal_cents),
    raised_cents: b.raised_cents == null ? null : asInt(b.raised_cents), paypal_url: paypal, status,
    starts_at: asStr(b.starts_at, 40), ends_at: asStr(b.ends_at, 40),
  };
};

export async function handleAdminFundraisers(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  adminId: string,
  id: number | null,
): Promise<Response | null> {
  if (method === "POST") {
    const b = await readJson(request);
    const v = b && fundraiserInput(b);
    if (!v || !v.title) return json({ error: "invalid_fundraiser" }, 400, origin);
    const row = await db.createFundraiser(env.DB, { ...v, title: v.title, status: v.status ?? "active", created_by: adminId });
    return json({ fundraiser: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    const v = fundraiserInput(b);
    if (!v) return json({ error: "invalid_fundraiser" }, 400, origin);
    const confirmation = confirmFundraiserStatusPatch({ status: v.status, body: b, origin });
    if (!confirmation.ok) return confirmation.response;
    const row = await db.updateFundraiser(env.DB, id, v);
    return row ? json({ fundraiser: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    const b = (await readJson(request)) ?? {};
    if (b.confirm_fundraiser_delete !== true) return json({ error: "fundraiser_delete_confirmation_required" }, 409, origin);
    await db.deleteFundraiser(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}

export async function handleAdminMeetings(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  adminId: string,
  id: number | null,
): Promise<Response | null> {
  if (method === "POST") {
    const b = await readJson(request);
    const date = b && asStr(b.date, 40), title = b && asStr(b.title, 200);
    if (!b || !date || !title) return json({ error: "invalid_meeting" }, 400, origin);
    const row = await db.createMeeting(env.DB, { date, title, minutes_md: asStr(b.minutes_md, 50000), action_items: jsonStringArray(b.action_items, 100), attendees: jsonStringArray(b.attendees, 100), created_by: adminId });
    return json({ meeting: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    const row = await db.updateMeeting(env.DB, id, { date: asStr(b.date, 40), title: asStr(b.title, 200), minutes_md: asStr(b.minutes_md, 50000), action_items: b.action_items === undefined ? null : jsonStringArray(b.action_items, 100), attendees: b.attendees === undefined ? null : jsonStringArray(b.attendees, 100) });
    return row ? json({ meeting: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    const b = (await readJson(request)) ?? {};
    if (b.confirm_meeting_delete !== true) return json({ error: "meeting_delete_confirmation_required" }, 409, origin);
    await db.deleteMeeting(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}
