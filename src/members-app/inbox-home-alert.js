import React from "react";
import { Mail, Tag } from "lucide-react";

import { selectDashboardTab } from "./dashboard-shell.js";
import { plural } from "./format.js";
import { useInboxSummary } from "./inbox-summary.js";
import { useSessionToken } from "./session-token.js";

const h = React.createElement;

export function InboxHomeAlert() {
  const token = useSessionToken();
  const inbox = useInboxSummary(token);
  const market = inbox.market > 0 ? h("button", {
    type: "button",
    className: "member-inbox-alert",
    "data-member-market-alert": String(inbox.market),
    onClick: () => selectDashboardTab("marketplace"),
    key: "market",
  }, [
    h(Tag, { size: 20, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-inbox-alert-copy", key: "copy" }, [
      h("strong", { key: "title" }, "A deal is waiting on you"),
      h("small", { key: "detail" }, `${inbox.market} ${plural(inbox.market, "marketplace item needs", "marketplace items need")} you`),
    ]),
  ]) : null;
  if (!inbox.total) return market;
  const parts = [];
  if (inbox.unread) parts.push(`${inbox.unread} ${plural(inbox.unread, "new message", "new messages")}`);
  if (inbox.unseen) parts.push(`${inbox.unseen} ${plural(inbox.unseen, "club update", "club updates")}`);
  const messages = h("button", {
    type: "button",
    className: "member-inbox-alert",
    onClick: () => selectDashboardTab("messages"),
    key: "messages",
  }, [
    h(Mail, { size: 20, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-inbox-alert-copy", key: "copy" }, [
      h("strong", { key: "title" }, "You have something new"),
      h("small", { key: "detail" }, parts.join(" · ")),
    ]),
  ]);
  return market ? h(React.Fragment, null, [market, messages]) : messages;
}
