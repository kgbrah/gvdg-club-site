// Push messages for bag-tag challenges (club series and imported league ladders).
// Text carries first names and tag numbers only. Every send is best-effort (see member-push.ts).
import type { Env } from "./env.js";
import type { BagChallengeRow } from "./db-bag-tags.js";
import { leagueName } from "./db-bag-tag-leagues.js";
import { sendMemberPush, type MemberPushNote } from "./member-push.js";
import { recordMemberNotices } from "./member-messages.js";

type Ctx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

const URL_TAGS = "/gvdg-members.html#tags";

const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "A member";
const short = (name: string) => (name.length > 28 ? name.slice(0, 27) + "…" : name);

async function suffixOf(env: Env, challenge: BagChallengeRow): Promise<string> {
  if (challenge.league_id == null) return "";
  try {
    const name = await leagueName(env.DB, challenge.league_id);
    return name ? ` in ${short(name)}` : "";
  } catch {
    return "";
  }
}

export type ChallengeEvent =
  | { kind: "created" }
  | { kind: "confirmed"; swapped: boolean; byAdmin?: boolean }
  | { kind: "declined"; stale?: boolean }
  | { kind: "cancelled" };

/** Who hears about it, and what they read. Pure so tests and the preview can render it. */
export function challengeNote(challenge: BagChallengeRow, event: ChallengeEvent, suffix: string): { to: string[]; note: MemberPushNote } {
  const tag = `bag-challenge:${challenge.id}`;
  const scores = `${challenge.challenger_score} to ${challenge.defender_score}`;
  const challenger = first(challenge.challenger_name);
  const defender = first(challenge.defender_name);
  switch (event.kind) {
    case "created":
      return {
        to: [challenge.defender_id],
        note: {
          title: `${challenger} challenged your #${challenge.defender_tag}${suffix}`,
          body: `${challenger} shot ${challenge.challenger_score}, you shot ${challenge.defender_score}. Tap to confirm or decline.`,
          url: URL_TAGS,
          tag,
        },
      };
    case "confirmed": {
      if (event.byAdmin) {
        return {
          to: [challenge.challenger_id, challenge.defender_id],
          note: event.swapped
            ? {
              title: `Tags swapped${suffix}: #${challenge.defender_tag} ↔ #${challenge.challenger_tag}`,
              body: `An admin confirmed the challenge, ${scores}. ${challenger} now holds #${challenge.defender_tag}; ${defender} takes #${challenge.challenger_tag}.`,
              url: URL_TAGS,
              tag,
            }
            : {
              title: `Tags stay${suffix}: #${challenge.defender_tag} & #${challenge.challenger_tag}`,
              body: `An admin confirmed the challenge, ${scores}. ${defender} keeps #${challenge.defender_tag}; ${challenger} keeps #${challenge.challenger_tag}.`,
              url: URL_TAGS,
              tag,
            },
        };
      }
      return {
        to: [challenge.challenger_id],
        note: event.swapped
          ? {
            title: `Tags swapped${suffix}: you now hold #${challenge.defender_tag}`,
            body: `${defender} confirmed your challenge, ${scores}. ${defender} takes #${challenge.challenger_tag}.`,
            url: URL_TAGS,
            tag,
          }
          : {
            title: `Tags stay${suffix}: you keep #${challenge.challenger_tag}`,
            body: `${defender} confirmed your challenge, ${scores}. ${defender} keeps #${challenge.defender_tag}.`,
            url: URL_TAGS,
            tag,
          },
      };
    }
    case "declined":
      return {
        to: [challenge.challenger_id],
        note: {
          title: event.stale ? `Your challenge for #${challenge.defender_tag}${suffix} was closed` : `${defender} declined your challenge${suffix}`,
          body: event.stale ? "The tags changed before it was confirmed. You can issue it again." : `Your challenge for #${challenge.defender_tag} was declined. Tags stay.`,
          url: URL_TAGS,
          tag,
        },
      };
    case "cancelled":
      return {
        to: [challenge.challenger_id, challenge.defender_id],
        note: {
          title: `Challenge cancelled${suffix}`,
          body: `An admin cancelled the #${challenge.challenger_tag} vs #${challenge.defender_tag} challenge.`,
          url: URL_TAGS,
          tag,
        },
      };
  }
}

export function expiredNote(challenge: BagChallengeRow, league: string | null): { to: string[]; note: MemberPushNote } {
  return {
    to: [challenge.challenger_id, challenge.defender_id],
    note: {
      title: `Your ${league ? short(league) : "bag tag league"} challenge expired`,
      body: "The ladder was refreshed from UDisc.",
      url: URL_TAGS,
      tag: `bag-challenge:${challenge.id}`,
    },
  };
}

/** Never throws, never awaited by the request path. */
export function notifyChallenge(ctx: Ctx, env: Env, challenge: BagChallengeRow | null | undefined, event: ChallengeEvent): void {
  if (!challenge) return;
  const job = (async () => {
    const { to, note } = challengeNote(challenge, event, await suffixOf(env, challenge));
    await sendMemberPush(env, to, "bagTags", note);
    await recordMemberNotices(env, to, {
      kind: "bag-tag",
      title: note.title,
      body: note.body,
      href: note.url,
      refKey: `${note.tag}:${event.kind}`,
    });
  })().catch(() => {});
  try {
    ctx?.waitUntil?.(job);
  } catch {
    /* settles on its own */
  }
}

/** Both members of each challenge a UDisc ladder reset just closed. Awaited by cron callers only. */
export async function notifyChallengesExpired(env: Env, leagueId: number, closed: readonly BagChallengeRow[]): Promise<void> {
  try {
    if (!closed.length) return;
    const league = await leagueName(env.DB, leagueId).catch(() => null);
    await Promise.all(closed.map(async (challenge) => {
      const { to, note } = expiredNote(challenge, league);
      await sendMemberPush(env, to, "bagTags", note);
      await recordMemberNotices(env, to, {
        kind: "bag-tag",
        title: note.title,
        body: note.body,
        href: note.url,
        refKey: `${note.tag}:expired`,
      });
    }));
  } catch {
    /* alerts are optional */
  }
}

