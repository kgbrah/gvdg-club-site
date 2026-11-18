import React from "react";
import { HandHeart, Mail, Tag } from "lucide-react";

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
  const waiting = inbox.lostFound?.waiting || 0;
  const lostFound = waiting > 0 ? h("button", {
    type: "button",
    className: "member-inbox-alert",
    "data-member-lost-found-alert": String(waiting),
    onClick: () => selectDashboardTab("lost-found"),
    key: "lost-found",
  }, [
    h(HandHeart, { size: 20, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-inbox-alert-copy", key: "copy" }, [
      h("strong", { key: "title" }, "Lost & Found needs you"),
      h("small", { key: "detail" }, `${waiting} ${plural(waiting, "disc is", "discs are")} waiting on you`),
    ]),
  ]) : null;
  const extras = market || lostFound ? [market, lostFound].filter(Boolean) : null;
  if (!inbox.total) return extras ? h(React.Fragment, null, extras) : null;
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
  return extras ? h(React.Fragment, null, [...extras, messages]) : messages;
}
