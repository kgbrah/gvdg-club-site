// D1 for club-run PDGA events (tournament registration): the field, spot claims, the waitlist and payments.
// "Used" spots are paid entries, PayPal payments in progress (a 15-minute claim) and waitlist offers not yet paid
// (48 hours). Each check and change is one statement, so two players can't both take the last spot.

import type { D1Like } from "./db-types.js";

export const CLAIM_MINUTES = 15;
export const OFFER_HOURS = 48;

const cutoff = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

/** Spots used by registrations other than `selfId` (SQL with 4 binds: event, self, claim cutoff, offer cutoff). */
const USED_BY_OTHERS = `(SELECT COUNT(*) FROM registrations o WHERE o.event_id = ? AND o.id != ? AND (
    o.paid_entry = 1
    OR (o.spot_claimed_at IS NOT NULL AND o.spot_claimed_at > ?)
    OR (o.offered_at IS NOT NULL AND o.waitlisted = 0 AND o.paid_entry = 0 AND o.offered_at > ?)))`;

function usedBinds(eventId: number, selfId: number, now: Date) {
  return [eventId, selfId, cutoff(now, CLAIM_MINUTES), cutoff(now, OFFER_HOURS * 60)];
}

export type TournamentRegistrationInput = {
  event_id: number;
  member_id: string;
  name: string;
  division: string | null;
  team: string | null;
  addons: string | null;
  email: string | null;
  pdga_number: string | null;
  pdga_status: string | null;
  pdga_rating: number | null;
};

/**
 * Sign a player up (or update their sign-up). A new sign-up joins the waitlist when the published cap is already
 * used; an existing one keeps its place.
 */
export async function registerTournamentPlayer(db: D1Like, input: TournamentRegistrationInput, cap: number | null, now = new Date()) {
  const at = now.toISOString();
  const full = cap == null ? "0" : `(${USED_BY_OTHERS} >= ?)`;
  const fullBinds = cap == null ? [] : [...usedBinds(input.event_id, -1, now), cap];
  return db.prepare(
    `INSERT INTO registrations (event_id, member_id, name, division, team, addons, email, pdga_number, pdga_status, pdga_rating,
        pdga_checked_at, waitlisted, waitlisted_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${full}, CASE WHEN ${full} THEN ? END WHERE true
     ON CONFLICT(event_id, member_id) DO UPDATE SET name = excluded.name, division = excluded.division, team = excluded.team,
       addons = excluded.addons, email = COALESCE(excluded.email, registrations.email), pdga_number = excluded.pdga_number,
       pdga_status = excluded.pdga_status, pdga_rating = excluded.pdga_rating, pdga_checked_at = excluded.pdga_checked_at
     RETURNING *`,
  ).bind(
    input.event_id, input.member_id, input.name, input.division, input.team, input.addons, input.email, input.pdga_number,
    input.pdga_status, input.pdga_rating, input.pdga_status ? at : null, ...fullBinds, ...fullBinds, at,
  ).first<Record<string, unknown>>();
}

/** Hold a spot for a payment about to be charged; false when the field is full (or the player is waitlisted). */
export async function claimSpot(db: D1Like, registrationId: number, eventId: number, cap: number | null, now = new Date()): Promise<boolean> {
  const at = now.toISOString();
  const row = cap == null
    ? await db.prepare(`UPDATE registrations SET spot_claimed_at = ? WHERE id = ? AND paid_entry = 0 AND waitlisted = 0 RETURNING id`)
      .bind(at, registrationId).first()
    : await db.prepare(`UPDATE registrations SET spot_claimed_at = ? WHERE id = ? AND paid_entry = 0 AND waitlisted = 0
        AND ${USED_BY_OTHERS} < ? RETURNING id`).bind(at, registrationId, ...usedBinds(eventId, registrationId, now), cap).first();
  return row != null;
}

export async function releaseSpot(db: D1Like, registrationId: number) {
  await db.prepare("UPDATE registrations SET spot_claimed_at = NULL WHERE id = ? AND paid_entry = 0").bind(registrationId).run();
}

/** Whether a spot is open for this registration right now (for a Zelle payment an admin is confirming). */
export async function spotOpen(db: D1Like, registrationId: number, eventId: number, cap: number | null, now = new Date()): Promise<boolean> {
  if (cap == null) return true;
  const row = await db.prepare(`SELECT ${USED_BY_OTHERS} AS used`).bind(...usedBinds(eventId, registrationId, now)).first<{ used: number }>();
  return Number(row?.used ?? 0) < cap;
}

/** The player's payment choice before paying: method, the fee they cover, their gift, and a Zelle memo code. */
export async function setPaymentChoice(db: D1Like, registrationId: number, choice: { method: string; feeCents: number; donationCents: number; zelleCode?: string | null }) {
  return db.prepare(`UPDATE registrations SET payment_method = ?, fee_cents = ?, donation_cents = ?, zelle_code = COALESCE(?, zelle_code)
      WHERE id = ? AND paid_entry = 0 RETURNING *`)
    .bind(choice.method, choice.feeCents, choice.donationCents, choice.zelleCode ?? null, registrationId).first<Record<string, unknown>>();
}

export async function markZelleSent(db: D1Like, registrationId: number, now = new Date()) {
  return db.prepare(`UPDATE registrations SET zelle_sent_at = ? WHERE id = ? AND paid_entry = 0 AND payment_method = 'zelle' RETURNING *`)
    .bind(now.toISOString(), registrationId).first<Record<string, unknown>>();
}

/** Entered: paid, with when the fee was received (the field's order) and how. */
export async function markTournamentPaid(db: D1Like, registrationId: number, paid: { ref: string; amountCents: number; paidAt: string; method: string }) {
  return db.prepare(`UPDATE registrations SET paid_entry = 1, payment_ref = ?, amount_paid_cents = ?, paid_at = ?, payment_method = ?,
      spot_claimed_at = NULL, waitlisted = 0 WHERE id = ? AND paid_entry = 0 RETURNING *`)
    .bind(paid.ref, paid.amountCents, paid.paidAt, paid.method, registrationId).first<Record<string, unknown>>();
}

/** The field was full when they paid or tried to: to the end of the waitlist. */
export async function moveToWaitlist(db: D1Like, registrationId: number, now = new Date()) {
  await db.prepare(`UPDATE registrations SET waitlisted = 1, waitlisted_at = ?, offered_at = NULL, spot_claimed_at = NULL
      WHERE id = ? AND paid_entry = 0`).bind(now.toISOString(), registrationId).run();
}

/** An admin offers a waitlisted player an open spot; it's held for them for OFFER_HOURS. */
export async function offerSpot(db: D1Like, eventId: number, registrationId: number, now = new Date()) {
  return db.prepare(`UPDATE registrations SET waitlisted = 0, offered_at = ? WHERE id = ? AND event_id = ? AND waitlisted = 1 AND paid_entry = 0
      RETURNING *`).bind(now.toISOString(), registrationId, eventId).first<Record<string, unknown>>();
}

export type PublicField = {
  paid: { name: string; division: string | null }[];
  waitlist: { position: number; name: string; division: string | null }[];
  used: number;
  /** The asking registration's place on the waitlist (1-based), when it's on it. */
  position: number | null;
};

/** The published lists (PDGA 1.02.7–8): paid players in field order, and the waitlist in order. */
export async function publicField(db: D1Like, eventId: number, now = new Date(), registrationId: number | null = null): Promise<PublicField> {
  const rows = (await db.prepare(`SELECT id, name, division, paid_entry, paid_at, pdga_number, waitlisted, waitlisted_at, spot_claimed_at, offered_at
      FROM registrations WHERE event_id = ?`).bind(eventId).all<Record<string, unknown>>()).results ?? [];
  const claim = cutoff(now, CLAIM_MINUTES);
  const offer = cutoff(now, OFFER_HOURS * 60);
  const paid = rows.filter((row) => Number(row.paid_entry) === 1).sort((a, b) => {
    const at = String(a.paid_at ?? "￿").localeCompare(String(b.paid_at ?? "￿"));
    return at || (Number(a.pdga_number) || Number.MAX_SAFE_INTEGER) - (Number(b.pdga_number) || Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id);
  });
  const waitlist = rows.filter((row) => Number(row.waitlisted) === 1 && Number(row.paid_entry) !== 1)
    .sort((a, b) => String(a.waitlisted_at ?? "").localeCompare(String(b.waitlisted_at ?? "")) || Number(a.id) - Number(b.id));
  const used = rows.filter((row) => Number(row.paid_entry) === 1
    || (row.spot_claimed_at != null && String(row.spot_claimed_at) > claim)
    || (row.offered_at != null && Number(row.waitlisted) === 0 && String(row.offered_at) > offer)).length;
  return {
    paid: paid.map((row) => ({ name: String(row.name), division: (row.division as string | null) ?? null })),
    waitlist: waitlist.map((row, index) => ({ position: index + 1, name: String(row.name), division: (row.division as string | null) ?? null })),
    used,
    position: registrationId == null ? null : (waitlist.findIndex((row) => Number(row.id) === registrationId) + 1) || null,
  };
}

export type TournamentSettings = {
  pdga_event_id: number | null;
  pdga_event: string | null;
  pdga_rules: string;
  player_cap: number | null;
  paypal_fee_passthrough: number;
  zelle_to: string | null;
  zelle_name: string | null;
  td_email: string | null;
};

export async function saveTournamentSettings(db: D1Like, eventId: number, settings: TournamentSettings) {
  return db.prepare(`INSERT INTO event_config (event_id, pdga_event_id, pdga_event, pdga_rules, player_cap, paypal_fee_passthrough, zelle_to, zelle_name, td_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET pdga_event_id = excluded.pdga_event_id, pdga_event = excluded.pdga_event,
        pdga_rules = excluded.pdga_rules, player_cap = excluded.player_cap, paypal_fee_passthrough = excluded.paypal_fee_passthrough,
        zelle_to = excluded.zelle_to, zelle_name = excluded.zelle_name, td_email = excluded.td_email
      RETURNING *`)
    .bind(eventId, settings.pdga_event_id, settings.pdga_event, settings.pdga_rules, settings.player_cap, settings.paypal_fee_passthrough,
      settings.zelle_to, settings.zelle_name, settings.td_email)
    .first<Record<string, unknown>>();
}
