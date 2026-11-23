import type { Env } from "./env.js";
import { compactPlayerName, playerNameTokens, playersMatch } from "./player-identity.js";
import { listMembers } from "./roster.js";
import * as league from "./db-bag-tag-leagues.js";
import { notifyChallengesExpired } from "./bag-tag-notify.js";

// Imported UDisc bag-tag leagues. UDisc's current order is the source of truth. The
// app keeps its own ladder per league so members can challenge between imports.

export interface LadderPlayer {
  tag: number;
  name: string;
  memberId: string | null;
}

export function playerKey(name: string): string {
  return compactPlayerName(name);
}

/** Two names count as the same person only on a full-name match (no first-name-only guesses). */
export function fullNameMatch(left: string, right: string): boolean {
  const a = compactPlayerName(left);
  const b = compactPlayerName(right);
  if (a && a === b) return true;
  return playerNameTokens(left).length >= 2 && playerNameTokens(right).length >= 2 && playersMatch(left, right);
}

/**
 * Decide which member (if any) each ladder player is. Order of trust: a member id already on
 * the UDisc result, an admin link, then an unambiguous full-name match. A member never ends
 * up on two tags, and a name that fits two members stays unlinked.
 */
export function linkLadderPlayers(
  players: readonly LadderPlayer[],
  members: readonly { memberId: string; name: string }[],
  links: readonly { playerKey: string; memberId: string }[],
): Map<number, string> {
  const known = new Set(members.map((member) => member.memberId));
  const result = new Map<number, string>();
  const used = new Set<string>();
  const byKey = new Map(links.map((link) => [link.playerKey, link.memberId]));
  for (const player of players) {
    const explicit = player.memberId || byKey.get(playerKey(player.name)) || null;
    if (explicit && known.has(explicit) && !used.has(explicit)) {
      result.set(player.tag, explicit);
      used.add(explicit);
    }
  }
  const candidates = new Map<number, string[]>();
  const claims = new Map<string, number>();
  for (const player of players) {
    if (result.has(player.tag)) continue;
    const hits = members
      .filter((member) => !used.has(member.memberId) && fullNameMatch(member.name, player.name))
      .map((member) => member.memberId);
    candidates.set(player.tag, hits);
    for (const id of hits) claims.set(id, (claims.get(id) || 0) + 1);
  }
  for (const [tag, hits] of candidates) {
    const only = hits.length === 1 ? hits[0]! : null;
    if (only && claims.get(only) === 1) result.set(tag, only);
  }
  return result;
}

async function resolveLinks(env: Env, leagueId: number): Promise<void> {
  const ladder = await league.listLadder(env.DB, leagueId);
  if (!ladder.length) return;
  const [members, links] = await Promise.all([
    listMembers(env.ROSTER as Parameters<typeof listMembers>[0]),
    league.listLinks(env.DB, leagueId),
  ]);
  const linked = linkLadderPlayers(
    ladder.map((row) => ({ tag: row.tag_number, name: row.player_name, memberId: null })),
    members,
    links.map((link) => ({ playerKey: link.player_key, memberId: link.member_id })),
  );
  const updates: { tag: number; memberId: string | null }[] = [];
  for (const row of ladder) {
    const next = linked.get(row.tag_number) ?? null;
    if (next !== row.member_id) updates.push({ tag: row.tag_number, memberId: next });
  }
  if (updates.length) await league.setLadderMembers(env.DB, leagueId, updates);
  await league.markLinked(env.DB, leagueId);
}

/** Admin changed a link: re-run matching right now. */
export async function relinkLeague(env: Env, leagueId: number): Promise<void> {
  await resolveLinks(env, leagueId);
}

function playersFromUdisc(
  rows: readonly league.UdiscTagRow[],
  previousTags: ReadonlyMap<string, number> = new Map(),
): LadderPlayer[] {
  const valid = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => Number.isInteger(row.place) && row.place >= 1);
  valid.sort((a, b) => {
    if (a.row.place !== b.row.place) return a.row.place - b.row.place;
    const prevA = previousTags.get(playerKey(a.row.name)) ?? Infinity;
    const prevB = previousTags.get(playerKey(b.row.name)) ?? Infinity;
    if (prevA !== prevB) return prevA - prevB;
    return a.row.name.localeCompare(b.row.name) || a.index - b.index;
  });
  const taken = new Set<number>();
  const seenMembers = new Set<string>();
  const players: LadderPlayer[] = [];
  for (const { row } of valid) {
    let tag = row.place;
    while (taken.has(tag)) tag += 1;
    taken.add(tag);
    const memberId = row.member_id && !seenMembers.has(row.member_id) ? row.member_id : null;
    if (memberId) seenMembers.add(memberId);
    players.push({ tag, name: row.name, memberId });
  }
  return players;
}

/** A member id that already sits on a UDisc result row counts as a link. */
async function keepResultLinks(env: Env, leagueId: number, players: readonly LadderPlayer[]): Promise<void> {
  for (const player of players) {
    if (!player.memberId) continue;
    await league.setLink(env.DB, {
      leagueId,
      playerKey: playerKey(player.name),
      playerName: player.name,
      memberId: player.memberId,
      actorId: "udisc",
    });
  }
}

/**
 * UDisc wins. Called after every league import or refresh that wrote a tag order: the ladder
 * becomes that order, open challenges close, and earlier app swaps stay in history as app-only.
 */
export async function resetLeagueLadderFromUdisc(env: Env, leagueId: number): Promise<number> {
  const [tagRows, existingLadder] = await Promise.all([
    league.udiscTagRows(env.DB, leagueId),
    league.listLadder(env.DB, leagueId).catch(() => []),
  ]);
  const previousTags = new Map(existingLadder.map((row) => [playerKey(row.player_name), row.tag_number]));
  const players = playersFromUdisc(tagRows, previousTags);
  if (!players.length) return 0;
  const open = await league.pendingLeagueChallenges(env.DB, leagueId).catch(() => []);
  await league.resetLadder(env.DB, leagueId, players);
  await keepResultLinks(env, leagueId, players);
  await resolveLinks(env, leagueId);
  // resetLadder closed them; tell both members (best-effort, never throws).
  await notifyChallengesExpired(env, leagueId, open);
  return players.length;
}

/**
 * Build the ladder the first time it is needed (a league imported before challenges existed),
 * and keep member links fresh. Returns false when the league has no UDisc tag order.
 */
export async function ensureLeagueLadder(env: Env, leagueId: number): Promise<boolean> {
  if (!await league.leagueHasState(env.DB, leagueId)) {
    const players = playersFromUdisc(await league.udiscTagRows(env.DB, leagueId));
    if (!players.length) return false;
    await league.resetLadder(env.DB, leagueId, players);
    await keepResultLinks(env, leagueId, players);
    await resolveLinks(env, leagueId);
    return true;
  }
  if (await league.linkingDue(env.DB, leagueId)) await resolveLinks(env, leagueId);
  return true;
}
