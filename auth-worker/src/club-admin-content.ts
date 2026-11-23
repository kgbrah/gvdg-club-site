import type { Env } from "./env.js";
import * as db from "./db.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, jsonStringArray } from "./input.js";
import { RYDER_CUP_LEAGUE_ID } from "./ryder-board.js";

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
    if (b.source === "udisc") {
      const existing = await env.DB.prepare("SELECT * FROM leagues WHERE name = ? COLLATE NOCASE LIMIT 1").bind(name).first();
      if (existing) return json({ league: existing, duplicate: true }, 200, origin);
    }
    const format = b.format == null || b.format === "" ? null : asStr(b.format, 40);
    if (b.format != null && b.format !== "" && !format) return json({ error: "invalid_league" }, 400, origin);
    const row = await db.createLeague(env.DB, { name, season: asStr(b.season, 40), format, description: asStr(b.description, 2000), created_by: adminId });
    return json({ league: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    const format = b.format == null || b.format === "" ? null : asStr(b.format, 40);
    if (b.format != null && b.format !== "" && !format) return json({ error: "invalid_league" }, 400, origin);
    const row = await db.updateLeague(env.DB, id, { name: asStr(b.name, 120), season: asStr(b.season, 40), format, description: asStr(b.description, 2000) });
    return row ? json({ league: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    if (id === RYDER_CUP_LEAGUE_ID) return json({ error: "protected" }, 409, origin);
    try {
      await db.deleteLeague(env.DB, id);
    } catch (error) {
      if (error instanceof Error && error.message === "league_live") return json({ error: "league_live" }, 409, origin);
      return json({ error: "delete_failed" }, 409, origin);
    }
    return json({ ok: true }, 200, origin);
  }
  return null;
}

const fundraiserInput = (b: Record<string, unknown>) => {
  const paypal = b.paypal_url == null ? null : asStr(b.paypal_url, 1000);
  if (b.paypal_url != null && paypal && !/^https:\/\//.test(paypal)) return null;
  const status = b.status == null ? null : (b.status === "active" || b.status === "closed" ? (b.status as string) : undefined);
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
    const row = await db.updateFundraiser(env.DB, id, v);
    return row ? json({ fundraiser: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
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
    await db.deleteMeeting(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}
