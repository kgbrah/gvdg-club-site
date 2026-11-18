// Lost & Found matches and claims. A human always decides: the possible owner answers "That's mine" or "Not
// mine"; the finder marks the disc returned; the owner confirms "I got it back"; only then does the finder
// earn karma (+10, once per return, never for returning a disc to themselves).
//
// State machine (every transition is a compare-and-set UPDATE written to lf_claim_log):
//   match  suggested | notified --That's mine--> claimed ; --Not mine--> declined
//   claim  open --finder: Returned--> returned --owner: I got it back--> confirmed (+10 karma)
//          returned --owner: Not yet--> open ; open --owner: cancel--> cancelled ; open --finder: decline--> declined
//   post   open --claim--> claimed --confirmed--> returned
//
// Contact once claimed: two members get a direct message thread (member-messages.ts); when either side is a
// guest the claim page carries a relayed thread and each message is emailed to the guest. No address is
// ever shown.

import { readJson } from "./http.js";
import { parseMessage } from "./lf-input.js";
import { lfUrl, notifyPerson } from "./lf-notify.js";
import { purgePostPhotos } from "./lf-process.js";
import {
  KARMA_PER_RETURN, MATCH_COLUMNS, getClaimRow, getPostRow, logClaim, matchReasonLabels, parseReasons, people, postCards,
  postTitle, strength,
} from "./lf-store.js";
import { requirePerson } from "./lf-posts.js";
import { emailConfigured, isGuestId, sendMarketEmail, traderEmail } from "./market-notify.js";
import { changed, fail, limited, ok, type MarketCtx } from "./market-http.js";
import { ensureTrader, num, str, viewerOf, type Actor, type Row } from "./market-store.js";
import { sendMemberDirectMessage } from "./member-messages.js";

async function getMatchRow(c: MarketCtx, id: number): Promise<Row | null> {
  return c.env.DB.prepare(`SELECT ${MATCH_COLUMNS} FROM lf_matches m WHERE m.id = ?`).bind(id).first<Row>();
}

/** The possible owner's "Is this yours?" view. Only they (and admins) can open it; the finder never sees the
 *  owner's private description. */
export async function getMatch(c: MarketCtx, id: number): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const match = await getMatchRow(c, id);
  if (!match || (str(match, "candidate_id") !== me.id && !me.isAdmin)) return fail(c, 404, "not_found");
  const found = await getPostRow(c.env, num(match, "found_id"));
  if (!found || (num(found, "hidden") === 1 && !me.isAdmin)) return fail(c, 404, "not_found");
  const [card] = await postCards(c.env, [found], me.id);
  const lost = match.lost_id != null ? await getPostRow(c.env, num(match, "lost_id")) : null;
  const claim = await c.env.DB.prepare("SELECT id, status FROM lf_claims WHERE found_id = ? AND owner_id = ? ORDER BY id DESC LIMIT 1")
    .bind(num(match, "found_id"), me.id).first<{ id: number; status: string }>();
  const status = str(match, "status");
  const live = card!.status === "open" || card!.status === "claimed";
  return ok(c, {
    match: {
      id,
      status,
      strength: strength(num(match, "score")),
      reasons: matchReasonLabels(parseReasons(match.reasons)),
      found: card,
      lost: lost ? { id: num(lost, "id"), title: postTitle(lost) } : null,
      claim: claim ? { id: claim.id, status: claim.status } : null,
      canDecide: live && (status === "suggested" || status === "notified") && !(claim && (claim.status === "open" || claim.status === "returned")),
    },
    viewer: await viewerOf(c.env, c.actor),
  });
}

export async function declineMatch(c: MarketCtx, id: number): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const match = await getMatchRow(c, id);
  if (!match || str(match, "candidate_id") !== me.id) return fail(c, 404, "not_found");
  const result = await c.env.DB.prepare(
    "UPDATE lf_matches SET status = 'declined', updated_at = datetime('now') WHERE id = ? AND candidate_id = ? AND status IN ('suggested', 'notified')",
  ).bind(id, me.id).run();
  if (!changed(result)) return fail(c, 409, "not_open");
  await logClaim(c.env, { postId: num(match, "found_id"), actorId: me.id, action: "not_mine", note: "match " + id });
  return ok(c, { ok: true });
}

export async function acceptMatch(c: MarketCtx, id: number): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const match = await getMatchRow(c, id);
  if (!match || str(match, "candidate_id") !== me.id) return fail(c, 404, "not_found");
  if (!["suggested", "notified"].includes(str(match, "status"))) return fail(c, 409, "not_open");
  return openClaim(c, me, num(match, "found_id"), match);
}

export async function claimPost(c: MarketCtx, postId: number): Promise<Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const match = await c.env.DB.prepare(
    `SELECT ${MATCH_COLUMNS} FROM lf_matches m WHERE m.found_id = ? AND m.candidate_id = ? AND m.status IN ('suggested', 'notified')`,
  ).bind(postId, me.id).first<Row>();
  return openClaim(c, me, postId, match);
}

async function openClaim(c: MarketCtx, me: Actor, postId: number, match: Row | null): Promise<Response> {
  const post = await getPostRow(c.env, postId);
  if (!post || num(post, "hidden") === 1 || str(post, "kind") !== "found") return fail(c, 404, "not_found");
  const finderId = str(post, "owner_id");
  if (finderId === me.id) return fail(c, 403, "own_post");
  if (!["open", "claimed"].includes(str(post, "status"))) return fail(c, 409, "not_open");
  const body = (await readJson(c.request)) ?? {};
  const typed = body.message == null || body.message === "" ? "" : parseMessage(body.message);
  if (typed == null) return fail(c, 400, "invalid_claim", "message");
  // A direct claim (no suggestion) must say why it's yours, so the finder can check.
  if (!match && typed.length < 8) return fail(c, 400, "invalid_claim", "message");
  const blocked = await limited(c, "lfclaim:" + me.id, 10, 3600);
  if (blocked) return blocked;
  await ensureTrader(c.env, me);
  const message = typed || "That's mine — the suggestion matched my disc.";
  let claimId = 0;
  try {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO lf_claims (found_id, lost_id, match_id, finder_id, owner_id, message) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(postId, match?.lost_id ?? null, match ? num(match, "id") : null, finderId, me.id, message).first<{ id: number }>();
    claimId = Number(inserted?.id) || 0;
  } catch {
    claimId = 0;
  }
  if (!claimId) return fail(c, 409, "already_claimed");
  if (match) {
    await c.env.DB.prepare("UPDATE lf_matches SET status = 'claimed', updated_at = datetime('now') WHERE id = ?").bind(num(match, "id")).run();
  }
  await c.env.DB.prepare("UPDATE lf_posts SET status = 'claimed', updated_at = datetime('now') WHERE id = ? AND status = 'open'").bind(postId).run();
  await logClaim(c.env, { claimId, postId, actorId: me.id, action: "claim", to: "open", note: match ? "from match " + num(match, "id") : "direct" });
  const title = postTitle(post);
  if (!isGuestId(me.id) && !isGuestId(finderId)) {
    const thread = await sendMemberDirectMessage(c.env, c.ctx, me.id, finderId,
      `Lost & Found: I think the ${title} you found is mine. ${message}\n${lfUrl(c.env, "claim/" + claimId)}`).catch(() => null);
    if (thread) await c.env.DB.prepare("UPDATE lf_claims SET dm_thread_id = ? WHERE id = ?").bind(thread, claimId).run();
  } else {
    await c.env.DB.prepare("INSERT INTO lf_messages (claim_id, sender_id, body) VALUES (?, ?, ?)").bind(claimId, me.id, message).run();
  }
  notifyPerson(c.env, c.ctx, finderId, {
    title: "Someone says it's their disc",
    body: `${me.name}${me.kind === "guest" ? " (guest)" : ""} says the ${title} you found is theirs. Check their message and arrange the return.`,
    refKey: "lf:claim:" + claimId + ":new",
    hash: "claim/" + claimId,
  });
  return ok(c, { claim: await claimView(c, (await getClaimRow(c.env, claimId))!, me) }, 201);
}

async function messagesOf(c: MarketCtx, claimId: number, me: Actor) {
  const rows = (await c.env.DB.prepare("SELECT id, sender_id, body, created_at FROM lf_messages WHERE claim_id = ? ORDER BY id LIMIT 200")
    .bind(claimId).all<Row>()).results ?? [];
  return rows.map((row) => ({ id: num(row, "id"), body: str(row, "body"), mine: str(row, "sender_id") === me.id, at: str(row, "created_at") }));
}

export async function claimView(c: MarketCtx, row: Row, me: Actor) {
  const id = num(row, "id");
  const finderId = str(row, "finder_id");
  const ownerId = str(row, "owner_id");
  const role = me.id === finderId ? "finder" : me.id === ownerId ? "owner" : "admin";
  const post = await getPostRow(c.env, num(row, "found_id"));
  const [card] = post ? await postCards(c.env, [post], me.id) : [null];
  const person = await people(c.env, [finderId, ownerId]);
  const status = str(row, "status");
  const reversed = await c.env.DB.prepare("SELECT 1 AS hit FROM lf_karma WHERE claim_id = ? AND reason = 'admin_reversal'").bind(id).first();
  const celebrated = await c.env.DB.prepare("SELECT id, author_id FROM lf_celebrations WHERE claim_id = ?").bind(id).all<{ id: number; author_id: string }>();
  const mineCelebrated = (celebrated.results ?? []).some((row2) => row2.author_id === me.id);
  const dm = row.dm_thread_id != null;
  return {
    id,
    status,
    role,
    found: card,
    message: str(row, "message"),
    finder: person(finderId),
    owner: person(ownerId),
    createdAt: str(row, "created_at"),
    returnedAt: row.returned_at ? str(row, "returned_at") : null,
    confirmedAt: row.confirmed_at ? str(row, "confirmed_at") : null,
    contact: dm
      ? { kind: "dm", href: `gvdg-members.html#messages?thread=${num(row, "dm_thread_id")}` }
      : { kind: "relay", messages: role === "admin" ? [] : await messagesOf(c, id, me) },
    karma: status === "confirmed" ? { awarded: !reversed, points: reversed ? 0 : KARMA_PER_RETURN } : null,
    canReturn: role === "finder" && status === "open",
    canDecline: role === "finder" && status === "open",
    canConfirm: role === "owner" && status === "returned",
    canDispute: role === "owner" && status === "returned",
    canCancel: role === "owner" && status === "open",
    canMessage: !dm && (role === "finder" || role === "owner") && (status === "open" || status === "returned" || status === "confirmed"),
    canCelebrate: (role === "finder" || role === "owner") && status === "confirmed" && !reversed && !mineCelebrated,
    celebrated: mineCelebrated,
  };
}

async function partyClaim(c: MarketCtx, id: number): Promise<{ me: Actor; row: Row } | Response> {
  const me = requirePerson(c);
  if (me instanceof Response) return me;
  const row = await getClaimRow(c.env, id);
  // Non-parties (including other members) get a 404, never a 403, so claim ids can't be probed.
  if (!row || (str(row, "finder_id") !== me.id && str(row, "owner_id") !== me.id && !me.isAdmin)) return fail(c, 404, "not_found");
  return { me, row };
}

export async function getClaim(c: MarketCtx, id: number): Promise<Response> {
  const party = await partyClaim(c, id);
  if (party instanceof Response) return party;
  return ok(c, { claim: await claimView(c, party.row, party.me), viewer: await viewerOf(c.env, c.actor) });
}

export async function postClaimMessage(c: MarketCtx, id: number): Promise<Response> {
  const party = await partyClaim(c, id);
  if (party instanceof Response) return party;
  const { me, row } = party;
  if (me.id !== str(row, "finder_id") && me.id !== str(row, "owner_id")) return fail(c, 404, "not_found");
  if (row.dm_thread_id != null) return fail(c, 409, "use_messages");
  if (!["open", "returned", "confirmed"].includes(str(row, "status"))) return fail(c, 409, "not_open");
  const body = (await readJson(c.request)) ?? {};
  const text = parseMessage(body.body);
  if (!text) return fail(c, 400, "invalid_message", "body");
  const blocked = await limited(c, "lfmsg:" + me.id, 30, 3600);
  if (blocked) return blocked;
  await c.env.DB.prepare("INSERT INTO lf_messages (claim_id, sender_id, body) VALUES (?, ?, ?)").bind(id, me.id, text).run();
  const other = me.id === str(row, "finder_id") ? str(row, "owner_id") : str(row, "finder_id");
  const post = await getPostRow(c.env, num(row, "found_id"));
  const title = post ? postTitle(post) : "disc";
  if (isGuestId(other)) {
    // Email relay: the guest reads the message; nobody's address is shared.
    const relay = (async () => {
      if (!emailConfigured(c.env)) return;
      const to = await traderEmail(c.env, other);
      if (!to) return;
      await sendMarketEmail(c.env, to, `Lost & Found: a message about the ${title}`, [
        `${me.name} wrote about the ${title}:`, "", text, "",
        "Reply on the claim page: " + lfUrl(c.env, "claim/" + id), "",
        "Your email address was not shared. - Greenville Disc Golf Club",
      ].join("\n"));
    })().catch(() => {});
    try { c.ctx?.waitUntil?.(relay); } catch { /* settles on its own */ }
  } else {
    notifyPerson(c.env, c.ctx, other, {
      title: "Lost & Found message", body: `${me.name}: ${text}`.slice(0, 170), refKey: "lf:msg:" + id + ":" + Date.now(), hash: "claim/" + id,
    });
  }
  return ok(c, { messages: await messagesOf(c, id, me) }, 201);
}

export async function claimAction(c: MarketCtx, id: number, action: string): Promise<Response> {
  const party = await partyClaim(c, id);
  if (party instanceof Response) return party;
  const { me, row } = party;
  const finderId = str(row, "finder_id");
  const ownerId = str(row, "owner_id");
  const foundId = num(row, "found_id");
  const post = await getPostRow(c.env, foundId);
  const title = post ? postTitle(post) : "disc";
  const byFinder = me.id === finderId;
  const byOwner = me.id === ownerId;

  if (action === "returned") {
    if (!byFinder) return fail(c, 404, "not_found");
    let result;
    try {
      result = await c.env.DB.prepare(
        "UPDATE lf_claims SET status = 'returned', returned_at = datetime('now') WHERE id = ? AND finder_id = ? AND status = 'open'",
      ).bind(id, me.id).run();
    } catch {
      return fail(c, 409, "return_in_progress");
    }
    if (!changed(result)) return fail(c, 409, "not_open");
    // Only one person gets the disc back: other open claims on it are closed.
    const others = (await c.env.DB.prepare("SELECT id, owner_id FROM lf_claims WHERE found_id = ? AND id <> ? AND status = 'open'")
      .bind(foundId, id).all<{ id: number; owner_id: string }>()).results ?? [];
    await c.env.DB.prepare("UPDATE lf_claims SET status = 'declined', closed_at = datetime('now') WHERE found_id = ? AND id <> ? AND status = 'open'")
      .bind(foundId, id).run();
    await logClaim(c.env, { claimId: id, postId: foundId, actorId: me.id, action: "returned", from: "open", to: "returned" });
    notifyPerson(c.env, c.ctx, ownerId, {
      title: "Did you get your disc back?",
      body: `${me.name} marked the ${title} as returned to you. Confirm you got it back so they get their karma.`,
      refKey: "lf:claim:" + id + ":returned", hash: "claim/" + id,
    });
    for (const other of others) {
      notifyPerson(c.env, c.ctx, other.owner_id, {
        title: "Lost & Found claim closed", body: `The finder returned the ${title} to someone else, so your claim was closed.`,
        refKey: "lf:claim:" + other.id + ":declined", hash: "mine",
      });
    }
  } else if (action === "confirm") {
    if (!byOwner) return fail(c, 404, "not_found");
    if (finderId === ownerId) return fail(c, 403, "own_post");
    const result = await c.env.DB.prepare(
      "UPDATE lf_claims SET status = 'confirmed', confirmed_at = datetime('now'), closed_at = datetime('now') WHERE id = ? AND owner_id = ? AND status = 'returned'",
    ).bind(id, me.id).run();
    if (!changed(result)) return fail(c, 409, "not_returned");
    // Karma: once per return (UNIQUE (claim_id, reason) in the append-only ledger), never to the owner.
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO lf_karma (person_id, claim_id, delta, reason, note) VALUES (?, ?, ?, 'return_confirmed', 'owner confirmed')",
    ).bind(finderId, id, KARMA_PER_RETURN).run();
    await c.env.DB.prepare(
      "UPDATE lf_posts SET status = 'returned', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('open', 'claimed')",
    ).bind(foundId).run();
    if (row.lost_id != null) {
      await c.env.DB.prepare(
        "UPDATE lf_posts SET status = 'returned', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND owner_id = ? AND status IN ('open', 'claimed')",
      ).bind(num(row, "lost_id"), ownerId).run();
    }
    await c.env.DB.prepare("UPDATE lf_matches SET status = 'dismissed', updated_at = datetime('now') WHERE found_id = ? AND status IN ('suggested', 'notified')")
      .bind(foundId).run();
    await logClaim(c.env, { claimId: id, postId: foundId, actorId: me.id, action: "confirm", from: "returned", to: "confirmed", note: "+" + KARMA_PER_RETURN + " karma" });
    // The disc is home: the private originals are no longer needed.
    await purgePostPhotos(c.env, foundId, true).catch(() => 0);
    notifyPerson(c.env, c.ctx, finderId, {
      title: `+${KARMA_PER_RETURN} karma: disc returned`,
      body: `${me.name} confirmed they got the ${title} back. Thanks for returning it! Post a celebration photo if you like.`,
      refKey: "lf:claim:" + id + ":confirmed", hash: "claim/" + id,
    });
  } else if (action === "not-yet") {
    if (!byOwner) return fail(c, 404, "not_found");
    const result = await c.env.DB.prepare("UPDATE lf_claims SET status = 'open', returned_at = NULL WHERE id = ? AND owner_id = ? AND status = 'returned'")
      .bind(id, me.id).run();
    if (!changed(result)) return fail(c, 409, "not_returned");
    await logClaim(c.env, { claimId: id, postId: foundId, actorId: me.id, action: "not_yet", from: "returned", to: "open" });
    notifyPerson(c.env, c.ctx, finderId, {
      title: "Not returned yet", body: `${me.name} says they don't have the ${title} back yet. Check your messages.`,
      refKey: "lf:claim:" + id + ":not-yet:" + Date.now(), hash: "claim/" + id,
    });
  } else if (action === "cancel" || action === "decline") {
    if ((action === "cancel" && !byOwner) || (action === "decline" && !byFinder)) return fail(c, 404, "not_found");
    const next = action === "cancel" ? "cancelled" : "declined";
    const result = await c.env.DB.prepare(`UPDATE lf_claims SET status = ?, closed_at = datetime('now') WHERE id = ? AND status = 'open'`)
      .bind(next, id).run();
    if (!changed(result)) return fail(c, 409, "not_open");
    const remaining = await c.env.DB.prepare("SELECT 1 AS hit FROM lf_claims WHERE found_id = ? AND status IN ('open', 'returned')").bind(foundId).first();
    if (!remaining) {
      await c.env.DB.prepare("UPDATE lf_posts SET status = 'open', updated_at = datetime('now') WHERE id = ? AND status = 'claimed'").bind(foundId).run();
    }
    await logClaim(c.env, { claimId: id, postId: foundId, actorId: me.id, action, from: "open", to: next });
    notifyPerson(c.env, c.ctx, byOwner ? finderId : ownerId, {
      title: "Lost & Found claim closed",
      body: byOwner ? `${me.name} withdrew their claim on the ${title}.` : `The finder says the ${title} isn't yours, so your claim was closed.`,
      refKey: "lf:claim:" + id + ":" + next, hash: byOwner ? "post/" + foundId : "mine",
    });
  } else {
    return fail(c, 404, "not_found");
  }
  return ok(c, { claim: await claimView(c, (await getClaimRow(c.env, id))!, me) });
}

