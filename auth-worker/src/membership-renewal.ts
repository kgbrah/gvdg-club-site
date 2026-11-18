// December 1 reminder (America/New_York), riding the existing daily cron. One push per member
// who is not yet renewed for the coming year, once per calendar year. A missed December 1 still
// sends on the next daily run through December 7.

import type { Env } from "./env.js";
import { postPush } from "./admin-push.js";
import { listMembers, type KVListLike } from "./roster.js";
import { membershipStatus, renewalNoticeKey, renewalReminderYear } from "./membership-year.js";
import { loadVapidKeys } from "./web-push.js";

const text = new TextEncoder();

interface SubRow {
  endpoint: string;
  member_id: string;
  p256dh: string;
  auth: string;
}

export interface RenewalReminderResult {
  sent: number;
  skipped: "not_december" | "already_sent" | "unconfigured" | null;
  year: number | null;
}

export async function sendMembershipRenewalReminders(env: Env, now = new Date()): Promise<RenewalReminderResult> {
  const year = renewalReminderYear(now);
  if (year == null) return { sent: 0, skipped: "not_december", year: null };

  const kv = env.ROSTER as unknown as KVListLike;
  const key = renewalNoticeKey(year);
  if (await kv.get(key)) return { sent: 0, skipped: "already_sent", year };

  const cfg = env as Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };
  const keys = await loadVapidKeys(cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY);
  if (!keys) return { sent: 0, skipped: "unconfigured", year };

  const due = new Set(
    (await listMembers(kv))
      .filter((member) => member.held !== true && membershipStatus(member, now).renewalYear != null)
      .map((member) => member.memberId),
  );
  // Claim before sending so a cron retry cannot double-notify the same phones.
  await kv.put(key, new Date(now).toISOString());
  if (!due.size) return { sent: 0, skipped: null, year };

  let rows: SubRow[] = [];
  try {
    const listed = await env.DB.prepare(
      "SELECT endpoint, member_id, p256dh, auth FROM member_push_subscriptions LIMIT 500",
    ).all<SubRow>();
    rows = (listed.results ?? []).filter((row) => due.has(row.member_id));
  } catch {
    return { sent: 0, skipped: null, year };
  }

  const nextYear = year + 1;
  const payload = text.encode(JSON.stringify({
    kind: "member",
    title: "Renew your membership",
    body: `GVDG membership renews on January 1, ${nextYear}. Ask a club admin to mark you renewed.`,
    url: "/gvdg-members.html#account",
    tag: `membership-renewal-${nextYear}`,
  }));

  let sent = 0;
  await Promise.all(rows.map(async (row) => {
    try {
      const status = await postPush(keys, row, payload);
      if (status === 404 || status === 410) {
        await env.DB.prepare("DELETE FROM member_push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
        return;
      }
      if (status >= 200 && status < 300) sent += 1;
    } catch {
      /* one dead phone does not stop the others */
    }
  }));
  return { sent, skipped: null, year };
}
