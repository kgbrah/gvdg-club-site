import { karmaKey } from "./karma-directory.js";
import type { Env } from "./env.js";
import { requireAuth } from "./authz.js";
import { json, readJson } from "./http.js";
import { asInt, asStr } from "./input.js";
import { kvRateLimited } from "./kv-rate-limit.js";
import { getMember } from "./roster.js";
import { settleBagTags, settleSummary, type TagPlayer } from "./bag-tags.js";
import * as tags from "./db-bag-tags.js";
import * as leagueDb from "./db-bag-tag-leagues.js";
import { ensureLeagueLadder, playerKey, relinkLeague } from "./bag-tag-leagues.js";
import { notifyAdmins } from "./admin-push.js";
import { notifyChallenge } from "./bag-tag-notify.js";

function scoreOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= -99 && value <= 400) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = parseInt(value, 10);
    if (parsed >= -99 && parsed <= 400) return parsed;
  }
  return null;
}

function tagOf(value: unknown): number | null {
  const parsed = asInt(value);
  return parsed != null && parsed >= 1 && parsed <= 500 ? parsed : null;
}

function publicHolder(row: tags.BagHolderRow, includeId: boolean) {
  return {
    tagNumber: row.tag_number,
    ...(includeId ? { memberId: row.member_id } : {}),
    name: row.member_name,
    karmaKey: karmaKey(row.member_id),
    heldSince: row.held_since,
  };
}

function publicMove(row: tags.BagMoveRow) {
  return { id: row.id, kind: row.kind, summary: row.summary, createdAt: row.created_at };
}

function publicRequest(row: tags.BagRequestRow) {
  return { memberId: row.member_id, name: row.member_name, createdAt: row.created_at };
}

function publicChallenge(row: tags.BagChallengeRow) {
  return {
    id: row.id,
    challengerId: row.challenger_id,
    challengerName: row.challenger_name,
    defenderId: row.defender_id,
    defenderName: row.defender_name,
    challengerTag: row.challenger_tag,
    defenderTag: row.defender_tag,
    challengerScore: row.challenger_score,
    defenderScore: row.defender_score,
    status: row.status,
    createdAt: row.created_at,
  };
}

function publicLeagueChallenge(row: tags.BagChallengeRow) {
  return {
    ...publicChallenge(row),
    leagueId: row.league_id ?? null,
    closedNote: row.closed_note ?? null,
    closedAt: row.closed_at ?? null,
  };
}

/** One imported league's ladder as the app sees it right now. */
async function leagueBoard(env: Env, leagueId: number, viewerId: string | null) {
  const name = await leagueDb.leagueName(env.DB, leagueId);
  if (!name) return null;
  if (!await ensureLeagueLadder(env, leagueId)) return null;
  const [ladder, moves] = await Promise.all([
    leagueDb.listLadder(env.DB, leagueId),
    leagueDb.listLeagueMoves(env.DB, leagueId),
  ]);
  const mineRow = viewerId ? ladder.find((row) => row.member_id === viewerId) ?? null : null;
  return {
    league: { id: leagueId, name },
    holders: ladder.map((row) => ({
      tagNumber: row.tag_number,
      name: row.player_name,
      heldSince: row.held_since,
      linked: row.member_id != null,
      ...(row.member_id ? { memberId: row.member_id } : {}),
    })),
    moves: moves.map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      createdAt: row.created_at,
      appOnly: row.superseded === 1,
    })),
    mine: mineRow ? { memberId: mineRow.member_id, name: mineRow.player_name, tagNumber: mineRow.tag_number } : null,
  };
}

/** The ladders a member stands on, each with their open and recently closed challenges. */
async function memberLeagueBoards(env: Env, memberId: string) {
  const out = [];
  for (const leagueId of await leagueDb.tagLeagueIds(env.DB)) {
    const current = await leagueBoard(env, leagueId, memberId);
    if (!current || !current.mine) continue;
    const [pending, closed] = await Promise.all([
      leagueDb.pendingLeagueChallenges(env.DB, leagueId, memberId),
      leagueDb.recentClosedLeagueChallenges(env.DB, leagueId, memberId),
    ]);
    out.push({
      ...current,
      challenges: pending.map(publicLeagueChallenge),
      closed: closed.map(publicLeagueChallenge),
    });
  }
  return out;
}

async function adminLeagueBoards(env: Env) {
  const out = [];
  for (const leagueId of await leagueDb.tagLeagueIds(env.DB)) {
    const current = await leagueBoard(env, leagueId, null);
    if (!current) continue;
    const [pending, closed] = await Promise.all([
      leagueDb.pendingLeagueChallenges(env.DB, leagueId),
      leagueDb.recentClosedLeagueChallenges(env.DB, leagueId),
    ]);
    out.push({
      ...current,
      challenges: pending.map(publicLeagueChallenge),
      closed: closed.map(publicLeagueChallenge),
      unlinked: current.holders.filter((holder) => !holder.linked).map((holder) => holder.name),
    });
  }
  return out;
}

async function leagueTagsStillMatch(env: Env, challenge: tags.BagChallengeRow): Promise<boolean> {
  const leagueId = challenge.league_id;
  if (leagueId == null) return false;
  const challenger = await leagueDb.ladderByMember(env.DB, leagueId, challenge.challenger_id);
  const defender = await leagueDb.ladderByMember(env.DB, leagueId, challenge.defender_id);
  return Boolean(challenger && defender
    && challenger.tag_number === challenge.challenger_tag
    && defender.tag_number === challenge.defender_tag);
}

/** Swap by score on the app ladder only. UDisc's next import overwrites this. */
async function settleLeagueChallenge(
  env: Env,
  challenge: tags.BagChallengeRow,
  actorId: string,
): Promise<{ error: string; status: number } | { changes: number }> {
  const leagueId = challenge.league_id;
  if (leagueId == null) return { error: "not_found", status: 404 };
  const challenger = await leagueDb.ladderByMember(env.DB, leagueId, challenge.challenger_id);
  const defender = await leagueDb.ladderByMember(env.DB, leagueId, challenge.defender_id);
  if (!challenger || !defender) return { error: "not_a_holder", status: 400 };
  const settled = settleBagTags([
    { memberId: challenge.challenger_id, name: challenger.player_name, tagNumber: challenger.tag_number, score: challenge.challenger_score },
    { memberId: challenge.defender_id, name: defender.player_name, tagNumber: defender.tag_number, score: challenge.defender_score },
  ]);
  if (!settled.ok) return { error: settled.error, status: 400 };
  const summary = settleSummary("challenge", settled.changes);
  if (settled.changes.length) {
    await leagueDb.replaceLadderTags(env.DB, leagueId, settled.assignments, { summary, actorId });
  } else {
    await leagueDb.recordLeagueMove(env.DB, { leagueId, summary, actorId });
  }
  return { changes: settled.changes.length };
}

async function createLeagueChallenge(
  env: Env,
  ctx: ExecutionContext | undefined,
  origin: string | null,
  memberId: string,
  input: { leagueId: number; defenderId: string; challengerScore: number; defenderScore: number },
): Promise<Response> {
  if (!await leagueDb.leagueName(env.DB, input.leagueId) || !await ensureLeagueLadder(env, input.leagueId)) {
    return json({ error: "no_league" }, 404, origin);
  }
  if (await leagueDb.openLeagueChallenge(env.DB, input.leagueId, memberId)) {
    return json({ error: "challenge_open" }, 409, origin);
  }
  const challenger = await leagueDb.ladderByMember(env.DB, input.leagueId, memberId);
  const defender = await leagueDb.ladderByMember(env.DB, input.leagueId, input.defenderId);
  if (!challenger || !defender) return json({ error: "not_a_holder" }, 400, origin);
  if (challenger.tag_number <= defender.tag_number) return json({ error: "must_challenge_better_tag" }, 400, origin);
  const created = await tags.createChallenge(env.DB, {
    seriesId: 0,
    leagueId: input.leagueId,
    challengerId: memberId,
    challengerName: challenger.player_name,
    defenderId: input.defenderId,
    defenderName: defender.player_name,
    challengerTag: challenger.tag_number,
    defenderTag: defender.tag_number,
    challengerScore: input.challengerScore,
    defenderScore: input.defenderScore,
  });
  notifyChallenge(ctx, env, created, { kind: "created" });
  return json({ challenge: created ? publicLeagueChallenge(created) : null }, 201, origin);
}

async function board(env: Env, includeIds: boolean) {
  const series = await tags.activeSeries(env.DB);
  if (!series) return { series: null, holders: [], moves: [] };
  const [holders, moves] = await Promise.all([
    tags.listHolders(env.DB, series.id),
    tags.listMoves(env.DB, series.id),
  ]);
  return {
    series: { id: series.id, name: series.name, season: series.season },
    holders: holders.map((row) => publicHolder(row, includeIds)),
    moves: moves.map(publicMove),
  };
}

async function tagsStillMatch(env: Env, challenge: tags.BagChallengeRow): Promise<boolean> {
  const challenger = await tags.holderByMember(env.DB, challenge.series_id, challenge.challenger_id);
  const defender = await tags.holderByMember(env.DB, challenge.series_id, challenge.defender_id);
  return Boolean(challenger && defender
    && challenger.tag_number === challenge.challenger_tag
    && defender.tag_number === challenge.defender_tag);
}

async function settlePlayers(
  env: Env,
  seriesId: number,
  rawPlayers: unknown,
  kind: "settle" | "challenge",
  actorId: string,
): Promise<{ error: string; status: number } | { changes: number }> {
  if (!Array.isArray(rawPlayers) || rawPlayers.length < 2 || rawPlayers.length > 12) {
    return { error: "need_two", status: 400 };
  }
  const holders = await tags.listHolders(env.DB, seriesId);
  const byMember = new Map(holders.map((holder) => [holder.member_id, holder]));
  const players: TagPlayer[] = [];
  for (const raw of rawPlayers) {
    if (!raw || typeof raw !== "object") return { error: "invalid_player", status: 400 };
    const memberId = asStr((raw as { memberId?: unknown }).memberId, 80);
    const score = scoreOf((raw as { score?: unknown }).score);
    if (!memberId || score == null) return { error: "invalid_player", status: 400 };
    const holder = byMember.get(memberId);
    if (!holder) return { error: "not_a_holder", status: 400 };
    players.push({ memberId, name: holder.member_name, tagNumber: holder.tag_number, score });
  }
  const settled = settleBagTags(players);
  if (!settled.ok) return { error: settled.error, status: 400 };
  if (settled.changes.length) {
    await tags.replaceTags(env.DB, seriesId, settled.assignments, {
      kind,
      summary: settleSummary(kind, settled.changes),
      actorId,
    });
  } else {
    await tags.recordMove(env.DB, {
      seriesId,
      kind,
      summary: settleSummary(kind, settled.changes),
      actorId,
    });
  }
  return { changes: settled.changes.length };
}

export async function handleBagTags(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  ctx?: ExecutionContext,
): Promise<Response | null> {
  if (seg[0] !== "bag-tags") return null;

  if (method === "GET" && seg.length === 1) return json(await board(env, false), 200, origin);

  const auth = await requireAuth(request, env);
  if (!auth || !auth.member) return json({ error: "unauthorized" }, 401, origin);
  const member = auth.member;

  if (method === "GET" && seg[1] === "mine" && seg.length === 2) {
    const current = await board(env, true);
    const mine = current.holders.find((holder) => holder.memberId === member.memberId) ?? null;
    const pending = current.series
      ? await tags.pendingChallenges(env.DB, current.series.id, member.memberId)
      : [];
    const waitingRow = current.series
      ? await tags.requestByMember(env.DB, current.series.id, member.memberId)
      : null;
    return json({
      ...current,
      mine,
      request: waitingRow ? { createdAt: waitingRow.created_at } : null,
      challenges: pending.map(publicChallenge),
      leagues: await memberLeagueBoards(env, member.memberId),
    }, 200, origin);
  }

  if (method === "POST" && seg[1] === "request" && seg.length === 2) {
    const series = await tags.activeSeries(env.DB);
    if (!series) return json({ error: "no_series" }, 404, origin);
    const holding = await tags.holderByMember(env.DB, series.id, member.memberId);
    if (holding) return json({ error: "already_holding" }, 409, origin);
    const waiting = await tags.requestByMember(env.DB, series.id, member.memberId);
    if (waiting) return json({ request: { createdAt: waiting.created_at } }, 200, origin);
    if (await kvRateLimited(env, "bagreq:" + member.memberId, 6, 3600)) {
      return json({ error: "request_limited" }, 429, origin);
    }
    const asked = await tags.askForTag(env.DB, {
      seriesId: series.id,
      memberId: member.memberId,
      memberName: member.name.trim() || member.memberId,
    });
    if (asked.created) {
      notifyAdmins(ctx, env, {
        title: "Bag tag request",
        body: `${asked.row.member_name} asked for a bag tag.`,
        url: "/admin.html?tab=bag-tags",
        tag: `bag-tag:${member.memberId}`,
      });
    }
    return json({ request: { createdAt: asked.row.created_at } }, asked.created ? 201 : 200, origin);
  }

  if (method === "POST" && seg[1] === "challenges" && seg.length === 2) {
    if (await kvRateLimited(env, "bagtag:" + member.memberId, 12, 3600)) {
      return json({ error: "rate_limited" }, 429, origin);
    }
    const body = (await readJson(request)) ?? {};
    const defenderId = asStr(body.defenderId, 80);
    const challengerScore = scoreOf(body.challengerScore);
    const defenderScore = scoreOf(body.defenderScore);
    if (!defenderId || challengerScore == null || defenderScore == null) {
      return json({ error: "invalid_challenge" }, 400, origin);
    }
    if (defenderId === member.memberId) return json({ error: "invalid_challenge" }, 400, origin);
    if (body.leagueId != null) {
      const leagueId = asInt(body.leagueId);
      if (!leagueId) return json({ error: "invalid_challenge" }, 400, origin);
      return createLeagueChallenge(env, ctx, origin, member.memberId, { leagueId, defenderId, challengerScore, defenderScore });
    }
    const series = await tags.activeSeries(env.DB);
    if (!series) return json({ error: "no_series" }, 404, origin);
    const open = await tags.openChallengeBetween(env.DB, series.id, member.memberId);
    if (open) return json({ error: "challenge_open" }, 409, origin);
    const challenger = await tags.holderByMember(env.DB, series.id, member.memberId);
    const defender = await tags.holderByMember(env.DB, series.id, defenderId);
    if (!challenger || !defender) return json({ error: "not_a_holder" }, 400, origin);
    if (challenger.tag_number <= defender.tag_number) return json({ error: "must_challenge_better_tag" }, 400, origin);
    const created = await tags.createChallenge(env.DB, {
      seriesId: series.id,
      challengerId: member.memberId,
      challengerName: challenger.member_name,
      defenderId,
      defenderName: defender.member_name,
      challengerTag: challenger.tag_number,
      defenderTag: defender.tag_number,
      challengerScore,
      defenderScore,
    });
    if (created) {
      notifyAdmins(ctx, env, {
        title: "Bag tag challenge",
        body: `${created.challenger_name} challenged ${created.defender_name}.`,
        url: "/admin.html?tab=bag-tags",
        tag: `bag-challenge:${created.id}`,
      });
      notifyChallenge(ctx, env, created, { kind: "created" });
    }
    return json({ challenge: created ? publicChallenge(created) : null }, 201, origin);
  }

  const challengeId = seg[1] === "challenges" ? asInt(seg[2]) : null;
  if (challengeId && seg.length === 4 && (seg[3] === "confirm" || seg[3] === "decline") && method === "POST") {
    const challenge = await tags.getChallenge(env.DB, challengeId);
    if (!challenge || challenge.status !== "pending") return json({ error: "not_found" }, 404, origin);
    if (challenge.defender_id !== member.memberId) return json({ error: "forbidden" }, 403, origin);
    if (challenge.league_id != null) {
      if (seg[3] === "decline") {
        if (!await tags.claimChallenge(env.DB, challenge.id, "declined")) return json({ error: "not_found" }, 404, origin);
        notifyChallenge(ctx, env, challenge, { kind: "declined" });
        return json({ ok: true }, 200, origin);
      }
      if (!await leagueTagsStillMatch(env, challenge)) {
        await tags.claimChallenge(env.DB, challenge.id, "declined", "tags changed before it was confirmed");
        notifyChallenge(ctx, env, challenge, { kind: "declined", stale: true });
        return json({ error: "stale_tags" }, 409, origin);
      }
      if (!await tags.claimChallenge(env.DB, challenge.id, "settled")) return json({ error: "not_found" }, 404, origin);
      let done;
      try {
        done = await settleLeagueChallenge(env, challenge, member.memberId);
      } catch (error) {
        await tags.reopenChallenge(env.DB, challenge.id).catch(() => {});
        throw error;
      }
      if ("error" in done) {
        await tags.reopenChallenge(env.DB, challenge.id).catch(() => {});
        return json({ error: done.error }, done.status, origin);
      }
      notifyChallenge(ctx, env, challenge, { kind: "confirmed", swapped: done.changes > 0 });
      return json({ ok: true, changes: done.changes }, 200, origin);
    }
    if (seg[3] === "decline") {
      const claimed = await tags.claimChallenge(env.DB, challenge.id, "declined");
      if (!claimed) return json({ error: "not_found" }, 404, origin);
      notifyChallenge(ctx, env, challenge, { kind: "declined" });
      return json({ ok: true }, 200, origin);
    }
    if (!await tagsStillMatch(env, challenge)) {
      await tags.claimChallenge(env.DB, challenge.id, "declined");
      notifyChallenge(ctx, env, challenge, { kind: "declined", stale: true });
      return json({ error: "stale_tags" }, 409, origin);
    }
    const claimed = await tags.claimChallenge(env.DB, challenge.id, "settled");
    if (!claimed) return json({ error: "not_found" }, 404, origin);
    let settled;
    try {
      settled = await settlePlayers(env, challenge.series_id, [
        { memberId: challenge.challenger_id, score: challenge.challenger_score },
        { memberId: challenge.defender_id, score: challenge.defender_score },
      ], "challenge", member.memberId);
    } catch (error) {
      await tags.reopenChallenge(env.DB, challenge.id).catch(() => {});
      throw error;
    }
    if ("error" in settled) {
      await tags.reopenChallenge(env.DB, challenge.id).catch(() => {});
      return json({ error: settled.error }, settled.status, origin);
    }
    notifyChallenge(ctx, env, challenge, { kind: "confirmed", swapped: settled.changes > 0 });
    return json({ ok: true, changes: settled.changes }, 200, origin);
  }

  return json({ error: "not_found" }, 404, origin);
}

export async function handleAdminBagTags(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  if (seg[1] !== "bag-tags") return null;
  const body = method === "POST" ? ((await readJson(request)) ?? {}) : {};

  if (method === "GET" && seg.length === 2) {
    const current = await board(env, true);
    const pending = current.series ? await tags.pendingChallenges(env.DB, current.series.id) : [];
    const requests = current.series ? await tags.listRequests(env.DB, current.series.id) : [];
    return json({
      ...current,
      challenges: pending.map(publicChallenge),
      requests: requests.map(publicRequest),
      leagues: await adminLeagueBoards(env),
    }, 200, origin);
  }

  if (method === "POST" && seg[2] === "series" && seg.length === 3) {
    const name = asStr(body.name, 80);
    if (!name) return json({ error: "name_required" }, 400, origin);
    const series = await tags.createSeries(env.DB, {
      name,
      season: asStr(body.season, 40),
      createdBy: adminId,
    });
    return json({ series }, 201, origin);
  }

  if (method === "POST" && seg[2] === "assign" && seg.length === 3) {
    const seriesId = asInt(body.seriesId);
    const memberId = asStr(body.memberId, 80);
    const tagNumber = tagOf(body.tagNumber);
    if (!seriesId || !memberId || tagNumber == null) return json({ error: "invalid_assignment" }, 400, origin);
    const series = await tags.getSeries(env.DB, seriesId);
    if (!series || series.active !== 1) return json({ error: "no_series" }, 404, origin);
    const member = await getMember(env.ROSTER, memberId);
    if (!member) return json({ error: "member_not_found" }, 404, origin);
    const taken = await tags.holderByTag(env.DB, seriesId, tagNumber);
    if (taken && taken.member_id !== memberId) return json({ error: "tag_taken" }, 409, origin);
    const current = await tags.holderByMember(env.DB, seriesId, memberId);
    if (current && current.tag_number === tagNumber) {
      await tags.clearRequest(env.DB, seriesId, memberId);
      return json({ ok: true }, 200, origin);
    }
    await tags.giveTag(env.DB, { seriesId, tagNumber, memberId, memberName: member.name });
    await tags.clearRequest(env.DB, seriesId, memberId);
    await tags.recordMove(env.DB, {
      seriesId,
      kind: "assign",
      summary: current
        ? `${member.name} moved from #${current.tag_number} to #${tagNumber}`
        : `Assigned #${tagNumber} to ${member.name}`,
      actorId: adminId,
    });
    return json({ ok: true }, 200, origin);
  }

  if (method === "POST" && seg[2] === "release" && seg.length === 3) {
    const seriesId = asInt(body.seriesId);
    const memberId = asStr(body.memberId, 80);
    if (!seriesId || !memberId) return json({ error: "invalid_assignment" }, 400, origin);
    const current = await tags.holderByMember(env.DB, seriesId, memberId);
    if (!current) return json({ error: "not_a_holder" }, 404, origin);
    await tags.releaseTag(env.DB, seriesId, memberId);
    await tags.recordMove(env.DB, {
      seriesId,
      kind: "release",
      summary: `Released #${current.tag_number} from ${current.member_name}`,
      actorId: adminId,
    });
    return json({ ok: true }, 200, origin);
  }

  if (method === "POST" && seg[2] === "settle" && seg.length === 3) {
    const seriesId = asInt(body.seriesId);
    if (!seriesId) return json({ error: "no_series" }, 400, origin);
    const series = await tags.getSeries(env.DB, seriesId);
    if (!series || series.active !== 1) return json({ error: "no_series" }, 404, origin);
    const settled = await settlePlayers(env, seriesId, body.players, "settle", adminId);
    if ("error" in settled) return json({ error: settled.error }, settled.status, origin);
    return json({ ok: true, changes: settled.changes }, 200, origin);
  }

  const challengeId = seg[2] === "challenges" ? asInt(seg[3]) : null;
  if (method === "POST" && challengeId && seg.length === 5 && seg[4] === "confirm") {
    const challenge = await tags.getChallenge(env.DB, challengeId);
    if (!challenge || challenge.status !== "pending") return json({ error: "not_found" }, 404, origin);
    // League challenges are answered by the two members only. An admin can cancel one.
    if (challenge.league_id != null) return json({ error: "league_challenge" }, 409, origin);
    if (!await tagsStillMatch(env, challenge)) {
      await tags.claimChallenge(env.DB, challenge.id, "declined");
      return json({ error: "stale_tags" }, 409, origin);
    }
    const claimed = await tags.claimChallenge(env.DB, challenge.id, "settled");
    if (!claimed) return json({ error: "not_found" }, 404, origin);
    const settled = await settlePlayers(env, challenge.series_id, [
      { memberId: challenge.challenger_id, score: challenge.challenger_score },
      { memberId: challenge.defender_id, score: challenge.defender_score },
    ], "challenge", adminId);
    if ("error" in settled) return json({ error: settled.error }, settled.status, origin);
    notifyChallenge(ctx, env, challenge, { kind: "confirmed", swapped: settled.changes > 0, byAdmin: true });
    return json({ ok: true, changes: settled.changes }, 200, origin);
  }

  if (method === "POST" && challengeId && seg.length === 5 && seg[4] === "cancel") {
    const challenge = await tags.getChallenge(env.DB, challengeId);
    if (!challenge || challenge.status !== "pending") return json({ error: "not_found" }, 404, origin);
    if (!await tags.claimChallenge(env.DB, challenge.id, "cancelled", "cancelled by an admin")) {
      return json({ error: "not_found" }, 404, origin);
    }
    notifyChallenge(ctx, env, challenge, { kind: "cancelled" });
    return json({ ok: true }, 200, origin);
  }

  const linkLeagueId = seg[2] === "leagues" ? asInt(seg[3]) : null;
  if (method === "POST" && linkLeagueId && seg.length === 5 && seg[4] === "link") {
    const playerName = asStr(body.playerName, 120);
    const memberId = body.memberId == null || body.memberId === "" ? null : asStr(body.memberId, 80);
    if (!playerName || (body.memberId != null && body.memberId !== "" && !memberId)) {
      return json({ error: "invalid_link" }, 400, origin);
    }
    if (!await ensureLeagueLadder(env, linkLeagueId)) return json({ error: "no_league" }, 404, origin);
    const ladder = await leagueDb.listLadder(env.DB, linkLeagueId);
    const key = playerKey(playerName);
    const onLadder = ladder.find((row) => playerKey(row.player_name) === key);
    if (!onLadder) return json({ error: "not_a_holder" }, 404, origin);
    if (memberId) {
      if (!await getMember(env.ROSTER, memberId)) return json({ error: "member_not_found" }, 404, origin);
      const links = await leagueDb.listLinks(env.DB, linkLeagueId);
      if (links.some((link) => link.member_id === memberId && link.player_key !== key)) {
        return json({ error: "member_already_linked" }, 409, origin);
      }
    }
    await leagueDb.setLink(env.DB, { leagueId: linkLeagueId, playerKey: key, playerName: onLadder.player_name, memberId, actorId: adminId });
    await relinkLeague(env, linkLeagueId);
    return json({ ok: true }, 200, origin);
  }

  return null;
}
