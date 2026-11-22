import type { D1Like, D1StatementLike } from "./db-types.js";

export interface RegistrationInput {
  event_id: number;
  member_id: string;
  name: string;
  division?: string | null;
  team?: string | null;
  addons?: string | null;
  email?: string | null;
  paid_entry?: number | null;
}

export async function getMyRegistration(db: D1Like, eventId: number, memberId: string) {
  return db.prepare("SELECT * FROM registrations WHERE event_id = ? AND member_id = ?").bind(eventId, memberId).first();
}

// A member's registrations joined with the event they're for, so the dashboard can show EVERY event a
// player signed up for — not just the ones still open for registration. Event columns are aliased
// (event_name/event_date/…) so they never collide with the registration's own name/division/etc.
export async function listMyRegistrations(db: D1Like, memberId: string) {
  return (
    await db
      .prepare(
        `SELECT r.*,
                e.name AS event_name, e.date AS event_date, e.status AS event_status,
                e.starts_at AS event_starts_at,
                e.registration_deadline AS event_registration_deadline,
                e.checkin_deadline AS event_checkin_deadline,
                c.name AS course_name, l.name AS layout_name,
                ec.pdga_event_id AS pdga_event_id
         FROM registrations r
         LEFT JOIN events e ON e.id = r.event_id
         LEFT JOIN courses c ON c.id = e.course_id
         LEFT JOIN course_layouts l ON l.id = e.layout_id
         LEFT JOIN event_config ec ON ec.event_id = r.event_id
         WHERE r.member_id = ?
         ORDER BY COALESCE(e.date, '') DESC, r.event_id DESC`,
      )
      .bind(memberId)
      .all()
  ).results;
}

export async function listRegistrations(db: D1Like, eventId: number) {
  return (await db.prepare("SELECT * FROM registrations WHERE event_id = ? ORDER BY division, name").bind(eventId).all()).results;
}

export async function registerForEvent(db: D1Like, r: RegistrationInput) {
  return db
    .prepare(
      `INSERT INTO registrations (event_id, member_id, name, division, team, addons, email) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO UPDATE SET name=excluded.name, division=excluded.division, team=excluded.team, addons=excluded.addons, email=COALESCE(excluded.email, registrations.email)
       RETURNING *`,
    )
    .bind(r.event_id, r.member_id, r.name, r.division ?? null, r.team ?? null, r.addons ?? null, r.email ?? null)
    .first();
}

/** Admin cash-signup insert. paid_entry is written with the row so a batch of N members is one D1
 *  round-trip (plus the roster reads), not N inserts + N paid updates. ON CONFLICT is a no-op so a
 *  concurrent self-register is not overwritten. */
export function registerMemberStmt(db: D1Like, r: RegistrationInput): D1StatementLike {
  const paid = r.paid_entry ? 1 : 0;
  return db
    .prepare(
      `INSERT INTO registrations (event_id, member_id, name, division, team, addons, email, paid_entry, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, member_id) DO NOTHING`,
    )
    .bind(r.event_id, r.member_id, r.name, r.division ?? null, r.team ?? null, r.addons ?? null, r.email ?? null, paid, paid ? new Date().toISOString() : null);
}

export async function withdrawRegistration(db: D1Like, eventId: number, memberId: string) {
  await db.prepare("DELETE FROM registrations WHERE event_id = ? AND member_id = ?").bind(eventId, memberId).run();
}

export async function adminDeleteRegistration(db: D1Like, eventId: number, registrationId: number) {
  return db
    .prepare("DELETE FROM registrations WHERE id = ? AND event_id = ? RETURNING *")
    .bind(registrationId, eventId)
    .first();
}

export async function setCheckedIn(db: D1Like, eventId: number, memberId: string, val: boolean) {
  return db.prepare("UPDATE registrations SET checked_in = ? WHERE event_id = ? AND member_id = ? RETURNING *").bind(val ? 1 : 0, eventId, memberId).first();
}

export async function getRegistration(db: D1Like, id: number) {
  return db.prepare("SELECT * FROM registrations WHERE id = ?").bind(id).first();
}

export async function markRegistrationPaid(db: D1Like, id: number, paymentRef: string, amountCents: number) {
  return db
    .prepare("UPDATE registrations SET paid_entry = 1, payment_ref = ?, amount_paid_cents = ? WHERE id = ? AND paid_entry = 0 RETURNING *")
    .bind(paymentRef, amountCents, id)
    .first();
}

export async function reserveCapture(db: D1Like, id: number, paymentRef: string): Promise<boolean> {
  const row = await db
    .prepare("UPDATE registrations SET payment_ref = ? WHERE id = ? AND paid_entry = 0 AND (payment_ref IS NULL OR payment_ref = ?) RETURNING id")
    .bind(paymentRef, id, paymentRef)
    .first();
  return row != null;
}

export async function releaseCapture(db: D1Like, id: number, paymentRef: string): Promise<void> {
  await db.prepare("UPDATE registrations SET payment_ref = NULL WHERE id = ? AND paid_entry = 0 AND payment_ref = ?").bind(id, paymentRef).run();
}

export async function adminUpdateRegistration(
  db: D1Like,
  id: number,
  p: { division?: string | null; team?: string | null; starting_hole?: number | null; checked_in?: number | null; paid_entry?: number | null },
) {
  return db
    .prepare(
      // Marking paid records when and clears waitlist/claim flags; unmarking clears paid_at.
      `UPDATE registrations SET division=COALESCE(?,division), team=COALESCE(?,team), starting_hole=COALESCE(?,starting_hole),
        checked_in=COALESCE(?,checked_in), paid_at = CASE WHEN ? IS NULL THEN paid_at WHEN ? = 1 THEN COALESCE(paid_at, ?) ELSE NULL END,
        waitlisted = CASE WHEN ? = 1 THEN 0 ELSE waitlisted END,
        spot_claimed_at = CASE WHEN ? = 1 THEN NULL ELSE spot_claimed_at END,
        paid_entry=COALESCE(?,paid_entry) WHERE id=? RETURNING *`,
    )
    .bind(p.division ?? null, p.team ?? null, p.starting_hole ?? null, p.checked_in ?? null, p.paid_entry ?? null, p.paid_entry ?? null,
      new Date().toISOString(), p.paid_entry ?? null, p.paid_entry ?? null, p.paid_entry ?? null, id)
    .first();
}

export async function batchUpdateRegistrations(
  db: D1Like,
  updates: readonly { id: number; starting_hole?: number | null; team?: string | null }[],
): Promise<void> {
  if (!updates.length) return;
  const stmts = updates.map((u) =>
    db.prepare(
      "UPDATE registrations SET starting_hole=CASE WHEN ? THEN ? ELSE starting_hole END, team=CASE WHEN ? THEN ? ELSE team END WHERE id=?",
    ).bind(
      u.starting_hole !== undefined ? 1 : 0, u.starting_hole ?? null,
      u.team !== undefined ? 1 : 0, u.team ?? null,
      u.id,
    ),
  );
  for (let i = 0; i < stmts.length; i += 45) {
    const chunk = stmts.slice(i, i + 45);
    if (typeof db.batch === "function") await db.batch(chunk);
    else for (const stmt of chunk) await stmt.run();
  }
}
