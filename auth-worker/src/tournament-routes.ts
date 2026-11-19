// Club-run PDGA events on the club site: PDGA number checks, sign-up with the event's rules and waitlist, payment by
// PayPal (the player can cover PayPal's fee) or Zelle (an admin confirms it arrived), and the admin settings.
// See tournament.ts for the PDGA Competition Manual rules this follows.

import type { Env } from "./env.js";
import * as db from "./db.js";
import * as tdb from "./db-tournament.js";
import { computeOwed, paypalBase, createOrder as ppCreateOrder, captureOrder as ppCaptureOrder, isCaptureSettled, type OwedConfig } from "./payments.js";
import { clientIp, json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { getMember } from "./roster.js";
import { deadlinePassed } from "./event-deadlines.js";
import {
  lookupPdgaEvent, lookupPdgaPlayer, normalPdgaNumber, pdgaApiConfigured, pdgaEventUrl, PdgaApiError, PDGA_ATTRIBUTION, type PdgaApiEnv, type PdgaPlayer,
} from "./pdga-api.js";
import {
  eligibilityProblem, nonMemberFeeFor, parseTournamentRules, paypalFeeRates, pdgaCheckMatters, tournamentQuote, tournamentRulesInput, zelleCode,
  type PaymentMethod, type TournamentRules,
} from "./tournament.js";

type Row = Record<string, unknown>;
type Claims = { sub: string } | null;
const GUEST_REGISTER_IP_LIMIT = 15;

export type TournamentConfig = Row & {
  pdga_event_id?: number | null; pdga_event?: string | null; pdga_rules?: string | null; player_cap?: number | null;
  paypal_fee_passthrough?: number | null; zelle_to?: string | null; zelle_name?: string | null; td_email?: string | null;
  registration_open?: number | null; divisions?: string | null; teams?: string | null; play_format?: string | null;
};

/** A club event linked to a PDGA event registers with the tournament rules here. */
export function isTournament(cfg: TournamentConfig | null | undefined): cfg is TournamentConfig {
  return cfg?.pdga_event_id != null && Number(cfg.pdga_event_id) > 0;
}

const apiEnv = (env: Env) => env as unknown as PdgaApiEnv;

function playerView(player: PdgaPlayer) {
  return {
    pdgaNumber: player.pdgaNumber, name: player.name, membershipStatus: player.membershipStatus, membershipExpires: player.membershipExpires,
    rating: player.rating, ratingDate: player.ratingDate, classification: player.classification, url: player.url,
  };
}

/** GET /pdga/player?number=N — a PDGA number checked with the official API (for the registration form). */
export async function handlePdgaPlayerLookup(request: Request, env: Env, origin: string | null): Promise<Response> {
  const number = normalPdgaNumber(new URL(request.url).searchParams.get("number"));
  if (!number) return json({ error: "invalid_pdga_number" }, 400, origin);
  if (!pdgaApiConfigured(apiEnv(env))) return json({ error: "pdga_unavailable" }, 503, origin);
  if (await kvRateLimited(env, "pdgalookup:" + clientIp(request), 30, 60)) return json({ error: "rate_limited" }, 429, origin);
  try {
    const player = await lookupPdgaPlayer(apiEnv(env), number);
    return json({ player: player ? playerView(player) : null, attribution: PDGA_ATTRIBUTION }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof PdgaApiError && error.code === "rate_limited" ? "rate_limited" : "pdga_unavailable" }, 503, origin);
  }
}

function parseAddons(raw: unknown): { ctp?: boolean; ace?: boolean } {
  if (raw && typeof raw === "object") return raw as { ctp?: boolean; ace?: boolean };
  try { return JSON.parse(String(raw || "{}")) as { ctp?: boolean; ace?: boolean }; } catch { return {}; }
}

function rulesOf(cfg: TournamentConfig): TournamentRules {
  return parseTournamentRules(cfg.pdga_rules ?? null);
}

/** What a registration owes the event: entry + add-ons + the non-member fee when it applies. */
export function tournamentOwed(cfg: TournamentConfig, reg: Row): number {
  const standing = reg.pdga_number ? { status: (reg.pdga_status as string | null) ?? null, rating: (reg.pdga_rating as number | null) ?? null } : null;
  return computeOwed(cfg as OwedConfig, parseAddons(reg.addons)) + (isTournament(cfg) ? nonMemberFeeFor(rulesOf(cfg), standing) : 0);
}

function quoteFor(env: Env, cfg: TournamentConfig, reg: Row, method: PaymentMethod, donate: boolean) {
  return tournamentQuote({
    owedCents: tournamentOwed(cfg, reg), method, donate, passthrough: Number(cfg.paypal_fee_passthrough) === 1,
    rates: paypalFeeRates(env as unknown as { PAYPAL_FEE_PERCENT?: string; PAYPAL_FEE_FIXED_CENTS?: string }), offerDonation: isTournament(cfg),
  });
}

/** The public part of a tournament's registration page: its PDGA event, rules, cap, the paid field and the waitlist. */
export async function tournamentView(env: Env, eventId: number, cfg: TournamentConfig, registrationId: number | null = null) {
  let pdgaEvent: Row | null = null;
  try { pdgaEvent = cfg.pdga_event ? JSON.parse(cfg.pdga_event) as Row : null; } catch { pdgaEvent = null; }
  const field = await tdb.publicField(env.DB, eventId, new Date(), registrationId);
  const rules = rulesOf(cfg);
  return {
    pdgaEventId: Number(cfg.pdga_event_id), pdgaEventUrl: pdgaEventUrl(Number(cfg.pdga_event_id)),
    pdgaEvent: pdgaEvent ? { name: pdgaEvent.name ?? null, tier: pdgaEvent.tier ?? null, startDate: pdgaEvent.startDate ?? null, endDate: pdgaEvent.endDate ?? null } : null,
    rules, cap: cfg.player_cap ?? null, spotsLeft: cfg.player_cap == null ? null : Math.max(0, Number(cfg.player_cap) - field.used),
    field: field.paid, waitlist: field.waitlist, myWaitlistPosition: field.position,
    payments: {
      paypalFeeCovered: Number(cfg.paypal_fee_passthrough) === 1,
      zelle: cfg.zelle_to ? { to: cfg.zelle_to, name: cfg.zelle_name ?? null } : null,
    },
    tdEmail: cfg.td_email ?? null,
    pdgaLookup: pdgaApiConfigured(apiEnv(env)),
    attribution: PDGA_ATTRIBUTION,
  };
}

/** POST /events/:id/register for a tournament. */
export async function registerForTournament(
  request: Request, env: Env, origin: string | null, eventId: number, cfg: TournamentConfig, claims: Claims, body: Row,
  guest: { memberId: string; token: string } | null,
): Promise<Response> {
  const division = asStr(body.division, 60);
  let divisions: string[] = [];
  try { divisions = JSON.parse(cfg.divisions || "[]"); } catch { divisions = []; }
  if (!Array.isArray(divisions)) divisions = [];
  if (division && divisions.length && !divisions.includes(division)) return json({ error: "invalid_division" }, 400, origin);
  if (divisions.length && !division) return json({ error: "division_required" }, 400, origin);

  let memberId: string;
  let name = "";
  let email: string | null = null;
  let pdgaRaw: unknown = body.pdgaNumber;
  if (claims) {
    memberId = claims.sub;
    const member = await getMember(env.ROSTER, claims.sub);
    name = member?.name ?? "Member";
    if (pdgaRaw == null || pdgaRaw === "") pdgaRaw = member?.pdgaNo ?? null;
  } else {
    if (await kvRateLimited(env, "evreg:" + clientIp(request), GUEST_REGISTER_IP_LIMIT, 60)) return json({ error: "rate_limited" }, 429, origin);
    memberId = guest!.memberId;
    name = asStr(body.name, 80) ?? "";
    email = asStr(body.email, 120);
  }
  const pdgaNumber = pdgaRaw == null || pdgaRaw === "" ? null : normalPdgaNumber(pdgaRaw);
  if (pdgaRaw != null && pdgaRaw !== "" && !pdgaNumber) return json({ error: "invalid_pdga_number" }, 400, origin);

  const rules = rulesOf(cfg);
  let player: PdgaPlayer | null = null;
  let checked = false;
  if (pdgaNumber && pdgaApiConfigured(apiEnv(env))) {
    try {
      player = await lookupPdgaPlayer(apiEnv(env), pdgaNumber);
      checked = true;
    } catch { /* PDGA unreachable: decided below */ }
    if (checked && !player) return json({ error: "pdga_not_found" }, 400, origin);
  }
  if (pdgaNumber && !checked && pdgaCheckMatters(rules, division)) return json({ error: "pdga_unavailable" }, 503, origin);
  if (!name && player) name = player.name;
  if (!name) return json({ error: "name_required" }, 400, origin);
  const standing = checked && player ? { status: player.membershipStatus, rating: player.rating } : null;
  const problem = eligibilityProblem(rules, division, pdgaNumber ? standing ?? { status: null, rating: null } : null);
  if (problem) return json(problem, 403, origin);

  const existing = await db.getMyRegistration(env.DB, eventId, memberId) as Row | null;
  if (Number(existing?.paid_entry) === 1) {
    // Paid: details can be fixed, but nothing that would change what's owed.
    const draft = { ...existing, addons: body.addons && typeof body.addons === "object" ? JSON.stringify(body.addons) : existing!.addons,
      pdga_status: standing?.status ?? existing!.pdga_status, pdga_rating: standing?.rating ?? existing!.pdga_rating, pdga_number: pdgaNumber };
    if (tournamentOwed(cfg, draft) > Number(existing!.amount_paid_cents ?? 0)) return json({ error: "paid_addons_locked" }, 409, origin);
  }
  if (!existing) {
    const sched = (await db.getEventSchedule(env.DB, eventId)) as { registration_deadline?: string | null } | null;
    if (deadlinePassed(sched?.registration_deadline)) return json({ error: "registration_closed" }, 403, origin);
  }
  const addons = body.addons && typeof body.addons === "object"
    ? JSON.stringify({ ctp: !!(body.addons as Row).ctp, ace: !!(body.addons as Row).ace }) : null;
  const row = await tdb.registerTournamentPlayer(env.DB, {
    event_id: eventId, member_id: memberId, name, division, team: asStr(body.team, 40), addons, email,
    pdga_number: pdgaNumber, pdga_status: standing?.status ?? null, pdga_rating: standing?.rating ?? null,
  }, cfg.player_cap ?? null);
  const view = { registration: row, ...(player ? { player: playerView(player), attribution: PDGA_ATTRIBUTION } : {}) };
  return json(guest && !claims ? { ...view, guestToken: guest.token } : view, 201, origin);
}

type Reg = Row & { id: number; paid_entry?: number; payment_ref?: string | null; waitlisted?: number };

/**
 * /events/:id/pay/{quote,create-order,capture,zelle,zelle/sent} for an event with tournament settings or the new
 * payment options. Members and guests (with their registration token) both pay here.
 */
export async function handleTournamentPay(request: Request, env: Env, origin: string | null, method: string, seg: string[], eventId: number,
  cfg: TournamentConfig, reg: Reg, body: Row): Promise<Response | null> {
  const action = seg[3];
  const donate = body.donate === true || new URL(request.url).searchParams.get("donate") === "1";
  if (action === "quote" && method === "GET") {
    const choice = new URL(request.url).searchParams.get("method") === "zelle" ? "zelle" : "paypal";
    return json({ quote: quoteFor(env, cfg, reg, choice, donate) }, 200, origin);
  }
  if (method !== "POST") return null;
  if (Number(reg.paid_entry) === 1 && action !== "capture") return json({ error: "already_paid" }, 409, origin);
  if (Number(reg.waitlisted) === 1 && action !== "capture") return json({ error: "waitlisted" }, 409, origin);

  if (action === "zelle" && seg[4] === "sent") {
    const row = await tdb.markZelleSent(env.DB, reg.id);
    return row ? json({ registration: row }, 200, origin) : json({ error: "not_zelle" }, 409, origin);
  }
  if (action === "zelle") {
    if (!cfg.zelle_to) return json({ error: "zelle_not_offered" }, 409, origin);
    const quote = quoteFor(env, cfg, reg, "zelle", donate);
    if (quote.totalCents <= 0) return json({ error: "nothing_owed" }, 400, origin);
    const row = await tdb.setPaymentChoice(env.DB, reg.id, { method: "zelle", feeCents: 0, donationCents: quote.donationCents, zelleCode: zelleCode(eventId, reg.id) });
    return json({ registration: row, quote, zelle: { to: cfg.zelle_to, name: cfg.zelle_name ?? null, amountCents: quote.totalCents, memo: row?.zelle_code } }, 200, origin);
  }

  if (!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET)) return json({ error: "payments_not_configured" }, 503, origin);
  const creds = { clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, base: paypalBase(env.PAYPAL_ENV, env.PAYPAL_API_BASE) };
  try {
    if (action === "create-order") {
      const quote = quoteFor(env, cfg, reg, "paypal", donate);
      if (quote.totalCents <= 0) return json({ error: "nothing_owed" }, 400, origin);
      if (isTournament(cfg) && !(await tdb.spotOpen(env.DB, reg.id, eventId, cfg.player_cap ?? null))) {
        await tdb.moveToWaitlist(env.DB, reg.id);
        return json({ error: "field_full" }, 409, origin);
      }
      await tdb.setPaymentChoice(env.DB, reg.id, { method: "paypal", feeCents: quote.feeCents, donationCents: quote.donationCents });
      const orderId = await ppCreateOrder(creds, quote.totalCents, isTournament(cfg) ? "GVDG tournament entry" : "GVDG event entry");
      return json({ orderId, quote }, 200, origin);
    }
    if (action === "capture") {
      const orderId = asStr(body.orderId, 100);
      if (!orderId) return json({ error: "invalid_request" }, 400, origin);
      if (Number(reg.paid_entry) === 1) {
        return reg.payment_ref === orderId ? json({ registration: reg }, 200, origin) : json({ error: "already_paid" }, 409, origin);
      }
      const expected = tournamentOwed(cfg, reg) + Number(reg.fee_cents ?? 0) + Number(reg.donation_cents ?? 0);
      // Hold the spot before charging (two players can't both buy the last one), then the order id (no double charge).
      if (isTournament(cfg) && !(await tdb.claimSpot(env.DB, reg.id, eventId, cfg.player_cap ?? null))) {
        await tdb.moveToWaitlist(env.DB, reg.id);
        return json({ error: "field_full" }, 409, origin);
      }
      if (!(await db.reserveCapture(env.DB, reg.id, orderId))) {
        await tdb.releaseSpot(env.DB, reg.id);
        return json({ error: "capture_in_progress" }, 409, origin);
      }
      let captured;
      try {
        captured = await ppCaptureOrder(creds, orderId);
      } catch (error) {
        await db.releaseCapture(env.DB, reg.id, orderId);
        await tdb.releaseSpot(env.DB, reg.id);
        throw error;
      }
      if (!isCaptureSettled(captured, expected)) {
        await db.releaseCapture(env.DB, reg.id, orderId);
        await tdb.releaseSpot(env.DB, reg.id);
        return json({ error: "payment_incomplete" }, 402, origin);
      }
      const row = await tdb.markTournamentPaid(env.DB, reg.id, { ref: orderId, amountCents: captured.amountCents, paidAt: new Date().toISOString(), method: "paypal" });
      return json({ registration: row ?? (await db.getRegistration(env.DB, reg.id)) }, 200, origin);
    }
  } catch (error) {
    return json({ error: "paypal_error", reason: String(error instanceof Error ? error.message : error) }, 502, origin);
  }
  return null;
}

/** Admin: /admin/events/:id/tournament (GET, PUT), /admin/events/:id/registrations/:rid/{zelle-received,offer}, /admin/pdga-events/:id. */
export async function handleTournamentAdmin(request: Request, env: Env, origin: string | null, method: string, seg: string[]): Promise<Response | null> {
  if (seg[1] === "pdga-events" && method === "GET") {
    const pdgaId = asInt(seg[2]);
    if (pdgaId == null || pdgaId <= 0) return json({ error: "invalid_pdga_event" }, 400, origin);
    if (!pdgaApiConfigured(apiEnv(env))) return json({ error: "pdga_unavailable" }, 503, origin);
    try {
      const event = await lookupPdgaEvent(apiEnv(env), pdgaId);
      return event ? json({ event, attribution: PDGA_ATTRIBUTION }, 200, origin) : json({ error: "pdga_event_not_found" }, 404, origin);
    } catch {
      return json({ error: "pdga_unavailable" }, 503, origin);
    }
  }
  if (seg[1] !== "events") return null;
  const eventId = asInt(seg[2]);
  if (eventId == null) return null;
  // The event form's "PDGA-sanctioned event": link (or unlink) only the PDGA event; the rest of the settings stay.
  if (seg[3] === "pdga" && method === "PATCH") {
    const body = (await readJson(request)) ?? {};
    const pdgaEventId = body.pdgaEventId == null || body.pdgaEventId === "" ? null : asInt(body.pdgaEventId);
    if (body.pdgaEventId != null && body.pdgaEventId !== "" && (pdgaEventId == null || pdgaEventId <= 0)) return json({ error: "invalid_pdga_event" }, 400, origin);
    if ((await db.getEventStatus(env.DB, eventId)) == null) return json({ error: "not_found" }, 404, origin);
    let pdgaEvent: string | null = null;
    if (pdgaEventId != null && pdgaApiConfigured(apiEnv(env))) {
      try {
        const info = await lookupPdgaEvent(apiEnv(env), pdgaEventId);
        if (!info) return json({ error: "pdga_event_not_found" }, 404, origin);
        pdgaEvent = JSON.stringify(info);
      } catch { /* keep the number; the details are read when the settings are next saved */ }
    }
    const row = await env.DB.prepare(`INSERT INTO event_config (event_id, pdga_event_id, pdga_event) VALUES (?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET pdga_event_id = excluded.pdga_event_id,
          pdga_event = CASE WHEN excluded.pdga_event_id IS NULL THEN NULL ELSE COALESCE(excluded.pdga_event, event_config.pdga_event) END
        RETURNING pdga_event_id, pdga_event`).bind(eventId, pdgaEventId, pdgaEvent).first<{ pdga_event_id: number | null; pdga_event: string | null }>();
    let info: unknown = null;
    try { info = row?.pdga_event ? JSON.parse(row.pdga_event) : null; } catch { info = null; }
    return json({ pdgaEventId: row?.pdga_event_id ?? null, pdgaEvent: info }, 200, origin);
  }
  if (seg[3] === "tournament" && method === "GET") {
    const cfg = (await db.getEventConfig(env.DB, eventId)) as TournamentConfig | null;
    return json({ settings: cfg ? tournamentSettingsView(cfg) : null }, 200, origin);
  }
  if (seg[3] === "tournament" && method === "PUT") {
    const body = (await readJson(request)) ?? {};
    const pdgaEventId = body.pdgaEventId == null || body.pdgaEventId === "" ? null : asInt(body.pdgaEventId);
    if (body.pdgaEventId != null && body.pdgaEventId !== "" && (pdgaEventId == null || pdgaEventId <= 0)) return json({ error: "invalid_pdga_event" }, 400, origin);
    const rules = tournamentRulesInput(body.rules ?? {});
    if (!rules) return json({ error: "invalid_rules" }, 400, origin);
    const cap = body.playerCap == null || body.playerCap === "" ? null : asInt(body.playerCap);
    if (body.playerCap != null && body.playerCap !== "" && (cap == null || cap <= 0 || cap > 1000)) return json({ error: "invalid_cap" }, 400, origin);
    const tdEmail = asStr(body.tdEmail, 120);
    if (tdEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tdEmail)) return json({ error: "invalid_td_email" }, 400, origin);
    const zelleTo = asStr(body.zelleTo, 120);
    let pdgaEvent: string | null = null;
    if (pdgaEventId != null && pdgaApiConfigured(apiEnv(env))) {
      try {
        const info = await lookupPdgaEvent(apiEnv(env), pdgaEventId);
        if (!info) return json({ error: "pdga_event_not_found" }, 404, origin);
        pdgaEvent = JSON.stringify(info);
      } catch { /* keep the number; the event's details are read next time */ }
    }
    const row = await tdb.saveTournamentSettings(env.DB, eventId, {
      pdga_event_id: pdgaEventId, pdga_event: pdgaEvent, pdga_rules: JSON.stringify(rules), player_cap: cap,
      paypal_fee_passthrough: body.paypalFeePassthrough === true ? 1 : 0, zelle_to: zelleTo, zelle_name: zelleTo ? asStr(body.zelleName, 80) : null,
      td_email: tdEmail,
    });
    return json({ settings: row ? tournamentSettingsView(row as TournamentConfig) : null }, 200, origin);
  }
  if (seg[3] === "registrations" && method === "POST" && seg[4] != null) {
    const registrationId = asInt(seg[4]);
    if (registrationId == null) return json({ error: "not_found" }, 404, origin);
    const reg = (await db.getRegistration(env.DB, registrationId)) as Reg | null;
    if (!reg || Number(reg.event_id) !== eventId) return json({ error: "not_found" }, 404, origin);
    const cfg = ((await db.getEventConfig(env.DB, eventId)) ?? {}) as TournamentConfig;
    if (seg[5] === "offer") {
      const row = await tdb.offerSpot(env.DB, eventId, registrationId);
      return row ? json({ registration: row }, 200, origin) : json({ error: "not_waitlisted" }, 409, origin);
    }
    if (seg[5] === "zelle-received") {
      if (Number(reg.paid_entry) === 1) return json({ error: "already_paid" }, 409, origin);
      const body = (await readJson(request)) ?? {};
      const received = asStr(body.receivedAt, 40);
      const paidAt = received && !Number.isNaN(Date.parse(received)) ? new Date(received).toISOString() : new Date().toISOString();
      if (isTournament(cfg) && !(await tdb.spotOpen(env.DB, registrationId, eventId, cfg.player_cap ?? null))) {
        return json({ error: "field_full" }, 409, origin);
      }
      const amount = tournamentOwed(cfg, reg) + Number(reg.donation_cents ?? 0);
      const row = await tdb.markTournamentPaid(env.DB, registrationId, { ref: "zelle:" + (reg.zelle_code ?? registrationId), amountCents: amount, paidAt, method: "zelle" });
      return row ? json({ registration: row }, 200, origin) : json({ error: "already_paid" }, 409, origin);
    }
  }
  return null;
}

function tournamentSettingsView(cfg: TournamentConfig) {
  let pdgaEvent: unknown = null;
  try { pdgaEvent = cfg.pdga_event ? JSON.parse(cfg.pdga_event) : null; } catch { pdgaEvent = null; }
  return {
    pdgaEventId: cfg.pdga_event_id ?? null, pdgaEvent, rules: parseTournamentRules(cfg.pdga_rules ?? null), playerCap: cfg.player_cap ?? null,
    paypalFeePassthrough: Number(cfg.paypal_fee_passthrough) === 1, zelleTo: cfg.zelle_to ?? null, zelleName: cfg.zelle_name ?? null,
    tdEmail: cfg.td_email ?? null,
    divisions: (() => { try { const list = JSON.parse(cfg.divisions || "[]"); return Array.isArray(list) ? list.filter((item) => typeof item === "string") : []; } catch { return []; } })(),
  };
}
