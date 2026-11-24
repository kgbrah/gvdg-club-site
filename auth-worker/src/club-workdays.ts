// Club workday organizer: admin announces workdays + karma rewards, active members get notified and sign up
// on Member Home (with a live signed-up roster), checked-in participants verify GPS on site, and admins confirm
// attendance to award the posted karma.
import type { Env } from "./env.js";
import { requireMember } from "./authz.js";
import { notifyAdmins } from "./admin-push.js";
import { haversineFeet } from "./distance.js";
import { json, readJson } from "./http.js";
import { asInt, asNum, asStr } from "./input.js";
import { bustKarmaCache, karmaKey } from "./karma-directory.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { recordMemberNotices } from "./member-messages.js";
import { notifyAllSubscribedMembers, notifyMembers } from "./member-push.js";
import { easternMonthDay } from "./membership-year.js";
import { getMember, listMembers } from "./roster.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export const WORKDAY_STATUSES = ["open", "active", "completed", "cancelled"] as const;
export type WorkdayStatus = (typeof WORKDAY_STATUSES)[number];
export type SignupStatus = "signed_up" | "checked_in" | "verified" | "no_show";

const DEFAULT_RADIUS_FT = 2000;
const MIN_RADIUS_FT = 100;
const MAX_RADIUS_FT = 26400;
const DEFAULT_KARMA = 25;
const MAX_KARMA = 500;
const COMPLETED_VISIBLE_DAYS = 7;

export interface WorkdayRow {
  id: number;
  title: string;
  description: string | null;
  course_id: number | null;
  location_name: string;
  lat: number | null;
  lng: number | null;
  radius_ft: number;
  workday_date: string;
  start_time: string | null;
  karma_reward: number;
  status: WorkdayStatus;
  announced_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SignupRow {
  id: number;
  workday_id: number;
  member_id: string;
  member_name: string;
  status: SignupStatus;
  signed_up_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy_m: number | null;
  gps_distance_ft: number | null;
  gps_verified: number;
  checked_in_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
  karma_awarded: number;
  admin_note: string | null;
}

const hasField = (body: Record<string, unknown>, field: string): boolean => Object.prototype.hasOwnProperty.call(body, field);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

/** Today's YYYY-MM-DD in the club's timezone (America/New_York). */
export function easternTodayIso(now = new Date()): string {
  const { year, month, day } = easternMonthDay(now);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** True when GPS check-in is open for a workday: explicitly activated by admin, or scheduled for today (Eastern). */
export function checkinOpenForWorkday(
  row: Pick<WorkdayRow, "status" | "workday_date">,
  now = new Date(),
): boolean {
  if (row.status === "active") return true;
  return row.status === "open" && row.workday_date === easternTodayIso(now);
}

function validWorkdayDate(raw: unknown): string | null {
  const text = asStr(raw, 16);
  const match = text ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return text;
}

function optionalText(raw: unknown, max: number): string | null | undefined {
  if (raw == null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

function validCoordPair(rawLat: unknown, rawLng: unknown): { lat: number | null; lng: number | null } | null {
  const latEmpty = rawLat == null || rawLat === "";
  const lngEmpty = rawLng == null || rawLng === "";
  if (latEmpty && lngEmpty) return { lat: null, lng: null };
  if (latEmpty !== lngEmpty) return null;
  const lat = asNum(typeof rawLat === "string" && rawLat.trim() ? Number(rawLat) : rawLat);
  const lng = asNum(typeof rawLng === "string" && rawLng.trim() ? Number(rawLng) : rawLng);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function validKarma(raw: unknown, fallback = DEFAULT_KARMA): number | null {
  if (raw == null || raw === "") return fallback;
  const value = asInt(raw);
  if (value == null || value < 1 || value > MAX_KARMA) return null;
  return value;
}

function validRadius(raw: unknown, fallback = DEFAULT_RADIUS_FT): number | null {
  if (raw == null || raw === "") return fallback;
  const value = asInt(raw);
  if (value == null || value < MIN_RADIUS_FT || value > MAX_RADIUS_FT) return null;
  return value;
}

function signupSortRank(status: SignupStatus): number {
  if (status === "checked_in") return 0;
  if (status === "signed_up") return 1;
  if (status === "verified") return 2;
  return 3;
}

async function signupsForWorkdays(env: Env, workdayIds: readonly number[]): Promise<Map<number, SignupRow[]>> {
  const out = new Map<number, SignupRow[]>();
  const ids = [...new Set(workdayIds.filter((id) => Number.isInteger(id) && id > 0))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(
      `SELECT * FROM club_workday_signups WHERE workday_id IN (${placeholders(chunk.length)}) ORDER BY signed_up_at ASC, id ASC`,
    ).bind(...chunk).all<SignupRow>()).results ?? [];
    for (const row of rows) {
      const list = out.get(row.workday_id) ?? [];
      list.push(row);
      out.set(row.workday_id, list);
    }
  }
  return out;
}

function memberWorkdayView(row: WorkdayRow, signups: readonly SignupRow[], selfId: string, now = new Date()) {
  const visible = signups.filter((s) => s.status !== "no_show");
  const mine = signups.find((s) => s.member_id === selfId) ?? null;
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    courseId: row.course_id,
    locationName: row.location_name,
    workdayDate: row.workday_date,
    startTime: row.start_time ?? "",
    karmaReward: row.karma_reward,
    radiusFt: row.radius_ft,
    hasGps: row.lat != null && row.lng != null,
    status: row.status,
    checkinOpen: checkinOpenForWorkday(row, now),
    announcedAt: row.announced_at,
    signupCount: visible.length,
    checkedInCount: visible.filter((s) => s.status === "checked_in").length,
    verifiedCount: visible.filter((s) => s.status === "verified").length,
    // Privacy-safe public roster on Member Home: never expose other members' ids or GPS fixes.
    signups: visible.map((s) => ({
      name: s.member_name,
      karmaKey: karmaKey(s.member_id),
      status: s.status,
      signedUpAt: s.signed_up_at,
      isMe: s.member_id === selfId,
    })),
    me: mine
      ? {
        status: mine.status,
        signedUpAt: mine.signed_up_at,
        gpsVerified: mine.gps_verified === 1,
        gpsDistanceFt: mine.gps_distance_ft,
        checkedInAt: mine.checked_in_at,
        verifiedAt: mine.verified_at,
        karmaAwarded: mine.karma_awarded,
      }
      : null,
  };
}

function adminParticipantView(row: SignupRow) {
  return {
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    karmaKey: karmaKey(row.member_id),
    status: row.status,
    signedUpAt: row.signed_up_at,
    gpsVerified: row.gps_verified === 1,
    gpsDistanceFt: row.gps_distance_ft,
    gpsAccuracyM: row.gps_accuracy_m,
    checkedInAt: row.checked_in_at,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    karmaAwarded: row.karma_awarded,
    adminNote: row.admin_note ?? "",
  };
}

function adminWorkdayView(row: WorkdayRow, signups: readonly SignupRow[], now = new Date()) {
  const sorted = [...signups].sort((a, b) => signupSortRank(a.status) - signupSortRank(b.status) || a.id - b.id);
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    courseId: row.course_id,
    locationName: row.location_name,
    lat: row.lat,
    lng: row.lng,
    radiusFt: row.radius_ft,
    hasGps: row.lat != null && row.lng != null,
    workdayDate: row.workday_date,
    startTime: row.start_time ?? "",
    karmaReward: row.karma_reward,
    status: row.status,
    checkinOpen: checkinOpenForWorkday(row, now),
    announcedAt: row.announced_at,
    createdBy: row.created_by,
    signupCount: signups.filter((s) => s.status !== "no_show").length,
    checkedInCount: signups.filter((s) => s.status === "checked_in").length,
    verifiedCount: signups.filter((s) => s.status === "verified").length,
    participants: sorted.map(adminParticipantView),
  };
}

async function fetchAdminWorkday(env: Env, id: number): Promise<ReturnType<typeof adminWorkdayView> | null> {
  const row = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
  if (!row) return null;
  const signups = (await signupsForWorkdays(env, [id])).get(id) ?? [];
  return adminWorkdayView(row, signups);
}

async function fetchMemberWorkday(env: Env, id: number, selfId: string): Promise<ReturnType<typeof memberWorkdayView> | null> {
  const row = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
  if (!row) return null;
  const signups = (await signupsForWorkdays(env, [id])).get(id) ?? [];
  return memberWorkdayView(row, signups, selfId);
}

function announceNotice(row: Pick<WorkdayRow, "id" | "title" | "workday_date" | "start_time" | "location_name" | "karma_reward">) {
  const when = [row.workday_date, row.start_time].filter(Boolean).join(" · ");
  return {
    title: `Workday: ${row.title}`.slice(0, 80),
    body: `${when} at ${row.location_name} (+${row.karma_reward} karma). Open Home to sign up!`.slice(0, 180),
    href: "/gvdg-members.html#home",
    refKey: `workday-announce-${row.id}`,
  };
}

async function sendWorkdayVerifyNotice(
  env: Env,
  ctx: WaitCtx,
  memberIds: readonly string[],
  workday: Pick<WorkdayRow, "id" | "title" | "karma_reward">,
): Promise<void> {
  if (!memberIds.length) return;
  const title = "Workday karma earned!";
  const body = `+${workday.karma_reward} karma for ${workday.title}. Thanks for helping the club!`.slice(0, 180);
  const href = "/gvdg-members.html#home";
  const refKey = `workday-karma-${workday.id}`;
  await recordMemberNotices(env, memberIds, { kind: "workday", title, body, href, refKey }, 1000).catch(() => {});
  for (let i = 0; i < memberIds.length; i += 20) {
    notifyMembers(ctx, env, memberIds.slice(i, i + 20), "messages", { title, body, url: href, tag: `workday-karma-${workday.id}` });
  }
}

/** Member routes: /workdays, /workdays/:id/signup, /workdays/:id/check-in. */
export async function handleMemberWorkdays(
  request: Request,
  env: Env,
  origin: string | null,
  pathname: string,
  method: string,
  ctx?: WaitCtx,
): Promise<Response | null> {
  if (pathname !== "/workdays" && !pathname.startsWith("/workdays/")) return null;
  const auth = await requireMember(request, env, origin);
  if (auth instanceof Response) return auth;

  const seg = pathname.split("/").filter(Boolean);
  if (seg.length === 1 && method === "GET") {
    const now = new Date();
    const openRows = (await env.DB.prepare(
      `SELECT * FROM club_workdays WHERE status IN ('open', 'active') ORDER BY workday_date ASC, id ASC LIMIT 10`,
    ).all<WorkdayRow>()).results ?? [];
    const recentVerified = (await env.DB.prepare(
      `SELECT w.* FROM club_workdays w
       JOIN club_workday_signups s ON s.workday_id = w.id
       WHERE w.status = 'completed' AND s.member_id = ? AND s.status = 'verified'
         AND w.updated_at >= datetime('now', ? || ' days')
       ORDER BY w.workday_date DESC, w.id DESC LIMIT 3`,
    ).bind(auth.sub, `-${COMPLETED_VISIBLE_DAYS}`).all<WorkdayRow>()).results ?? [];
    const byId = new Map<number, WorkdayRow>();
    for (const row of [...openRows, ...recentVerified]) byId.set(row.id, row);
    const workdays = [...byId.values()];
    const signupsByWorkday = await signupsForWorkdays(env, workdays.map((row) => row.id));
    return json({
      workdays: workdays.map((row) => memberWorkdayView(row, signupsByWorkday.get(row.id) ?? [], auth.sub, now)),
    }, 200, origin);
  }

  const id = asInt(seg[1]);
  if (id == null || id <= 0) return json({ error: "not_found" }, 404, origin);

  if (seg.length === 3 && seg[2] === "signup") {
    if (method === "POST") {
      if (await kvRateLimited(env, "workday-signup:" + auth.sub, 30, 3600)) return json({ error: "rate_limited" }, 429, origin);
      const workday = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
      if (!workday) return json({ error: "not_found" }, 404, origin);
      if (workday.status === "completed" || workday.status === "cancelled") return json({ error: "workday_closed" }, 409, origin);
      const existing = await env.DB.prepare(
        "SELECT * FROM club_workday_signups WHERE workday_id = ? AND member_id = ?",
      ).bind(id, auth.sub).first<SignupRow>();
      if (existing?.status === "verified") return json({ error: "already_verified" }, 409, origin);
      const member = await getMember(env.ROSTER, auth.sub);
      const memberName = (member?.name || "Member").trim().slice(0, 80) || "Member";
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO club_workday_signups (workday_id, member_id, member_name, status) VALUES (?, ?, ?, 'signed_up')`,
        ).bind(id, auth.sub, memberName).run();
        return json({ ok: true, workday: await fetchMemberWorkday(env, id, auth.sub) }, 201, origin);
      }
      if (existing.status === "no_show" || existing.member_name !== memberName) {
        await env.DB.prepare(
          `UPDATE club_workday_signups
           SET member_name = ?, status = CASE WHEN status = 'no_show' THEN 'signed_up' ELSE status END
           WHERE workday_id = ? AND member_id = ?`,
        ).bind(memberName, id, auth.sub).run();
      }
      return json({ ok: true, workday: await fetchMemberWorkday(env, id, auth.sub) }, 200, origin);
    }

    if (method === "DELETE") {
      const workday = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
      if (!workday) return json({ error: "not_found" }, 404, origin);
      const existing = await env.DB.prepare(
        "SELECT * FROM club_workday_signups WHERE workday_id = ? AND member_id = ?",
      ).bind(id, auth.sub).first<SignupRow>();
      if (existing?.status === "verified") return json({ error: "already_verified" }, 409, origin);
      await env.DB.prepare("DELETE FROM club_workday_signups WHERE workday_id = ? AND member_id = ?").bind(id, auth.sub).run();
      return json({ ok: true, workday: await fetchMemberWorkday(env, id, auth.sub) }, 200, origin);
    }
  }

  if (seg.length === 3 && seg[2] === "check-in" && method === "POST") {
    if (await kvRateLimited(env, "workday-checkin:" + auth.sub, 20, 3600)) return json({ error: "rate_limited" }, 429, origin);
    const body = (await readJson(request)) ?? {};
    const coords = validCoordPair(body.lat, body.lng);
    if (!coords || coords.lat == null || coords.lng == null) return json({ error: "invalid_location" }, 400, origin);
    const rawAcc = body.accuracyM == null ? null : asNum(body.accuracyM);
    const accuracyM = rawAcc != null && rawAcc >= 0 && rawAcc <= 50000 ? rawAcc : null;

    const workday = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
    if (!workday) return json({ error: "not_found" }, 404, origin);
    if (workday.status === "completed" || workday.status === "cancelled") return json({ error: "workday_closed" }, 409, origin);
    if (!checkinOpenForWorkday(workday)) return json({ error: "checkin_not_open" }, 409, origin);
    if (workday.lat == null || workday.lng == null) return json({ error: "workday_missing_gps" }, 409, origin);

    const signup = await env.DB.prepare(
      "SELECT * FROM club_workday_signups WHERE workday_id = ? AND member_id = ?",
    ).bind(id, auth.sub).first<SignupRow>();
    if (!signup || signup.status === "no_show") return json({ error: "not_signed_up" }, 409, origin);
    if (signup.status === "verified") return json({ error: "already_verified" }, 409, origin);

    const distanceFt = haversineFeet({ lat: workday.lat, lng: workday.lng }, { lat: coords.lat, lng: coords.lng });
    if (distanceFt > workday.radius_ft) {
      return json({ error: "too_far", distanceFt, radiusFt: workday.radius_ft }, 422, origin);
    }

    const updated = await env.DB.prepare(
      `UPDATE club_workday_signups
       SET status = 'checked_in',
           gps_lat = ?, gps_lng = ?, gps_accuracy_m = ?, gps_distance_ft = ?, gps_verified = 1,
           checked_in_at = COALESCE(checked_in_at, datetime('now'))
       WHERE workday_id = ? AND member_id = ? AND status != 'verified'
       RETURNING *`,
    ).bind(coords.lat, coords.lng, accuracyM, distanceFt, id, auth.sub).first<SignupRow>();
    if (!updated) return json({ error: "already_verified" }, 409, origin);

    notifyAdmins(ctx, env, {
      title: "Workday check-in",
      body: `${updated.member_name} checked in at ${workday.title} (${distanceFt} ft).`,
      url: "/admin.html#workdays",
      tag: `workday-checkin-${workday.id}`,
    });
    return json({ ok: true, distanceFt, radiusFt: workday.radius_ft, workday: await fetchMemberWorkday(env, id, auth.sub) }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}

/** Admin routes: /admin/workdays (behind adminGate). */
export async function handleAdminWorkdays(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
  ctx?: WaitCtx,
): Promise<Response> {
  // GET /admin/workdays
  if (method === "GET" && seg.length === 2) {
    const activeRows = (await env.DB.prepare(
      `SELECT * FROM club_workdays WHERE status IN ('active', 'open')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, workday_date ASC, id ASC LIMIT 20`,
    ).all<WorkdayRow>()).results ?? [];
    const pastRows = (await env.DB.prepare(
      `SELECT * FROM club_workdays WHERE status IN ('completed', 'cancelled')
       ORDER BY workday_date DESC, id DESC LIMIT 25`,
    ).all<WorkdayRow>()).results ?? [];
    const allRows = [...activeRows, ...pastRows];
    const signupsByWorkday = await signupsForWorkdays(env, allRows.map((row) => row.id));
    const views = allRows.map((row) => adminWorkdayView(row, signupsByWorkday.get(row.id) ?? []));
    const pendingCheckins = views
      .filter((w) => w.status === "open" || w.status === "active")
      .reduce((sum, w) => sum + w.checkedInCount, 0);
    return json({ workdays: views, pendingCheckins }, 200, origin);
  }

  // POST /admin/workdays
  if (method === "POST" && seg.length === 2) {
    const body = (await readJson(request)) ?? {};
    const title = asStr(body.title, 120);
    if (!title) return json({ error: "invalid_title" }, 400, origin);
    const workdayDate = validWorkdayDate(body.workdayDate);
    if (!workdayDate) return json({ error: "invalid_date" }, 400, origin);
    const startTime = optionalText(body.startTime, 24);
    if (startTime === undefined) return json({ error: "invalid_time" }, 400, origin);
    const description = optionalText(body.description, 1000);
    if (description === undefined) return json({ error: "invalid_description" }, 400, origin);
    const karmaReward = validKarma(body.karmaReward, DEFAULT_KARMA);
    if (karmaReward == null) return json({ error: "invalid_karma" }, 400, origin);
    const radiusFt = validRadius(body.radiusFt, DEFAULT_RADIUS_FT);
    if (radiusFt == null) return json({ error: "invalid_radius" }, 400, origin);
    const status = body.status == null || body.status === "" ? "open" : body.status === "active" ? "active" : body.status === "open" ? "open" : null;
    if (!status) return json({ error: "invalid_status" }, 400, origin);

    let courseId: number | null = null;
    let courseName: string | null = null;
    let courseLat: number | null = null;
    let courseLng: number | null = null;
    if (body.courseId != null && body.courseId !== "") {
      courseId = asInt(body.courseId);
      if (!courseId || courseId <= 0) return json({ error: "invalid_course" }, 400, origin);
      const course = await env.DB.prepare("SELECT id, name, lat, lng FROM courses WHERE id = ?")
        .bind(courseId).first<{ id: number; name: string; lat: number | null; lng: number | null }>();
      if (!course) return json({ error: "invalid_course" }, 400, origin);
      courseName = course.name;
      courseLat = course.lat;
      courseLng = course.lng;
    }

    const explicitLoc = asStr(body.locationName, 140);
    const locationName = explicitLoc ?? courseName;
    if (!locationName) return json({ error: "missing_location" }, 400, origin);

    let lat = courseLat;
    let lng = courseLng;
    if (hasField(body, "lat") || hasField(body, "lng")) {
      const coords = validCoordPair(body.lat, body.lng);
      if (!coords) return json({ error: "invalid_gps" }, 400, origin);
      lat = coords.lat;
      lng = coords.lng;
    }

    const inserted = await env.DB.prepare(
      `INSERT INTO club_workdays
         (title, description, course_id, location_name, lat, lng, radius_ft, workday_date, start_time, karma_reward, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).bind(title, description, courseId, locationName, lat, lng, radiusFt, workdayDate, startTime, karmaReward, status, adminId).first<WorkdayRow>();
    if (!inserted) return json({ error: "save_failed" }, 500, origin);

    const activeMembers = (await listMembers(env.ROSTER)).filter((m) => m.held !== true);
    const memberIds = activeMembers.map((m) => m.memberId);
    const notice = announceNotice(inserted);
    await recordMemberNotices(env, memberIds, { kind: "workday", ...notice }, 1000).catch(() => {});
    notifyAllSubscribedMembers(ctx, env, "messages", { title: notice.title, body: notice.body, url: notice.href, tag: `workday-${inserted.id}` }, adminId);

    return json({ workday: adminWorkdayView(inserted, []), notifiedCount: memberIds.length }, 201, origin);
  }

  const id = asInt(seg[2]);
  if (id == null || id <= 0) return json({ error: "not_found" }, 404, origin);

  // PATCH /admin/workdays/:id
  if (method === "PATCH" && seg.length === 3) {
    const existing = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
    if (!existing) return json({ error: "not_found" }, 404, origin);
    const body = (await readJson(request)) ?? {};

    let title = existing.title;
    if (hasField(body, "title")) {
      const next = asStr(body.title, 120);
      if (!next) return json({ error: "invalid_title" }, 400, origin);
      title = next;
    }
    let workdayDate = existing.workday_date;
    if (hasField(body, "workdayDate")) {
      const next = validWorkdayDate(body.workdayDate);
      if (!next) return json({ error: "invalid_date" }, 400, origin);
      workdayDate = next;
    }
    let startTime = existing.start_time;
    if (hasField(body, "startTime")) {
      const next = optionalText(body.startTime, 24);
      if (next === undefined) return json({ error: "invalid_time" }, 400, origin);
      startTime = next;
    }
    let description = existing.description;
    if (hasField(body, "description")) {
      const next = optionalText(body.description, 1000);
      if (next === undefined) return json({ error: "invalid_description" }, 400, origin);
      description = next;
    }
    let karmaReward = existing.karma_reward;
    if (hasField(body, "karmaReward")) {
      const next = validKarma(body.karmaReward, existing.karma_reward);
      if (next == null) return json({ error: "invalid_karma" }, 400, origin);
      karmaReward = next;
    }
    let radiusFt = existing.radius_ft;
    if (hasField(body, "radiusFt")) {
      const next = validRadius(body.radiusFt, existing.radius_ft);
      if (next == null) return json({ error: "invalid_radius" }, 400, origin);
      radiusFt = next;
    }
    let status = existing.status;
    if (hasField(body, "status")) {
      const next = typeof body.status === "string" && (WORKDAY_STATUSES as readonly string[]).includes(body.status) ? body.status as WorkdayStatus : null;
      if (!next) return json({ error: "invalid_status" }, 400, origin);
      status = next;
    }

    let courseId = existing.course_id;
    let locationName = existing.location_name;
    let lat = existing.lat;
    let lng = existing.lng;
    if (hasField(body, "courseId")) {
      if (body.courseId == null || body.courseId === "") {
        courseId = null;
      } else {
        const nextCourseId = asInt(body.courseId);
        if (!nextCourseId || nextCourseId <= 0) return json({ error: "invalid_course" }, 400, origin);
        const course = await env.DB.prepare("SELECT id, name, lat, lng FROM courses WHERE id = ?")
          .bind(nextCourseId).first<{ id: number; name: string; lat: number | null; lng: number | null }>();
        if (!course) return json({ error: "invalid_course" }, 400, origin);
        courseId = course.id;
        if (!hasField(body, "locationName")) locationName = course.name;
        if (!hasField(body, "lat") && !hasField(body, "lng")) {
          lat = course.lat;
          lng = course.lng;
        }
      }
    }
    if (hasField(body, "locationName")) {
      const next = asStr(body.locationName, 140);
      if (!next) return json({ error: "missing_location" }, 400, origin);
      locationName = next;
    }
    if (hasField(body, "lat") || hasField(body, "lng")) {
      const coords = validCoordPair(body.lat, body.lng);
      if (!coords) return json({ error: "invalid_gps" }, 400, origin);
      lat = coords.lat;
      lng = coords.lng;
    }

    const updated = await env.DB.prepare(
      `UPDATE club_workdays
       SET title = ?, description = ?, course_id = ?, location_name = ?, lat = ?, lng = ?,
           radius_ft = ?, workday_date = ?, start_time = ?, karma_reward = ?, status = ?, updated_at = datetime('now')
       WHERE id = ? RETURNING *`,
    ).bind(title, description, courseId, locationName, lat, lng, radiusFt, workdayDate, startTime, karmaReward, status, id).first<WorkdayRow>();
    if (!updated) return json({ error: "not_found" }, 404, origin);

    if (status === "cancelled" && existing.status !== "cancelled") {
      const signups = (await signupsForWorkdays(env, [id])).get(id) ?? [];
      const toNotify = signups.filter((s) => s.status === "signed_up" || s.status === "checked_in").map((s) => s.member_id);
      if (toNotify.length) {
        const note = {
          title: `Workday cancelled: ${updated.title}`.slice(0, 80),
          body: `${updated.workday_date} at ${updated.location_name} was cancelled by a club admin.`.slice(0, 180),
        };
        await recordMemberNotices(env, toNotify, { kind: "workday", ...note, href: "/gvdg-members.html#home", refKey: `workday-cancelled-${id}` }, 1000).catch(() => {});
        for (let i = 0; i < toNotify.length; i += 20) {
          notifyMembers(ctx, env, toNotify.slice(i, i + 20), "messages", { ...note, url: "/gvdg-members.html#home", tag: `workday-cancelled-${id}` });
        }
      }
    }

    return json({ workday: await fetchAdminWorkday(env, id) }, 200, origin);
  }

  // POST /admin/workdays/:id/verify-all-gps
  if (method === "POST" && seg.length === 4 && seg[3] === "verify-all-gps") {
    const workday = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
    if (!workday) return json({ error: "not_found" }, 404, origin);
    if (workday.status === "cancelled") return json({ error: "workday_cancelled" }, 409, origin);
    const pending = (await env.DB.prepare(
      `SELECT member_id FROM club_workday_signups WHERE workday_id = ? AND status = 'checked_in' AND gps_verified = 1`,
    ).bind(id).all<{ member_id: string }>()).results ?? [];
    if (!pending.length) return json({ verifiedCount: 0, workday: await fetchAdminWorkday(env, id) }, 200, origin);
    await env.DB.prepare(
      `UPDATE club_workday_signups
       SET status = 'verified', verified_at = datetime('now'), verified_by = ?, karma_awarded = ?
       WHERE workday_id = ? AND status = 'checked_in' AND gps_verified = 1`,
    ).bind(adminId, workday.karma_reward, id).run();
    await bustKarmaCache(request);
    await sendWorkdayVerifyNotice(env, ctx, pending.map((row) => row.member_id), workday);
    return json({ verifiedCount: pending.length, workday: await fetchAdminWorkday(env, id) }, 200, origin);
  }

  // POST /admin/workdays/:id/participants/:memberId/(verify|status)
  if (method === "POST" && seg.length === 6 && seg[3] === "participants") {
    let memberId = "";
    try { memberId = decodeURIComponent(seg[4] || "").trim(); } catch { memberId = ""; }
    if (!memberId) return json({ error: "not_found" }, 404, origin);
    const action = seg[5];

    if (action === "verify") {
      const body = (await readJson(request)) ?? {};
      const workday = await env.DB.prepare("SELECT * FROM club_workdays WHERE id = ?").bind(id).first<WorkdayRow>();
      if (!workday) return json({ error: "not_found" }, 404, origin);
      if (workday.status === "cancelled") return json({ error: "workday_cancelled" }, 409, origin);
      const signup = await env.DB.prepare(
        "SELECT * FROM club_workday_signups WHERE workday_id = ? AND member_id = ?",
      ).bind(id, memberId).first<SignupRow>();
      if (!signup) return json({ error: "not_found" }, 404, origin);
      if (signup.status === "verified") return json({ error: "already_verified" }, 409, origin);
      if (signup.gps_verified !== 1 && body.allowWithoutGps !== true) return json({ error: "gps_required" }, 409, origin);
      const note = optionalText(body.note, 200);
      if (note === undefined) return json({ error: "invalid_note" }, 400, origin);

      const updated = await env.DB.prepare(
        `UPDATE club_workday_signups
         SET status = 'verified', verified_at = datetime('now'), verified_by = ?, karma_awarded = ?, admin_note = ?
         WHERE workday_id = ? AND member_id = ? AND status != 'verified'
         RETURNING *`,
      ).bind(adminId, workday.karma_reward, note, id, memberId).first<SignupRow>();
      if (!updated) return json({ error: "already_verified" }, 409, origin);

      await bustKarmaCache(request);
      await sendWorkdayVerifyNotice(env, ctx, [memberId], workday);
      return json({ participant: adminParticipantView(updated), workday: await fetchAdminWorkday(env, id) }, 200, origin);
    }

    if (action === "status") {
      const body = (await readJson(request)) ?? {};
      const nextStatus = body.status === "no_show" ? "no_show" : body.status === "signed_up" ? "signed_up" : null;
      if (!nextStatus) return json({ error: "invalid_status" }, 400, origin);
      const signup = await env.DB.prepare(
        "SELECT * FROM club_workday_signups WHERE workday_id = ? AND member_id = ?",
      ).bind(id, memberId).first<SignupRow>();
      if (!signup) return json({ error: "not_found" }, 404, origin);
      if (signup.status === "verified") return json({ error: "already_verified" }, 409, origin);
      const updated = await env.DB.prepare(
        `UPDATE club_workday_signups SET status = ? WHERE workday_id = ? AND member_id = ? AND status != 'verified' RETURNING *`,
      ).bind(nextStatus, id, memberId).first<SignupRow>();
      if (!updated) return json({ error: "already_verified" }, 409, origin);
      return json({ participant: adminParticipantView(updated), workday: await fetchAdminWorkday(env, id) }, 200, origin);
    }
  }

  return json({ error: "not_found" }, 404, origin);
}
