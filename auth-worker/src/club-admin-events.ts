import type { Env } from "./env.js";
import * as db from "./db.js";
import * as shopDb from "./shop-db.js";
import { handleAdminCtps } from "./admin-ctp-routes.js";
import { checkEventDeletion, isLifecycleManagedStatus } from "./admin-event-safety.js";
import { readConfirmedEventStatusPatch } from "./admin-event-status.js";
import { assignRegistrationStartingHoles, assignRegistrationTeams } from "./admin-event-assignments.js";
import { EVENT_FORMATS, EVENT_TYPES } from "./db.js";
import { createWalletTransactionOnce } from "./wallet-idempotency.js";
import { getMember } from "./roster.js";
import { enrichHoles, type LayoutHole } from "./layouts.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, inSet, jsonStringArray, sanitizeHoles, validEventInput } from "./input.js";

function inlineLayout(raw: unknown): { name: string; holes: LayoutHole[]; total_par: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const name = asStr(body.name, 60) ?? "Main";
  if (Array.isArray(body.holes)) {
    const clean = sanitizeHoles(body.holes);
    if (!clean || clean.length === 0 || clean.length > 36) return null;
    return { name, ...enrichHoles(clean) };
  }
  const holeCount = asInt(body.hole_count ?? body.holeCount);
  const defaultPar = asInt(body.default_par ?? body.defaultPar ?? body.par);
  if (holeCount == null || holeCount < 1 || holeCount > 36 || defaultPar == null || defaultPar < 1 || defaultPar > 15) return null;
  const holes = Array.from({ length: holeCount }, (_, i): LayoutHole => ({ hole: i + 1, par: defaultPar }));
  return { name, ...enrichHoles(holes) };
}

const hasField = (body: Record<string, unknown>, field: string): boolean => Object.prototype.hasOwnProperty.call(body, field);

function assignmentInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value == null || value === "") return fallback;
  const n = asInt(value);
  return n != null && n >= min && n <= max ? n : null;
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
      const patch: db.RegistrationPatch = {};
      if (hasField(b, "division")) patch.division = asStr(b.division, 60);
      if (hasField(b, "team")) patch.team = asStr(b.team, 40);
      if (hasField(b, "starting_hole")) {
        const startingHole = b.starting_hole == null || b.starting_hole === "" ? null : asInt(b.starting_hole);
        if (startingHole == null && b.starting_hole != null && b.starting_hole !== "") return json({ error: "invalid_registration" }, 400, origin);
        patch.starting_hole = startingHole;
      }
      if (hasField(b, "checked_in")) patch.checked_in = b.checked_in ? 1 : 0;
      if (hasField(b, "paid_entry")) {
        if (b.confirm_paid_entry_change !== true) return json({ error: "paid_entry_confirmation_required" }, 409, origin);
        patch.paid_entry = b.paid_entry ? 1 : 0;
      }
      const row = await db.adminUpdateRegistration(env.DB, id, rid, patch);
      return row ? json({ registration: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
  }
  if (seg[3] === "store-credit" && id != null) {
    if (method === "GET") return json({ payouts: await shopDb.listEventStoreCreditPayouts(env.DB, id) }, 200, origin);
    if (method === "POST") {
      const body = (await readJson(request)) ?? {};
      const memberId = asStr(body.member_id, 80);
      const amount = asInt(body.amount_cents);
      const idempotencyKey = asStr(body.idempotency_key, 160);
      if (!memberId || amount == null || amount <= 0) return json({ error: "invalid_store_credit" }, 400, origin);
      if (!idempotencyKey) return json({ error: "idempotency_key_required" }, 400, origin);
      const event = await db.getEvent(env.DB, id);
      if (!event) return json({ error: "not_found" }, 404, origin);
      const member = await getMember(env.ROSTER, memberId);
      if (!member) return json({ error: "member_not_found" }, 404, origin);
      const txResult = await createWalletTransactionOnce(env.DB, {
        member_id: memberId,
        member_name: member.name,
        amount_cents: amount,
        transaction_type: "credit",
        source: "event_payout",
        event_id: id,
        note: asStr(body.note, 300) ?? "Store credit payout",
        created_by: adminId,
        idempotency_key: idempotencyKey,
      });
      if (!txResult.ok) return json({ error: txResult.error }, 409, origin);
      return json({ transaction: txResult.transaction, balance_cents: await shopDb.walletBalance(env.DB, memberId), payouts: await shopDb.listEventStoreCreditPayouts(env.DB, id) }, txResult.created ? 201 : 200, origin);
    }
  }
  const ctpResponse = await handleAdminCtps({ request, env, origin, method, seg, adminId, eventId: id });
  if (ctpResponse) return ctpResponse;
  if (seg[3] === "ace-pot" && id != null && method === "PUT") {
    const b = (await readJson(request)) ?? {};
    const status = b.status == null ? "active" : (inSet(["active", "paid_out", "carried"], b.status) ? (b.status as string) : undefined);
    if (status === undefined) return json({ error: "invalid_ace_pot" }, 400, origin);
    const winnerMemberId = asStr(b.winner_member_id, 64);
    const winnerName = asStr(b.winner_name, 100);
    if (status !== "active" && b.confirm_ace_pot_resolution !== true) return json({ error: "ace_pot_confirmation_required" }, 409, origin);
    if (status === "paid_out" && !winnerMemberId && !winnerName) return json({ error: "ace_pot_winner_required" }, 400, origin);
    const row = await db.upsertAcePot(env.DB, id, {
      carryover_in_cents: asInt(b.carryover_in_cents), status, winner_member_id: winnerMemberId,
      winner_name: winnerName, payout_cents: asInt(b.payout_cents), resolved_at: status === "active" ? null : new Date().toISOString(),
    });
    return json({ ace_pot: row }, 200, origin);
  }
  if ((seg[3] === "assign-starting-holes" || seg[3] === "assign-teams") && id != null && method === "POST") {
    const b = (await readJson(request)) ?? {};
    const regs = (await db.listRegistrations(env.DB, id)) as { id: number }[];
    const registrationIds = regs.map((r) => r.id);
    if (seg[3] === "assign-starting-holes") {
      const groupSize = assignmentInt(b.groupSize, 4, 1, 12);
      const holeCount = assignmentInt(b.holeCount, 18, 1, 36);
      if (groupSize == null || holeCount == null) return json({ error: "invalid_assignment" }, 400, origin);
      const ev = (await db.getEvent(env.DB, id)) as { layout_id?: number | null } | null;
      let holes = (await db.getLayoutHoles(env.DB, ev?.layout_id)).map((h) => h.hole);
      if (!holes.length) holes = Array.from({ length: holeCount }, (_, i) => i + 1);
      const error = await assignRegistrationStartingHoles({ database: env.DB, eventId: id, registrationIds, shuffle: b.shuffle !== false, holes, groupSize, origin });
      if (error) return error;
    } else {
      const hasSize = hasField(b, "size");
      const size = hasSize ? assignmentInt(b.size, 2, 1, 12) : null;
      const count = hasSize ? null : assignmentInt(b.count, 2, 2, 64);
      if ((hasSize && size == null) || (!hasSize && count == null)) return json({ error: "invalid_assignment" }, 400, origin);
      const opts = hasSize ? { size: size ?? 2 } : { count: count ?? 2 };
      const error = await assignRegistrationTeams({ database: env.DB, eventId: id, registrationIds, shuffle: b.shuffle !== false, options: opts, origin });
      if (error) return error;
    }
    return json({ registrations: await db.listRegistrations(env.DB, id) }, 200, origin);
  }
  if (method === "POST" && seg.length === 2) {
    const b = await readJson(request);
    const v = b && validEventInput(b);
    if (!v) return json({ error: "invalid_event" }, 400, origin);
    if (isLifecycleManagedStatus(v.status)) return json({ error: "lifecycle_status_requires_live_flow" }, 409, origin);
    let layout: unknown = null;
    let eventInput = v;
    const layoutBody = b && typeof b === "object" ? (b as Record<string, unknown>).layout : null;
    if (layoutBody != null && v.layout_id == null) {
      if (v.course_id == null) return json({ error: "invalid_layout" }, 400, origin);
      const cleanLayout = inlineLayout(layoutBody);
      if (!cleanLayout) return json({ error: "invalid_layout" }, 400, origin);
      layout = await db.createLayout(env.DB, { course_id: v.course_id, ...cleanLayout });
      const layoutId = asInt((layout as { id?: unknown } | null)?.id);
      if (layoutId == null) return json({ error: "invalid_layout" }, 500, origin);
      eventInput = { ...v, layout_id: layoutId };
    }
    const row = await db.createEvent(env.DB, { ...eventInput, created_by: adminId });
    return json(layout ? { event: row, layout } : { event: row }, 201, origin);
  }
  if (method === "PATCH" && id != null) {
    const b = (await readJson(request)) ?? {};
    const patch: db.EventPatch = {};
    if (hasField(b, "type")) {
      if (!inSet(EVENT_TYPES, b.type)) return json({ error: "invalid_event" }, 400, origin);
      patch.type = b.type;
    }
    if (hasField(b, "name")) {
      const name = asStr(b.name, 200);
      if (!name) return json({ error: "invalid_event" }, 400, origin);
      patch.name = name;
    }
    if (hasField(b, "status")) {
      const statusPatch = await readConfirmedEventStatusPatch({ database: env.DB, eventId: id, body: b, origin });
      if (!statusPatch.ok) return statusPatch.response;
      patch.status = statusPatch.status;
    }
    if (hasField(b, "format")) {
      if (b.format == null || b.format === "") patch.format = null;
      else if (inSet(EVENT_FORMATS, b.format)) patch.format = b.format;
      else return json({ error: "invalid_event" }, 400, origin);
    }
    if (hasField(b, "date")) {
      const date = b.date == null || b.date === "" ? null : asStr(b.date, 40);
      if (date == null && b.date != null && b.date !== "") return json({ error: "invalid_event" }, 400, origin);
      patch.date = date;
    }
    if (hasField(b, "course_id")) {
      const courseId = b.course_id == null || b.course_id === "" ? null : asInt(b.course_id);
      if (courseId == null && b.course_id != null && b.course_id !== "") return json({ error: "invalid_event" }, 400, origin);
      patch.course_id = courseId;
    }
    if (hasField(b, "layout_id")) {
      const layoutId = b.layout_id == null || b.layout_id === "" ? null : asInt(b.layout_id);
      if (layoutId == null && b.layout_id != null && b.layout_id !== "") return json({ error: "invalid_event" }, 400, origin);
      patch.layout_id = layoutId;
    }
    if (hasField(b, "league_id")) {
      const leagueId = b.league_id == null || b.league_id === "" ? null : asInt(b.league_id);
      if (leagueId == null && b.league_id != null && b.league_id !== "") return json({ error: "invalid_event" }, 400, origin);
      patch.league_id = leagueId;
    }
    if (hasField(b, "notes")) {
      const notes = b.notes == null || b.notes === "" ? null : asStr(b.notes, 5000);
      if (notes == null && b.notes != null && b.notes !== "") return json({ error: "invalid_event" }, 400, origin);
      patch.notes = notes;
    }
    const row = await db.updateEvent(env.DB, id, patch);
    return row ? json({ event: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
  }
  if (method === "DELETE" && id != null) {
    const check = await checkEventDeletion(env.DB, id);
    if (!check.ok) {
      return json({ error: check.error, blockers: check.blockers }, check.error === "not_found" ? 404 : 409, origin);
    }
    await db.deleteEvent(env.DB, id);
    return json({ ok: true }, 200, origin);
  }
  return null;
}
