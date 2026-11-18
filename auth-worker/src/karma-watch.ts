// Watching round karma for gaming (the owner's rule). Every round finished in the app earns +1 karma; a member who
// finishes more than ROUNDS_PER_DAY rounds in one day (club time) is flagged once for that day, and the admins get a
// push and a badge. In Admin > Lost & Found > Unusual karma, an admin either clears the flag ("Looks fine") or finds
// them gaming: that day's round karma is taken back and 3x as much again is taken as a penalty (karma_adjustments,
// append-only, with the admin and the reason), and the member is told. A total can go below zero; it shows as "✦ −8".
//
// runKarmaWatch runs on the 15-minute cron and looks back two days (an offline round can sync a little late).
//   POST /admin/lost-found/karma-flags/:id/clear     { reason }
//   POST /admin/lost-found/karma-flags/:id/penalize  { reason }
//   POST /admin/lost-found/karma-flags/:id/undo      { reason }   (a penalty: gives it all back)
import { notifyAdmins } from "./admin-push.js";
import { IMPORTED_RESULT_SOURCES } from "./karma-directory.js";
import type { Env } from "./env.js";
import { notifyPerson } from "./lf-notify.js";
import { fail, ok, type MarketCtx } from "./market-http.js";
import { getMember } from "./roster.js";

export const ROUNDS_PER_DAY = 3;
export const PENALTY_MULTIPLIER = 3;
const CLUB_TIME_ZONE = "America/New_York";

/** "2026-11-18" for a stored time ("2026-11-18 22:10:00" UTC, or ISO), in the club's time zone; "" if unreadable. */
export function clubDayOf(stored: string | null | undefined): string {
  const text = String(stored || "").trim();
  if (!text) return "";
  const at = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(" ", "T") + "Z");
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** "Sat, Nov 14" for a club day ("2026-11-14"). */
export function dayLabel(day: string): string {
  const at = Date.parse(day + "T12:00:00Z");
  if (!Number.isFinite(at)) return day;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(at));
}

interface RoundRow { member_id: string; at: string }

/**
 * Finished app rounds (the same ones that earn karma) since `since`, each with the server's time for it: when a casual
 * round or event was finalized, and when an offline round reached the server (its own finish time comes from the
 * phone, so a backlog dated across many past days still counts on the day it arrived).
 */
async function recentRounds(env: Env, since: string, memberId: string | null = null): Promise<RoundRow[]> {
  const only = (column: string) => (memberId ? ` AND ${column} = ?` : "");
  const sql = `
    SELECT cr.member_id, c.finalized_at AS at FROM casual_results cr JOIN casual_rounds c ON c.id = cr.casual_round_id
      WHERE c.finalized_at >= ? AND substr(cr.member_id, 1, 2) = 'm_' AND cr.place IS NOT NULL${only("cr.member_id")}
    UNION ALL
    SELECT r.member_id, r.created_at AS at FROM results r JOIN events e ON e.id = r.event_id
      WHERE r.created_at >= ? AND e.source NOT IN ${IMPORTED_RESULT_SOURCES} AND e.status = 'final' AND substr(r.member_id, 1, 2) = 'm_' AND r.place IS NOT NULL${only("r.member_id")}
    UNION ALL
    SELECT o.owner_id AS member_id, o.created_at AS at FROM offline_rounds o
      WHERE o.created_at >= ? AND o.owner_kind = 'member'${only("o.owner_id")}`;
  const binds = memberId ? [since, memberId, since, memberId, since, memberId] : [since, since, since];
  return (await env.DB.prepare(sql).bind(...binds).all<RoundRow>()).results ?? [];
}

function sqlTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** Flag every member who finished more than ROUNDS_PER_DAY rounds on a day in the last two; alert the admins once. */
export async function runKarmaWatch(env: Env, now = Date.now(), ctx: { waitUntil?: (p: Promise<unknown>) => void } | null = null) {
  const rows = await recentRounds(env, sqlTime(now - 3 * 86_400_000));
  const perDay = new Map<string, { memberId: string; day: string; rounds: number }>();
  for (const row of rows) {
    const day = clubDayOf(row.at);
    if (!day) continue;
    const key = row.member_id + "|" + day;
    const entry = perDay.get(key) ?? { memberId: row.member_id, day, rounds: 0 };
    entry.rounds += 1;
    perDay.set(key, entry);
  }
  let flagged = 0;
  for (const entry of perDay.values()) {
    if (entry.rounds <= ROUNDS_PER_DAY) continue;
    const created = await env.DB.prepare(
      "INSERT INTO karma_flags (member_id, day, rounds) VALUES (?, ?, ?) ON CONFLICT(member_id, day) DO NOTHING RETURNING id",
    ).bind(entry.memberId, entry.day, entry.rounds).first<{ id: number }>();
    if (!created) {
      // Already flagged: keep the count current while an admin hasn't looked yet.
      await env.DB.prepare("UPDATE karma_flags SET rounds = ? WHERE member_id = ? AND day = ? AND status = 'open' AND rounds < ?")
        .bind(entry.rounds, entry.memberId, entry.day, entry.rounds).run();
      continue;
    }
    flagged += 1;
    const member = await getMember(env.ROSTER, entry.memberId).catch(() => null);
    notifyAdmins(ctx ?? {}, env, {
      title: "Unusual karma",
      body: `${member?.name || "A member"} finished ${entry.rounds} rounds on ${dayLabel(entry.day)} (more than ${ROUNDS_PER_DAY} a day). Please review it.`,
      url: "/admin.html#lost-found",
      tag: "karma-flag:" + created.id,
    });
  }
  return { rounds: rows.length, flagged };
}

/** Open flags for the admin list (with names), oldest first. */
export async function openKarmaFlags(env: Env) {
  const rows = (await env.DB.prepare(
    "SELECT id, member_id, day, rounds, created_at FROM karma_flags WHERE status = 'open' ORDER BY created_at, id LIMIT 50",
  ).all<{ id: number; member_id: string; day: string; rounds: number; created_at: string }>()).results ?? [];
  return Promise.all(rows.map(async (row) => {
    const member = await getMember(env.ROSTER, row.member_id).catch(() => null);
    return {
      id: row.id, name: member?.name || "Member", day: row.day, dayLabel: dayLabel(row.day), rounds: row.rounds, createdAt: row.created_at,
      removes: row.rounds, penalty: row.rounds * PENALTY_MULTIPLIER,
    };
  }));
}

/** Penalties of the last 60 days, newest first, so an admin can undo one. */
export async function recentKarmaPenalties(env: Env) {
  const rows = (await env.DB.prepare(
    `SELECT f.id, f.member_id, f.day, f.rounds, f.reviewed_at, f.reviewed_by, f.review_note,
            (SELECT -SUM(a.delta) FROM karma_adjustments a WHERE a.flag_id = f.id) AS taken
     FROM karma_flags f WHERE f.status = 'penalized' AND f.reviewed_at >= datetime('now', '-60 days')
     ORDER BY f.reviewed_at DESC, f.id DESC LIMIT 20`,
  ).all<{ id: number; member_id: string; day: string; rounds: number; reviewed_at: string; reviewed_by: string; review_note: string; taken: number }>()).results ?? [];
  return Promise.all(rows.map(async (row) => {
    const [member, admin] = await Promise.all([
      getMember(env.ROSTER, row.member_id).catch(() => null), getMember(env.ROSTER, row.reviewed_by).catch(() => null),
    ]);
    return {
      id: row.id, name: member?.name || "Member", day: row.day, dayLabel: dayLabel(row.day), rounds: row.rounds,
      taken: Number(row.taken) || 0, reviewedAt: row.reviewed_at, admin: admin?.name || "Admin", note: row.review_note,
    };
  }));
}

/** Undo a penalty: one entry gives back everything the flag took (the rounds and the penalty), and the member is told. */
export async function undoKarmaPenalty(c: MarketCtx, adminId: string, id: number, reason: string): Promise<Response> {
  const flag = await c.env.DB.prepare("SELECT id, member_id, day FROM karma_flags WHERE id = ? AND status = 'penalized'")
    .bind(id).first<{ id: number; member_id: string; day: string }>();
  if (!flag) return fail(c, 409, "not_penalized");
  const taken = Number((await c.env.DB.prepare("SELECT -SUM(delta) AS taken FROM karma_adjustments WHERE flag_id = ?").bind(id)
    .first<{ taken: number }>())?.taken) || 0;
  const result = await c.env.DB.prepare(
    "UPDATE karma_flags SET status = 'undone', reviewed_at = datetime('now'), reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'penalized'",
  ).bind(adminId, reason.slice(0, 200), id).run();
  if (!Number(result.meta?.changes)) return fail(c, 409, "not_penalized");
  if (taken > 0) {
    await c.env.DB.prepare("INSERT INTO karma_adjustments (member_id, delta, reason, flag_id, admin_id, note) VALUES (?, ?, 'penalty_undone', ?, ?, ?)")
      .bind(flag.member_id, taken, id, adminId, reason.slice(0, 200)).run();
    notifyPerson(c.env, c.ctx, flag.member_id, {
      title: "Karma restored",
      body: `A club admin took another look at your rounds on ${dayLabel(flag.day)} and gave back the ${taken} karma that was removed. Sorry about that!`,
      refKey: "karma-flag:" + id + ":undone", hash: "mine",
    });
  }
  return ok(c, { ok: true, restored: taken });
}

export async function openKarmaFlagCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM karma_flags WHERE status = 'open'").first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * An admin's decision on a flag. "clear": it looks fine. "penalize": that day's round karma (the rounds counted on the
 * flag, refreshed now) is taken back, and PENALTY_MULTIPLIER times as much is taken as a penalty.
 */
export async function reviewKarmaFlag(c: MarketCtx, adminId: string, id: number, decision: "clear" | "penalize", reason: string): Promise<Response> {
  const flag = await c.env.DB.prepare("SELECT id, member_id, day, rounds FROM karma_flags WHERE id = ? AND status = 'open'")
    .bind(id).first<{ id: number; member_id: string; day: string; rounds: number }>();
  if (!flag) return fail(c, 409, "not_open");
  let rounds = flag.rounds;
  if (decision === "penalize") {
    const dayRounds = (await recentRounds(c.env, sqlTime(Date.parse(flag.day + "T00:00:00Z") - 86_400_000), flag.member_id))
      .filter((row) => clubDayOf(row.at) === flag.day).length;
    rounds = Math.max(flag.rounds, dayRounds);
  }
  const result = await c.env.DB.prepare(
    "UPDATE karma_flags SET status = ?, rounds = ?, reviewed_at = datetime('now'), reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'open'",
  ).bind(decision === "penalize" ? "penalized" : "cleared", rounds, adminId, reason.slice(0, 200), id).run();
  if (!Number(result.meta?.changes)) return fail(c, 409, "not_open");
  if (decision === "penalize") {
    const penalty = rounds * PENALTY_MULTIPLIER;
    await c.env.DB.prepare(
      `INSERT INTO karma_adjustments (member_id, delta, reason, flag_id, admin_id, note) VALUES
       (?, ?, 'rounds_removed', ?, ?, ?), (?, ?, 'gaming_penalty', ?, ?, ?)`,
    ).bind(flag.member_id, -rounds, id, adminId, reason.slice(0, 200), flag.member_id, -penalty, id, adminId, reason.slice(0, 200)).run();
    notifyPerson(c.env, c.ctx, flag.member_id, {
      title: "Karma adjusted",
      body: `A club admin reviewed your ${rounds} rounds on ${dayLabel(flag.day)} and took back their ${rounds} karma, plus a ${penalty} karma penalty for gaming the system. Contact a club admin if this is a mistake.`,
      refKey: "karma-flag:" + id + ":penalized", hash: "mine",
    });
  }
  return ok(c, { ok: true, removed: decision === "penalize" ? rounds : 0, penalty: decision === "penalize" ? rounds * PENALTY_MULTIPLIER : 0 });
}
