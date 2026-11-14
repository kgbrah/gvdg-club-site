// Best-effort notice when a pro-shop order is placed. Push goes to admin phones that turned
// alerts on. Email still goes to the club inbox IF Resend is configured. Neither is required:
// the Orders tab remains the source of truth. Never throws (callers fire this via waitUntil).
//
// To enable email:
//   wrangler secret put RESEND_API_KEY --env staging        (a Resend API key — resend.com)
//   set ORDER_NOTIFY_EMAIL + ORDER_NOTIFY_FROM in wrangler.toml [env.staging.vars]
//     (ORDER_NOTIFY_FROM must be on a Resend-verified domain, e.g. "GVDG Pro Shop <shop@yourdomain>")

import type { Env } from "./env.js";
import { sendAdminPush } from "./admin-push.js";

interface NotifyLine { name_snapshot: string; quantity: number; price_cents: number }

const dollars = (c: unknown) => "$" + ((typeof c === "number" ? c : 0) / 100).toFixed(2);

export async function notifyNewOrder(env: Env, order: unknown, lines: NotifyLine[]): Promise<void> {
  const o = (order ?? {}) as Record<string, unknown>;
  await sendAdminPush(env, {
    title: "New shop order",
    body: `Order #${o.id ?? ""} from ${o.member_name ?? "a member"}.`.replace(/\s+/g, " ").trim(),
    url: "/admin.html?tab=orders",
    tag: `shop-order-${o.id ?? "new"}`,
  }).catch(() => {});

  const cfg = env as unknown as { ORDER_NOTIFY_EMAIL?: string; ORDER_NOTIFY_FROM?: string; RESEND_API_KEY?: string; EMAIL_REPLY_TO?: string };
  if (!cfg.RESEND_API_KEY || !cfg.ORDER_NOTIFY_EMAIL) return; // email not configured — in-app + push only
  const items = lines.map((l) => `  ${l.quantity} x ${l.name_snapshot} (${dollars(l.price_cents)})`).join("\n");
  const total = dollars(o.total_cents);
  const text =
    `New pro-shop order #${o.id} from ${o.member_name ?? "a member"} (paid via ${o.payment_method ?? "store credit"}).\n\n` +
    `Items:\n${items}\n\nTotal: ${total}\n\nUpdate status & tracking in the admin → Orders tab.`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.ORDER_NOTIFY_FROM || "GVDG Pro Shop <onboarding@resend.dev>",
        to: [cfg.ORDER_NOTIFY_EMAIL],
        reply_to: cfg.EMAIL_REPLY_TO || "greenvillediscgolf@gmail.com",
        subject: `New pro-shop order #${o.id} — ${total}`,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* best-effort: an order must never fail because email is down */
  }
}
