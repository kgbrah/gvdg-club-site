// Marketplace listings checked against Lost & Found lost posts: when a disc is listed (or edited), and when a new lost
// post arrives, an active listing of the same mold is compared with open lost posts. Only a strong match alerts, and
// only the seller ("this disc may be one someone reported lost"), with a link to the public lost post:
//   - the AI reads the owner's writing on the listing photo (their phone number or full name from the lost post's
//     private "what's written on it"; initials count when brand, colour and weight agree too), or
//   - the AI says the listing photo and the lost post's photo show the same physical disc.
// Same mold and colour alone never alert. The AI runs only when such a lost post exists, inside the Lost & Found
// daily vision budget, at most once per listing photo read and MAX_PAIR_COMPARES photo compares per listing.
// Nothing here is shown to anyone but the seller; the lost poster's private text never leaves the server.
import type { Env } from "./env.js";
import { deliverLfNote } from "./lf-notify.js";
import { scoreMatch, type FoundSide, type LostSide } from "./lf-match.js";
import { CANDIDATE_DAYS, visionSlot } from "./lf-process.js";
import { postTitle, withArticle } from "./lf-store.js";
import { compareDiscPhotos, extractDisc, inkKeys, type InkKeys } from "./lf-vision.js";
import { num, numOrNull, str, type Row } from "./market-store.js";
import { getMember } from "./roster.js";
import { notifyAdmins } from "./admin-push.js";
import { isGuestId } from "./market-notify.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
export const MAX_PAIR_COMPARES = 2;
const MAX_LOST = 20;
const MAX_LISTINGS = 20;
const NO_INK: InkKeys = { names: [], phones: [], initials: [] };
const OPEN_LOST = "p.kind = 'lost' AND p.status = 'open' AND p.hidden = 0 AND p.expires_at > datetime('now')";
// Only disc listings: a bag or an accessory for sale is never checked against lost discs.
const ACTIVE_LISTING = "l.status = 'active' AND l.hidden = 0 AND l.item_kind = 'disc'";

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

function listingTitle(row: Row): string {
  return [str(row, "brand"), str(row, "plastic"), str(row, "mold")].map((part) => part.trim()).filter(Boolean).join(" ") || "disc";
}

async function firstListingPhoto(env: Env, listingId: number) {
  return env.DB.prepare("SELECT r2_key, content_type FROM market_listing_photos WHERE listing_id = ? ORDER BY sort_order, id LIMIT 1")
    .bind(listingId).first<{ r2_key: string; content_type: string }>();
}

/** The listing photo's writing, read once (privately) and kept for later checks. null = not read (no budget). */
async function listingInk(env: Env, listingId: number, cache: Map<number, InkKeys | null>): Promise<InkKeys | null> {
  if (cache.has(listingId)) return cache.get(listingId)!;
  const stored = await env.DB.prepare("SELECT ink_names, ink_phones, ink_initials FROM market_listing_reads WHERE listing_id = ?").bind(listingId)
    .first<{ ink_names: string; ink_phones: string; ink_initials: string }>();
  const parse = (value: string) => { try { const list = JSON.parse(value) as unknown; return Array.isArray(list) ? list.map(String) : []; } catch { return []; } };
  if (stored) {
    const keys = { names: parse(stored.ink_names), phones: parse(stored.ink_phones), initials: parse(stored.ink_initials) };
    cache.set(listingId, keys);
    return keys;
  }
  const photo = await firstListingPhoto(env, listingId);
  const obj = photo && env.PHOTOS ? await env.PHOTOS.get(photo.r2_key) : null;
  if (!photo || !obj) { cache.set(listingId, NO_INK); return NO_INK; }
  if (await visionSlot(env)) { cache.set(listingId, null); return null; }
  const read = await extractDisc(env, new Uint8Array(await obj.arrayBuffer()), photo.content_type);
  if (read.status === "empty" || read.quota) { cache.set(listingId, null); return null; }
  const keys = inkKeys(read.ink);
  await env.DB.prepare(
    `INSERT INTO market_listing_reads (listing_id, ink_names, ink_phones, ink_initials) VALUES (?, ?, ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET ink_names = excluded.ink_names, ink_phones = excluded.ink_phones, ink_initials = excluded.ink_initials,
       read_at = datetime('now')`,
  ).bind(listingId, JSON.stringify(keys.names), JSON.stringify(keys.phones), JSON.stringify(keys.initials)).run();
  cache.set(listingId, keys);
  return keys;
}

async function memberName(env: Env, ownerId: string): Promise<string | null> {
  if (isGuestId(ownerId)) return null;
  return (await getMember(env.ROSTER, ownerId).catch(() => null))?.name ?? null;
}

interface PairState { inkCache: Map<number, InkKeys | null>; compares: Map<number, number> }

/** One listing against one lost post: "strong" (alert sent), "weak" (no alert), or null (couldn't decide yet). */
async function checkPair(env: Env, ctx: WaitCtx, listing: Row, lost: Row, state: PairState): Promise<"strong" | "weak" | null> {
  const listingId = num(listing, "id");
  const lostId = num(lost, "id");
  const done = await env.DB.prepare("SELECT verdict FROM market_lost_checks WHERE listing_id = ? AND lost_id = ?").bind(listingId, lostId)
    .first<{ verdict: string }>();
  if (done) return done.verdict === "strong" ? "strong" : "weak";
  const sideOf = (ink: InkKeys): FoundSide => ({
    courseId: null, lat: null, lng: null, brand: str(listing, "brand"), mold: str(listing, "mold"), plastic: str(listing, "plastic"),
    color: str(listing, "color"), weightG: numOrNull(listing, "weight_g"), hole: null, aiColors: [], date: null, ink,
  });
  const lostSide: LostSide = {
    courseId: null, lat: null, lng: null, brand: str(lost, "brand"), mold: str(lost, "mold"), plastic: str(lost, "plastic"), color: str(lost, "color"),
    weightG: numOrNull(lost, "weight_g"), hole: null, date: null, privateInk: str(lost, "private_ink"), memberName: await memberName(env, str(lost, "owner_id")),
  };
  const plain = scoreMatch(sideOf(NO_INK), lostSide);
  const brandsAgree = !norm(lostSide.brand) || !str(listing, "brand").trim() || norm(lostSide.brand) === norm(listing.brand);
  if (!brandsAgree || plain.reasons.some((code) => code.endsWith("_mismatch"))) return record(env, listingId, lostId, "weak");
  let verdict: "strong" | "weak" | null = "weak";
  let reasons = plain.reasons;
  // 1. The owner's writing on the listing photo.
  if (str(lost, "private_ink").trim() || lostSide.memberName) {
    const ink = await listingInk(env, listingId, state.inkCache);
    if (ink == null) verdict = null;
    else {
      const scored = scoreMatch(sideOf(ink), lostSide);
      if (scored.identity || scored.reasons.includes("ink_initials")) { verdict = "strong"; reasons = scored.reasons; }
    }
  }
  // 2. The two photos show the same disc.
  if (verdict !== "strong" && (state.compares.get(listingId) ?? 0) < MAX_PAIR_COMPARES && env.PHOTOS) {
    const lostPhoto = await env.DB.prepare(
      "SELECT photo_key, photo_type FROM lf_photos WHERE post_id = ? AND photo_key IS NOT NULL AND status = 'public' ORDER BY sort_order, id LIMIT 1",
    ).bind(lostId).first<{ photo_key: string; photo_type: string }>();
    const listingPhoto = lostPhoto ? await firstListingPhoto(env, listingId) : null;
    if (lostPhoto && listingPhoto) {
      if (await visionSlot(env)) verdict = null; // no AI budget right now: decide on a later trigger
      else {
        state.compares.set(listingId, (state.compares.get(listingId) ?? 0) + 1);
        const [a, b] = await Promise.all([env.PHOTOS.get(listingPhoto.r2_key), env.PHOTOS.get(lostPhoto.photo_key)]);
        const same = a && b ? await compareDiscPhotos(env,
          { bytes: new Uint8Array(await a.arrayBuffer()), type: listingPhoto.content_type },
          { bytes: new Uint8Array(await b.arrayBuffer()), type: lostPhoto.photo_type }) : null;
        if (same === "same") { verdict = "strong"; reasons = [...reasons, "photo_same"]; }
        else if (same == null) verdict = null;
      }
    }
  }
  if (verdict == null) return null; // try again on the next trigger (no AI budget right now)
  await record(env, listingId, lostId, verdict, reasons);
  if (verdict === "strong") {
    const where = str(lost, "course_name") ? " at " + str(lost, "course_name") : "";
    await deliverLfNote(env, ctx, str(listing, "seller_id"), {
      title: "A disc you listed may be someone's lost disc",
      body: `Your ${listingTitle(listing)} listing looks a lot like ${withArticle(postTitle(lost))} someone reported lost${where}. `
        + "If it could be theirs, please take a look at their post before you sell it.",
      refKey: `mkt:lost:${listingId}:${lostId}`,
      hash: "post/" + lostId,
    });
    // The listing is up for sale: the admins review it (Admin > Marketplace > Possible lost discs for sale).
    notifyAdmins(ctx, env, {
      title: "Possible lost disc for sale",
      body: `${withArticle(listingTitle(listing)).replace(/^a/, "A")} listing looks like ${withArticle(postTitle(lost))} reported lost. Please review it.`,
      url: "/admin.html#marketplace",
      tag: `market-lost:${listingId}:${lostId}`,
    });
  }
  return verdict;
}

async function record(env: Env, listingId: number, lostId: number, verdict: "strong" | "weak", reasons: readonly string[] = []): Promise<"strong" | "weak"> {
  await env.DB.prepare("INSERT INTO market_lost_checks (listing_id, lost_id, verdict, reasons) VALUES (?, ?, ?, ?) ON CONFLICT(listing_id, lost_id) DO NOTHING")
    .bind(listingId, lostId, verdict, JSON.stringify(reasons)).run();
  return verdict;
}

/** A new or edited listing against open lost posts of the same mold. Returns how many strong matches were alerted. */
export async function checkListingAgainstLost(env: Env, ctx: WaitCtx, listingId: number): Promise<number> {
  const listing = await env.DB.prepare(`SELECT l.* FROM market_listings l WHERE l.id = ? AND ${ACTIVE_LISTING}`).bind(listingId).first<Row>();
  const mold = norm(listing?.mold);
  if (!listing || !mold) return 0;
  const lost = (await env.DB.prepare(
    `SELECT p.* FROM lf_posts p WHERE ${OPEN_LOST} AND lower(trim(p.mold)) = ? AND p.owner_id <> ?
       AND p.created_at >= datetime('now', '-${CANDIDATE_DAYS} days') ORDER BY p.id DESC LIMIT ${MAX_LOST}`,
  ).bind(mold, str(listing, "seller_id")).all<Row>()).results ?? [];
  const state: PairState = { inkCache: new Map(), compares: new Map() };
  let strong = 0;
  for (const post of lost) if ((await checkPair(env, ctx, listing, post, state)) === "strong") strong += 1;
  return strong;
}

/** A new lost post against active listings of the same mold (their sellers are alerted on a strong match). */
export async function checkLostAgainstListings(env: Env, ctx: WaitCtx, lostId: number): Promise<number> {
  const lost = await env.DB.prepare(`SELECT p.* FROM lf_posts p WHERE p.id = ? AND ${OPEN_LOST}`).bind(lostId).first<Row>();
  const mold = norm(lost?.mold);
  if (!lost || !mold) return 0;
  const listings = (await env.DB.prepare(
    `SELECT l.* FROM market_listings l WHERE ${ACTIVE_LISTING} AND lower(trim(l.mold)) = ? AND l.seller_id <> ? ORDER BY l.id DESC LIMIT ${MAX_LISTINGS}`,
  ).bind(mold, str(lost, "owner_id")).all<Row>()).results ?? [];
  const state: PairState = { inkCache: new Map(), compares: new Map() };
  let strong = 0;
  for (const listing of listings) if ((await checkPair(env, ctx, listing, lost, state)) === "strong") strong += 1;
  return strong;
}

/** Fire and forget from a request (a check never fails or slows the response). */
export function queueListingCheck(env: Env, ctx: WaitCtx, listingId: number): void {
  queue(ctx, checkListingAgainstLost(env, ctx, listingId), "listing", listingId);
}

export function queueLostCheck(env: Env, ctx: WaitCtx, lostId: number): void {
  queue(ctx, checkLostAgainstListings(env, ctx, lostId), "lost", lostId);
}

function queue(ctx: WaitCtx, job: Promise<number>, kind: string, id: number): void {
  const settled = job.catch((error) => {
    console.error(JSON.stringify({ message: "market_lost_check_failed", kind, id, error: error instanceof Error ? error.message : String(error) }));
  });
  try { ctx?.waitUntil?.(settled); } catch { /* settles on its own */ }
}
