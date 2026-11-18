// Lost & Found notifications, delivered like the marketplace's (market-notify.ts): members get an in-app notice
// (Messages > Updates, kind "lostfound") that opens the member Lost & Found screen, a Web Push on their
// "Messages" preference, and an email when they saved a notification email in marketplace settings; guests
// get email at their verified (encrypted-at-rest) address. Best-effort through waitUntil: an action never
// fails because a notice could not be delivered. Notes never carry ink text or anyone's contact details.

import type { Env } from "./env.js";
import { emailConfigured, isGuestId, sendMarketEmail, traderEmail } from "./market-notify.js";
import { recordMemberNotices } from "./member-messages.js";
import { notifyMembers } from "./member-push.js";
import { siteBase } from "./membership-notify.js";
import { guestLinkUrl } from "./guest-link.js";

type WaitCtx = { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

export const LF_MEMBER_HREF = "/gvdg-members.html#lost-found";

export function lfUrl(env: Env, hash = "mine"): string {
  return siteBase(env) + "/lost-found.html#" + hash;
}

export interface LfNote {
  title: string;
  body: string;
  /** Unique per event so a retried request cannot stack duplicate notices. */
  refKey: string;
  /** Where the email links to on lost-found.html (hash). */
  hash: string;
}

export async function deliverLfNote(env: Env, ctx: WaitCtx, personId: string, note: LfNote): Promise<void> {
  try {
    if (!isGuestId(personId)) {
      await recordMemberNotices(env, [personId], { kind: "lostfound", title: note.title, body: note.body, href: LF_MEMBER_HREF, refKey: note.refKey });
      notifyMembers(ctx, env, [personId], "messages", { title: note.title, body: note.body, url: LF_MEMBER_HREF, tag: note.refKey });
    }
    if (!emailConfigured(env)) return;
    const to = await traderEmail(env, personId);
    if (!to) return;
    // A guest's link signs them in wherever they open it (no second code).
    const link = isGuestId(personId) ? await guestLinkUrl(env, personId, lfUrl(env, note.hash)) : lfUrl(env, note.hash);
    await sendMarketEmail(env, to, note.title, [
      note.body, "", "Open Lost & Found: " + link, "",
      "Your email address is never shown to anyone. - Greenville Disc Golf Club",
    ].join("\n"));
  } catch {
    /* notices are optional */
  }
}

export function notifyPerson(env: Env, ctx: WaitCtx, personId: string, note: LfNote): void {
  const job = deliverLfNote(env, ctx, personId, note).catch(() => {});
  try {
    if (ctx?.waitUntil) ctx.waitUntil(job);
  } catch {
    /* settles on its own */
  }
}
