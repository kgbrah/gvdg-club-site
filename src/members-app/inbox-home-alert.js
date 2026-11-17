import React from "react";
import { Mail } from "lucide-react";

import { selectDashboardTab } from "./dashboard-shell.js";
import { plural } from "./format.js";
import { useInboxSummary } from "./inbox-summary.js";
import { useSessionToken } from "./session-token.js";

const h = React.createElement;

export function InboxHomeAlert() {
  const token = useSessionToken();
  const inbox = useInboxSummary(token);
  if (!inbox.total) return null;
  const parts = [];
  if (inbox.unread) parts.push(`${inbox.unread} ${plural(inbox.unread, "new message", "new messages")}`);
  if (inbox.unseen) parts.push(`${inbox.unseen} ${plural(inbox.unseen, "club update", "club updates")}`);
  return h("button", {
    type: "button",
    className: "member-inbox-alert",
    onClick: () => selectDashboardTab("messages"),
  }, [
    h(Mail, { size: 20, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-inbox-alert-copy", key: "copy" }, [
      h("strong", { key: "title" }, "You have something new"),
      h("small", { key: "detail" }, parts.join(" · ")),
    ]),
  ]);
}
