// Lost & Found background work. The Worker does I/O only (the club is on the Workers Free plan: 10 ms of CPU per
// invocation, cron included, and a CPU-limit kill can't be caught): it never decodes or encodes an image.
//
//   1. read     Gemini reads the disc and boxes any writing; the read is stored (ink text PRIVATE).
//   2. match    details, matching, the optional photo compare and notices, from the stored reads only.
//   3. hide     the POSTER'S BROWSER paints a solid patch over each box and uploads that copy (lf-photos.ts).
//   4. verify   Gemini checks the poster's copy; only a confident "no personal writing is legible" publishes it.
//
// Runs in waitUntil after a post (read + match) or an upload (verify), and on the 15-minute cron for retries
// with backoff (never on a public GET). Every Gemini call claims an attempt with a compare-and-set first; after
// MAX_ATTEMPTS real failures the photo goes to the admin queue. A free-tier quota answer (429) is "try later":
// the attempt is handed back, so quota never uses up MAX_ATTEMPTS.
//
// AI cost controls: one stored read per photo (never re-asked once trusted), a club-wide daily budget
// (LF_DAILY_VISION_BUDGET, default 150) and a per-minute cap well under the free tier's ~10 a minute, so
// tee-sign OCR (same key) always has room; at most MAX_COMPARES optional photo compares per post.

import type { Env } from "./env.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { deliverLfNote } from "./lf-notify.js";
import { rosterNameMatch, scoreMatch, STORE_THRESHOLD, type FoundSide, type LostSide } from "./lf-match.js";
import { coursesById, getPostRow, postTitle } from "./lf-store.js";
import { compareDiscPhotos, extractDisc, inkKeys, normalizeName, verifyHidden, type InkKeys } from "./lf-vision.js";
import { isGuestId } from "./market-notify.js";
import { num, str, type Row } from "./market-store.js";
import { getMember, listMembers } from "./roster.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export const MAX_ATTEMPTS = 6;
/** Minutes to wait after attempt n (1-based) before trying again. */
export const BACKOFF_MINUTES = [15, 60, 180, 720, 1440, 2880];
export const DEFAULT_DAILY_VISION_BUDGET = 150;
/** Lost & Found's share of the free tier's per-minute limit; the rest is left for tee-sign OCR. */
export const VISION_PER_MINUTE = 4;
export const QUOTA_RETRY_MINUTES = 30;
export const MAX_COMPARES = 3;
/** Per cron tick: Gemini reads and verifications (each a network wait, not CPU). */
export const TICK_READS = 4;
export const TICK_VERIFIES = 4;
export const CANDIDATE_DAYS = 120;

function sqlNowPlus(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
}

export function dailyVisionBudget(env: Env): number {
  const value = Number((env as unknown as { LF_DAILY_VISION_BUDGET?: string }).LF_DAILY_VISION_BUDGET);
  return Number.isInteger(value) && value > 0 && value <= 5000 ? value : DEFAULT_DAILY_VISION_BUDGET;
}

/** A slot for one Lost & Found vision call, or the minutes to wait: cool-down after a 429, the per-minute cap,
 *  then the daily budget. */
async function visionSlot(env: Env): Promise<number> {
  if (await env.RATELIMIT.get("lfai:cooldown")) return 5;
  if (await kvRateLimited(env, "lfai:m:" + Math.floor(Date.now() / 60_000), VISION_PER_MINUTE, 120)) return 2;
  if (await kvRateLimited(env, "lfai:" + new Date().toISOString().slice(0, 10), dailyVisionBudget(env), 2 * 86_400)) return 60;
  return 0;
}

export type PhotoOutcome = "read" | "public" | "rejected" | "later" | "pending" | "failed" | "skipped";

interface PhotoRow {
  id: number; post_id: number | null; celebration_id: number | null; original_key: string | null; original_type: string;
  candidate_key: string | null; redaction: string; attempts: number;
}

async function photoRow(env: Env, photoId: number): Promise<PhotoRow | null> {
  return env.DB.prepare(
    "SELECT id, post_id, celebration_id, original_key, original_type, candidate_key, redaction, attempts FROM lf_photos WHERE id = ?",
  ).bind(photoId).first<PhotoRow>();
}

async function later(env: Env, photoId: number, minutes: number, error: string): Promise<PhotoOutcome> {
  await env.DB.prepare("UPDATE lf_photos SET next_attempt_at = ?, last_error = ? WHERE id = ?").bind(sqlNowPlus(minutes), error, photoId).run();
  return "later";
}

/** Claim the next attempt (compare-and-set) BEFORE calling the AI, so a request and a cron tick never both run it
 *  and a killed invocation still counts. Past MAX_ATTEMPTS the photo goes to 'failed' (the admin queue). */
async function claimAttempt(env: Env, row: PhotoRow, status: string): Promise<number | null> {
  if (row.attempts >= MAX_ATTEMPTS) {
    // The last attempt never reported back (e.g. the invocation was killed): retire the photo to the admin queue.
    await env.DB.prepare("UPDATE lf_photos SET redaction = 'failed' WHERE id = ? AND redaction = ? AND attempts = ?").bind(row.id, status, row.attempts).run();
    return null;
  }
  const attempt = row.attempts + 1;
  const backoff = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1]!;
  const claimed = await env.DB.prepare(
    "UPDATE lf_photos SET attempts = ?, next_attempt_at = ? WHERE id = ? AND redaction = ? AND attempts = ?",
  ).bind(attempt, sqlNowPlus(backoff), row.id, status, row.attempts).run();
  return (claimed.meta?.changes ?? 0) > 0 ? attempt : null;
}

/** A free-tier 429 is not a failure: hand the attempt back and cool down for a while. */
async function refund(env: Env, photoId: number): Promise<PhotoOutcome> {
  await env.RATELIMIT.put("lfai:cooldown", "1", { expirationTtl: 120 });
  await env.DB.prepare("UPDATE lf_photos SET attempts = MAX(0, attempts - 1), next_attempt_at = ?, last_error = 'ai_quota' WHERE id = ?")
    .bind(sqlNowPlus(QUOTA_RETRY_MINUTES), photoId).run();
  return "later";
}

async function settle(env: Env, photoId: number, status: string, attempt: number, error: string): Promise<PhotoOutcome> {
  const failed = attempt >= MAX_ATTEMPTS;
  await env.DB.prepare("UPDATE lf_photos SET redaction = ?, last_error = ? WHERE id = ? AND redaction = ?")
    .bind(failed ? "failed" : status, error.slice(0, 80), photoId, status).run();
  return failed ? "failed" : "pending";
}

async function objectBytes(env: Env, key: string | null): Promise<Uint8Array | null> {
  const object = key ? await env.PHOTOS?.get(key) : null;
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Step 1: the AI read for one photo. A stored trusted read is never asked for again. The read is stored for
 *  matching whatever its status; a trusted read moves the photo on to 'hiding' (the poster's browser). */
export async function readPhoto(env: Env, photoId: number): Promise<PhotoOutcome> {
  const row = await photoRow(env, photoId);
  if (!row || row.redaction !== "pending" || !row.original_key || !env.PHOTOS) return "skipped";
  const stored = await env.DB.prepare("SELECT status FROM lf_extractions WHERE photo_id = ?").bind(photoId).first<{ status: string }>();
  if (stored?.status === "ok") {
    await env.DB.prepare("UPDATE lf_photos SET redaction = 'hiding' WHERE id = ? AND redaction = 'pending'").bind(photoId).run();
    return "read";
  }
  const wait = await visionSlot(env);
  if (wait) return later(env, photoId, wait, "ai_budget");
  const attempt = await claimAttempt(env, row, "pending");
  if (attempt == null) return "skipped";
  const bytes = await objectBytes(env, row.original_key);
  if (!bytes) return settle(env, photoId, "pending", attempt, "original_missing");
  const read = await extractDisc(env, bytes, row.original_type);
  if (read.status !== "empty") {
    const keys = inkKeys(read.ink);
    const boxes = read.ink.flatMap((item) => (item.box ? [item.box] : []));
    await env.DB.prepare(
      `INSERT INTO lf_extractions (photo_id, post_id, source, status, brand, mold, plastic, colors, stamp, ink_json, ink_names, ink_phones, boxes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(photo_id) DO UPDATE SET source = excluded.source, status = excluded.status, brand = excluded.brand, mold = excluded.mold,
         plastic = excluded.plastic, colors = excluded.colors, stamp = excluded.stamp, ink_json = excluded.ink_json,
         ink_names = excluded.ink_names, ink_phones = excluded.ink_phones, boxes_json = excluded.boxes_json, updated_at = datetime('now')
       WHERE lf_extractions.status <> 'ok'`,
    ).bind(photoId, row.post_id, read.source ?? "", read.status, read.brand, read.mold, read.plastic, JSON.stringify(read.colors), read.stamp,
      JSON.stringify(read.ink), [...keys.names, ...keys.initials.map((value) => "#" + value)].join("|"), keys.phones.join("|"),
      JSON.stringify(boxes)).run();
  }
  if (read.quota) return refund(env, photoId);
  if (read.status !== "ok") return settle(env, photoId, "pending", attempt, read.status === "empty" ? "ai_unavailable" : "ai_unsure");
  await env.DB.prepare(
    "UPDATE lf_photos SET redaction = 'hiding', boxes = ?, next_attempt_at = datetime('now'), last_error = '' WHERE id = ? AND redaction = 'pending'",
  ).bind(read.ink.filter((item) => item.box).length, photoId).run();
  return "read";
}

/** Step 4: the AI checks the poster's copy. Only a confident "no personal writing is legible" publishes it;
 *  "still readable" sends it back to the poster (with wider patches next time); "unavailable" retries later. */
export async function verifyPhoto(env: Env, photoId: number): Promise<PhotoOutcome> {
  const row = await photoRow(env, photoId);
  if (!row || row.redaction !== "verifying" || !row.candidate_key || !env.PHOTOS) return "skipped";
  const wait = await visionSlot(env);
  if (wait) return later(env, photoId, wait, "ai_budget");
  const attempt = await claimAttempt(env, row, "verifying");
  if (attempt == null) return "skipped";
  const bytes = await objectBytes(env, row.candidate_key);
  if (!bytes) return settle(env, photoId, "verifying", attempt, "copy_missing");
  const check = await verifyHidden(env, bytes, "image/jpeg");
  if (check.quota) return refund(env, photoId);
  if (!check.verdict) return settle(env, photoId, "verifying", attempt, "ai_unavailable");
  if (check.verdict === "clear") {
    const published = await env.DB.prepare(
      `UPDATE lf_photos SET redaction = 'public', public_key = candidate_key, public_bytes = ?, candidate_key = NULL,
         processed_at = datetime('now'), last_error = '' WHERE id = ? AND redaction = 'verifying' AND candidate_key = ?`,
    ).bind(bytes.length, photoId, row.candidate_key).run();
    return (published.meta?.changes ?? 0) > 0 ? "public" : "skipped";
  }
  // Writing still readable (or the AI wasn't sure): the copy never goes public. Back to the poster.
  await env.PHOTOS.delete(row.candidate_key).catch(() => {});
  const failed = attempt >= MAX_ATTEMPTS;
  await env.DB.prepare(
    `UPDATE lf_photos SET redaction = ?, candidate_key = NULL, rejections = rejections + 1, next_attempt_at = datetime('now'), last_error = ?
     WHERE id = ? AND redaction = 'verifying'`,
  ).bind(failed ? "failed" : "hiding", check.verdict === "visible" ? "writing_visible" : "verify_unsure", photoId).run();
  return failed ? "failed" : "rejected";
}

/** Fill a post's empty details from what the AI read (marked as AI-read for the UI). */
export async function applyExtraction(env: Env, postId: number): Promise<void> {
  const post = await env.DB.prepare("SELECT brand, mold, plastic, color, ai_fields FROM lf_posts WHERE id = ?").bind(postId).first<Row>();
  if (!post) return;
  const reads = (await env.DB.prepare(
    `SELECT brand, mold, plastic, colors, ink_names, ink_phones FROM lf_extractions WHERE post_id = ? AND status IN ('ok', 'unsure')
     ORDER BY CASE status WHEN 'ok' THEN 0 ELSE 1 END, id`,
  ).bind(postId).all<Row>()).results ?? [];
  if (!reads.length) return;
  // Public details come from the printed stamp. Never let a read echo the PRIVATE writing (a name token, or a
  // run of digits) into a public field.
  const inkTokens = new Set(reads.flatMap((read) => str(read, "ink_names").split("|")).flatMap((name) => name.replace(/^#/, "").split(" ")).filter((token) => token.length >= 2));
  const safe = (value: string) => value && !/\d{4}/.test(value) && !normalizeName(value).split(" ").some((token) => inkTokens.has(token));
  const pick = (field: string) => reads.map((read) => str(read, field)).find(safe) || "";
  const fields = new Set(str(post, "ai_fields").split(",").filter(Boolean));
  const next: Record<string, string> = {};
  for (const field of ["brand", "mold", "plastic"]) {
    if (!str(post, field)) {
      const value = pick(field);
      if (value) { next[field] = value; fields.add(field); }
    }
  }
  if (!str(post, "color")) {
    let colors: string[] = [];
    for (const read of reads) {
      try { colors = JSON.parse(str(read, "colors")) as string[]; } catch { colors = []; }
      if (colors.length) break;
    }
    if (colors.length) {
      next.color = colors.slice(0, 2).map((color) => color.charAt(0).toUpperCase() + color.slice(1)).join(" / ");
      fields.add("color");
    }
  }
  if (!Object.keys(next).length) return;
  await env.DB.prepare(
    `UPDATE lf_posts SET brand = CASE WHEN brand = '' THEN ? ELSE brand END, mold = CASE WHEN mold = '' THEN ? ELSE mold END,
       plastic = CASE WHEN plastic = '' THEN ? ELSE plastic END, color = CASE WHEN color = '' THEN ? ELSE color END,
       ai_fields = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(next.brand ?? "", next.mold ?? "", next.plastic ?? "", next.color ?? "", [...fields].join(","), postId).run();
}

async function inkFor(env: Env, postIds: readonly number[]): Promise<Map<number, { keys: InkKeys; colors: string[] }>> {
  const out = new Map<number, { keys: InkKeys; colors: string[] }>();
  const ids = [...new Set(postIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await env.DB.prepare(
      `SELECT post_id, ink_names, ink_phones, colors FROM lf_extractions WHERE post_id IN (${chunk.map(() => "?").join(",")}) AND status IN ('ok', 'unsure')`,
    ).bind(...chunk).all<{ post_id: number; ink_names: string; ink_phones: string; colors: string }>()).results ?? [];
    for (const row of rows) {
      const entry = out.get(row.post_id) ?? { keys: { names: [], phones: [], initials: [] }, colors: [] };
      for (const value of row.ink_names.split("|").filter(Boolean)) {
        if (value.startsWith("#")) { if (!entry.keys.initials.includes(value.slice(1))) entry.keys.initials.push(value.slice(1)); }
        else if (!entry.keys.names.includes(value)) entry.keys.names.push(value);
      }
      for (const value of row.ink_phones.split("|").filter(Boolean)) if (!entry.keys.phones.includes(value)) entry.keys.phones.push(value);
      try { for (const color of JSON.parse(row.colors) as string[]) if (!entry.colors.includes(color)) entry.colors.push(color); } catch { /* none */ }
      out.set(row.post_id, entry);
    }
  }
  return out;
}

const OPEN_POST = "p.status = 'open' AND p.hidden = 0 AND p.expires_at > datetime('now')";

async function memberName(env: Env, ownerId: string): Promise<string | null> {
  if (isGuestId(ownerId)) return null;
  return (await getMember(env.ROSTER, ownerId).catch(() => null))?.name ?? null;
}

interface Candidate { found: Row; lost: Row | null; candidateId: string; score: number; reasons: string[] }

/** Score a new or updated post against open posts of the other kind and store suggestions. */
export async function runMatching(env: Env, postId: number): Promise<Candidate[]> {
  const post = await env.DB.prepare("SELECT p.* FROM lf_posts p WHERE p.id = ?").bind(postId).first<Row>();
  if (!post || str(post, "status") !== "open" || num(post, "hidden") === 1) return [];
  const isFound = str(post, "kind") === "found";
  const others = (await env.DB.prepare(
    `SELECT p.id, p.kind, p.owner_id, p.brand, p.mold, p.plastic, p.color, p.course_id, p.event_date, p.private_ink, p.created_at
     FROM lf_posts p WHERE p.kind = ? AND ${OPEN_POST} AND p.owner_id <> ? AND p.created_at >= datetime('now', '-${CANDIDATE_DAYS} days')
     ORDER BY p.id DESC LIMIT 200`,
  ).bind(isFound ? "lost" : "found", str(post, "owner_id")).all<Row>()).results ?? [];
  const foundRows = isFound ? [post] : others;
  const [ink, courses] = await Promise.all([
    inkFor(env, foundRows.map((row) => num(row, "id"))),
    coursesById(env, [post, ...others].map((row) => (row.course_id == null ? null : num(row, "course_id")))),
  ]);
  const where = (row: Row) => {
    const course = row.course_id == null ? null : courses.get(num(row, "course_id"));
    return { courseId: row.course_id == null ? null : num(row, "course_id"), lat: course?.lat ?? null, lng: course?.lng ?? null };
  };
  const foundSide = (row: Row): FoundSide => {
    const read = ink.get(num(row, "id"));
    return { ...where(row), brand: str(row, "brand"), mold: str(row, "mold"), plastic: str(row, "plastic"), color: str(row, "color"),
      aiColors: read?.colors ?? [], date: row.event_date ? str(row, "event_date") : null, ink: read?.keys ?? { names: [], phones: [], initials: [] } };
  };
  const lostSide = async (row: Row): Promise<LostSide> => ({
    ...where(row), brand: str(row, "brand"), mold: str(row, "mold"), plastic: str(row, "plastic"), color: str(row, "color"),
    date: row.event_date ? str(row, "event_date") : null, privateInk: str(row, "private_ink"), memberName: await memberName(env, str(row, "owner_id")),
  });

  const candidates: Candidate[] = [];
  for (const other of others) {
    const found = isFound ? post : other;
    const lost = isFound ? other : post;
    const result = scoreMatch(foundSide(found), await lostSide(lost));
    if (result.score >= STORE_THRESHOLD || result.identity) {
      candidates.push({ found, lost, candidateId: str(lost, "owner_id"), score: result.score, reasons: result.reasons });
    }
  }
  // A club member's full name written on a found disc: tell that member directly (when exactly one matches).
  if (isFound) {
    const names = ink.get(postId)?.keys.names ?? [];
    if (names.length) {
      const memberId = rosterNameMatch(names, await listMembers(env.ROSTER).catch(() => []));
      if (memberId && memberId !== str(post, "owner_id") && !candidates.some((row) => row.candidateId === memberId)) {
        candidates.push({ found: post, lost: null, candidateId: memberId, score: 70, reasons: ["member_name"] });
      }
    }
  }
  for (const candidate of candidates) {
    await env.DB.prepare(
      `INSERT INTO lf_matches (found_id, lost_id, candidate_id, score, reasons) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(found_id, candidate_id) DO UPDATE SET score = CASE WHEN lf_matches.ai_verdict IS NULL THEN excluded.score ELSE lf_matches.score END,
         reasons = excluded.reasons, lost_id = COALESCE(excluded.lost_id, lf_matches.lost_id), updated_at = datetime('now')
       WHERE lf_matches.status IN ('suggested', 'notified')`,
    ).bind(num(candidate.found, "id"), candidate.lost ? num(candidate.lost, "id") : null, candidate.candidateId, candidate.score, JSON.stringify(candidate.reasons)).run();
  }
  return candidates;
}

/** Up to MAX_COMPARES Gemini "same physical disc?" checks for a post's middling matches. */
export async function compareTopMatches(env: Env, postId: number): Promise<number> {
  if (!env.PHOTOS) return 0;
  const post = await env.DB.prepare("SELECT kind, ai_compares FROM lf_posts WHERE id = ?").bind(postId).first<{ kind: string; ai_compares: number }>();
  if (!post || post.ai_compares >= MAX_COMPARES) return 0;
  const column = post.kind === "found" ? "found_id" : "lost_id";
  const rows = (await env.DB.prepare(
    `SELECT id, found_id, lost_id, score FROM lf_matches WHERE ${column} = ? AND lost_id IS NOT NULL AND ai_verdict IS NULL
       AND status IN ('suggested', 'notified') AND score BETWEEN 35 AND 79 ORDER BY score DESC LIMIT ?`,
  ).bind(postId, MAX_COMPARES - post.ai_compares).all<{ id: number; found_id: number; lost_id: number; score: number }>()).results ?? [];
  let done = 0;
  for (const match of rows) {
    const originals = (await env.DB.prepare(
      `SELECT post_id, original_key, original_type FROM lf_photos WHERE post_id IN (?, ?) AND original_key IS NOT NULL AND redaction <> 'removed'
       ORDER BY sort_order, id`,
    ).bind(match.found_id, match.lost_id).all<{ post_id: number; original_key: string; original_type: string }>()).results ?? [];
    const a = originals.find((row) => row.post_id === match.found_id);
    const b = originals.find((row) => row.post_id === match.lost_id);
    if (!a || !b) continue;
    if (await visionSlot(env)) break; // optional: only when the budget and the per-minute cap have room
    const claimed = await env.DB.prepare("UPDATE lf_posts SET ai_compares = ai_compares + 1 WHERE id = ? AND ai_compares < ?").bind(postId, MAX_COMPARES).run();
    if (!((claimed.meta?.changes ?? 0) > 0)) break;
    const [objA, objB] = await Promise.all([env.PHOTOS.get(a.original_key), env.PHOTOS.get(b.original_key)]);
    if (!objA || !objB) continue;
    const verdict = await compareDiscPhotos(env,
      { bytes: new Uint8Array(await objA.arrayBuffer()), type: a.original_type },
      { bytes: new Uint8Array(await objB.arrayBuffer()), type: b.original_type });
    done += 1;
    if (!verdict) continue;
    const delta = verdict === "same" ? 15 : verdict === "different" ? -15 : 0;
    await env.DB.prepare("UPDATE lf_matches SET ai_verdict = ?, score = MAX(0, MIN(100, score + ?)), updated_at = datetime('now') WHERE id = ?")
      .bind(verdict, delta, match.id).run();
  }
  return done;
}

/** Tell both sides about strong suggestions that have not been announced yet. */
export async function notifyStrongMatches(env: Env, ctx: WaitCtx, postId: number): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT m.id, m.found_id, m.lost_id, m.candidate_id, m.score, m.reasons FROM lf_matches m JOIN lf_posts p ON p.id = m.found_id
     WHERE (m.found_id = ? OR m.lost_id = ?) AND m.status = 'suggested' AND p.status = 'open' AND p.hidden = 0
       AND (m.score >= 55 OR m.reasons LIKE '%"ink_phone"%' OR (m.reasons LIKE '%name"%' AND m.score >= 45))`,
  ).bind(postId, postId).all<{ id: number; found_id: number; lost_id: number | null; candidate_id: string; score: number; reasons: string }>()).results ?? [];
  let sent = 0;
  for (const match of rows) {
    const flipped = await env.DB.prepare("UPDATE lf_matches SET status = 'notified', notified_at = datetime('now') WHERE id = ? AND status = 'suggested'")
      .bind(match.id).run();
    if (!((flipped.meta?.changes ?? 0) > 0)) continue;
    const found = await getPostRow(env, match.found_id);
    if (!found) continue;
    const title = postTitle(found);
    const where = str(found, "course_name") ? " at " + str(found, "course_name") : "";
    await deliverLfNote(env, ctx, match.candidate_id, {
      title: "Is this your disc?",
      body: match.lost_id
        ? `A ${title} found${where} looks like the disc you lost. Take a look and tell us if it's yours.`
        : `A disc that may be yours was found${where}: ${title}. Take a look and tell us if it's yours.`,
      refKey: "lf:match:" + match.id,
      hash: "match/" + match.id,
    });
    await deliverLfNote(env, ctx, str(found, "owner_id"), {
      title: "Someone may own the disc you found",
      body: match.lost_id
        ? `Your ${title} matches someone's lost post. We asked them if it's theirs.`
        : `We let a possible owner of your ${title} know. You'll hear from us if they claim it.`,
      refKey: "lf:match:" + match.id + ":finder",
      hash: "post/" + match.found_id,
    });
    sent += 1;
  }
  return sent;
}

function logFailure(message: string, id: number, error: unknown): void {
  console.error(JSON.stringify({ message, id, error: error instanceof Error ? error.message : String(error) }));
}

async function duePhotos(env: Env, column: "post_id" | "celebration_id", id: number, status: string): Promise<number[]> {
  const rows = (await env.DB.prepare(
    `SELECT id FROM lf_photos WHERE ${column} = ? AND redaction = ? AND next_attempt_at <= datetime('now') ORDER BY sort_order, id`,
  ).bind(id, status).all<{ id: number }>()).results ?? [];
  return rows.map((row) => row.id);
}

/** Details, matches, the optional photo compare and notices for one post. Uses the stored reads only. */
export async function matchPost(env: Env, ctx: WaitCtx, postId: number, compare = true): Promise<void> {
  await applyExtraction(env, postId);
  await runMatching(env, postId);
  if (compare) await compareTopMatches(env, postId);
  await notifyStrongMatches(env, ctx, postId);
}

/** After a post is created: (1) the AI reads, then (2) details, matching, compare and notices. Hiding the writing
 *  happens in the poster's browser; matching never waits for it. Each step runs even if the one before failed. */
export async function processPost(env: Env, ctx: WaitCtx, postId: number): Promise<void> {
  try {
    for (const photoId of await duePhotos(env, "post_id", postId, "pending")) await readPhoto(env, photoId);
  } catch (error) {
    logFailure("lf_read_failed", postId, error);
  }
  try {
    await matchPost(env, ctx, postId);
  } catch (error) {
    logFailure("lf_match_failed", postId, error);
  }
}

/** A celebration has no matching: only its reads (the poster's browser hides the writing afterwards). */
export async function processCelebration(env: Env, celebrationId: number): Promise<void> {
  try {
    for (const photoId of await duePhotos(env, "celebration_id", celebrationId, "pending")) await readPhoto(env, photoId);
  } catch (error) {
    logFailure("lf_celebration_process_failed", celebrationId, error);
  }
}

/** Delete a post's photos from R2: originals always; public copies too unless keepPublic. Idempotent. */
export async function purgePostPhotos(env: Env, postId: number, keepPublic: boolean): Promise<number> {
  const rows = (await env.DB.prepare("SELECT id, original_key, candidate_key, public_key FROM lf_photos WHERE post_id = ?")
    .bind(postId).all<{ id: number; original_key: string | null; candidate_key: string | null; public_key: string | null }>()).results ?? [];
  let deleted = 0;
  for (const row of rows) {
    for (const key of [row.original_key, row.candidate_key]) {
      if (!key) continue;
      await env.PHOTOS?.delete(key);
      deleted += 1;
    }
    if (!keepPublic && row.public_key) {
      await env.PHOTOS?.delete(row.public_key);
      deleted += 1;
    }
    await env.DB.prepare(keepPublic
      ? "UPDATE lf_photos SET original_key = NULL, candidate_key = NULL, redaction = CASE WHEN redaction = 'public' THEN 'public' ELSE 'removed' END WHERE id = ?"
      : "UPDATE lf_photos SET original_key = NULL, candidate_key = NULL, public_key = NULL, redaction = 'removed' WHERE id = ?").bind(row.id).run();
  }
  return deleted;
}

export interface TickResult { expired: number; purged: number; reads: number; matched: number; verified: number; published: number }

/** Cron, cheapest first: expire 90-day posts and purge photos of finished posts; then the due AI reads and the
 *  matching and notices they feed; then the due verifications. I/O only, bounded per tick. */
export async function runLostFoundTick(env: Env): Promise<TickResult> {
  const result: TickResult = { expired: 0, purged: 0, reads: 0, matched: 0, verified: 0, published: 0 };
  const expiring = (await env.DB.prepare(
    "SELECT id FROM lf_posts WHERE status = 'open' AND expires_at <= datetime('now') ORDER BY expires_at LIMIT 25",
  ).all<{ id: number }>()).results ?? [];
  for (const row of expiring) {
    const done = await env.DB.prepare(
      "UPDATE lf_posts SET status = 'expired', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'open'",
    ).bind(row.id).run();
    if ((done.meta?.changes ?? 0) > 0) {
      result.expired += 1;
      await env.DB.prepare("INSERT INTO lf_claim_log (post_id, actor_id, action, from_status, to_status, note) VALUES (?, 'system', 'expire', 'open', 'expired', '90 days')")
        .bind(row.id).run();
    }
  }
  // Finished posts keep no originals; closed / expired / merged ones keep no public copies either.
  const finished = (await env.DB.prepare(
    `SELECT DISTINCT p.id, p.status FROM lf_posts p JOIN lf_photos ph ON ph.post_id = p.id
     WHERE p.status IN ('closed', 'expired', 'merged', 'returned')
       AND (ph.original_key IS NOT NULL OR ph.candidate_key IS NOT NULL OR (p.status <> 'returned' AND ph.public_key IS NOT NULL)) LIMIT 25`,
  ).all<{ id: number; status: string }>()).results ?? [];
  for (const row of finished) result.purged += await purgePostPhotos(env, row.id, row.status === "returned");

  const reads = (await env.DB.prepare(
    "SELECT id, post_id FROM lf_photos WHERE redaction = 'pending' AND next_attempt_at <= datetime('now') ORDER BY next_attempt_at, id LIMIT ?",
  ).bind(TICK_READS).all<{ id: number; post_id: number | null }>()).results ?? [];
  const posts = new Set<number>();
  for (const photo of reads) {
    const outcome = await readPhoto(env, photo.id);
    if (outcome !== "skipped") result.reads += 1;
    if (photo.post_id && outcome === "read") posts.add(photo.post_id);
  }
  for (const postId of posts) {
    try {
      await matchPost(env, undefined, postId);
      result.matched += 1;
    } catch (error) {
      logFailure("lf_tick_match_failed", postId, error);
    }
  }

  const checks = (await env.DB.prepare(
    "SELECT id FROM lf_photos WHERE redaction = 'verifying' AND next_attempt_at <= datetime('now') ORDER BY next_attempt_at, id LIMIT ?",
  ).bind(TICK_VERIFIES).all<{ id: number }>()).results ?? [];
  for (const photo of checks) {
    const outcome = await verifyPhoto(env, photo.id);
    if (outcome !== "skipped") result.verified += 1;
    if (outcome === "public") result.published += 1;
  }
  return result;
}
