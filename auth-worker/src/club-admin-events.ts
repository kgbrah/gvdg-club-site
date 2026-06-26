import type { Env } from "./env.js";
import * as db from "./db.js";
import { EVENT_FORMATS, EVENT_STATUSES } from "./db.js";
import { assignShotgun, assignTeams } from "./assign.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, inSet, jsonStringArray, validEventInput } from "./input.js";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export async function handleAdminEvents(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
  id: number | null,
): Promise<Response | null> {
  if (seg[3] === "players" && id != null) {
    if (method === "POST") {
      const b = await readJson(request);
      const name = b && asStr(b.name, 100);
      if (!b || !name) return json({ error: "invalid_player" }, 400, origin);
      const row = await db.addEventPlayer(env.DB, { event_id: id, member_id: asStr(b.member_id, 64), name, pdga_no: asStr(b.pdga_no, 20), division: asStr(b.division, 40), team: asStr(b.team, 40) });
      return json({ player: row }, 201, origin);
    }
    if (method === "DELETE" && seg[4] != null) {
      const pid = asInt(seg[4]);
      if (pid == null) return json({ error: "not_found" }, 404, origin);
      await db.removeEventPlayer(env.DB, id, pid);
      return json({ ok: true }, 200, origin);
    }
  }
  if (seg[3] === "config" && id != null && method === "PUT") {
    const b = (await readJson(request)) ?? {};
    const divs = jsonStringArray(b.divisions, 40);
    const fmt = b.play_format == null ? null : (inSet(["singles", "doubles", "teams"], b.play_format) ? (b.play_format as string) : undefined);
    if (fmt === undefined) return json({ error: "invalid_config" }, 400, origin);
    const row = await db.upsertEventConfig(env.DB, id, {
      registration_open: b.registration_open ? 1 : 0, entry_fee_cents: asInt(b.entry_fee_cents), ctp_fee_cents: asInt(b.ctp_fee_cents),
      ace_fee_cents: asInt(b.ace_fee_cents), divisions: divs, play_format: fmt, notes: asStr(b.notes, 2000),
    });
    return json({ config: row }, 200, origin);
  }
  if (seg[3] === "registrations" && id != null) {
    if (method === "GET" && seg[4] == null) return json({ registrations: await db.listRegistrations(env.DB, id) }, 200, origin);
    if (method === "PATCH" && seg[4] != null) {
      const rid = asInt(seg[4]);
      if (rid == null) return json({ error: "not_found" }, 404, origin);
      const b = (await readJson(request)) ?? {};
      const row = await db.adminUpdateRegistration(env.DB, rid, {
        division: asStr(b.division, 60), team: asStr(b.team, 40), starting_hole: asInt(b.starting_hole),
        checked_in: b.checked_in == null ? null : (b.checked_in ? 1 : 0), paid_entry: b.paid_entry == null ? null : (b.paid_entry ? 1 : 0),
      });
      return row ? json({ registration: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
  }
  if (seg[3] === "ctps" && id != null) {
    if (method === "POST" && seg[4] == null) {
      const b = await readJson(request);
      const hole = b && asInt(b.hole);
      if (!b || hole == null) return json({ error: "invalid_ctp" }, 400, origin);
      const row = await db.createCtp(env.DB, { event_id: id, hole, division: asStr(b.division, 60), prize: asStr(b.prize, 200) });
      return json({ ctp: row }, 201, origin);
    }
    const cid = seg[4] != null ? asInt(seg[4]) : null;
    if (method === "PATCH" && cid != null) {
      const b = (await readJson(request)) ?? {};
      const row = await db.setCtpWinner(env.DB, cid, id, asStr(b.winner_member_id, 64), asStr(b.winner_name, 100));
      return row ? json({ ctp: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
    if (method === "DELETE" && cid != null) {
      await db.deleteCtp(env.DB, id, cid);
      return json({ ok: true }, 200, origin);
    }
  }
  if (seg[3] === "ace-pot" && id != null && method === "PUT") {
    const b = (await readJson(request)) ?? {};
    const status = b.status == null ? "active" : (inSet(["active", "paid_out", "carried"], b.status) ? (b.status as string) : undefined);
    if (status === undefined) return json({ error: "invalid_ace_pot" }, 400, origin);
    const row = await db.upsertAcePot(env.DB, id, {
      carryover_in_cents: asInt(b.carryover_in_cents), status, winner_member_id: asStr(b.winner_member_id, 64),
      winner_name: asStr(b.winner_name, 100), payout_cents: asInt(b.payout_cents), resolved_at: status === "active" ? null : new Date().toISOString(),
    });
    return json({ ace_pot: row }, 200, origin);
  }
  if ((seg[3] === "assign-starting-holes" || seg[3] === "assign-teams") && id != null && method === "POST") {
    const b = (await readJson(request)) ?? {};
    const regs = (await db.listRegistrations(env.DB, id)) as { id: number }[];
    let order = regs.map((r) => r.id);
    if (b.shuffle !== false) order = shuffle(order);
    if (seg[3] === "assign-starting-holes") {
      const ev = (await db.getEvent(env.DB, id)) as { layout_id?: number | null } | null;
      let holes = (await db.getLayoutHoles(env.DB, ev?.layout_id)).map((h) => h.hole);
      if (!holes.length) holes = Array.from({ length: asInt(b.holeCount) || 18 }, (_, i) => i + 1);
      const assigned = assignShotgun(order.map(String), holes, asInt(b.groupSize) || 4);
      await Promise.all(order.map((rid, i) => db.adminUpdateRegistration(env.DB, rid, { starting_hole: assigned[i]!.hole })));
    } else {
      const opts = asInt(b.size) ? { size: asInt(b.size)! } : { count: asInt(b.count) || 2 };
      const assigned = assignTeams(order.map(String), opts);
      await Promise.all(order.map((rid, i) => db.adminUpdateRegistration(env.DB, rid, { team: assigned[i]!.team })));
    }
    return json({ registrations: await db.listRegistrations(env.DB, id) }, 200, origin);
  }
  if (method === "POST" && seg.length === 2) {
    const b = await readJson(request);
    const v = b && validEventInput(b);
    if (!v) return json({ error: "invalid_event" }, 400, origin);
    const row = await db.createEvent(env.DB, { ...v, created_by: adminId });
    return json({ event: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    if (b.status != null && !inSet(EVENT_STATUSES, b.status)) return json({ error: "invalid_event" }, 400, origin);
    if (b.format != null && b.format !== "" && !inSet(EVENT_FORMATS, b.format)) return json({ error: "invalid_event" }, 400, origin);
    const row = await db.updateEvent(env.DB, id, {
      name: asStr(b.name, 200), status: asStr(b.status), format: asStr(b.format),
      date: asStr(b.date, 40), course_id: b.course_id == null ? null : asInt(b.course_id),
      layout_id: b.layout_id == null ? null : asInt(b.layout_id), league_id: b.league_id == null ? null : asInt(b.league_id),
      notes: asStr(b.notes, 5000),
    });
    return row ? json({ event: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    await db.deleteEvent(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}
