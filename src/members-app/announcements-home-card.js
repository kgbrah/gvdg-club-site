// Club announcements card on Member Home: shows recent admin announcements posted via Admin › Announcements.
import React from "react";
import { Megaphone } from "lucide-react";

import { requestJson } from "./api.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { formatEventDay } from "./format.js";

const h = React.createElement;

function targetTabForHref(href) {
  const raw = String(href || "");
  if (raw.includes("#events")) return { tab: "events", label: "Open events" };
  if (raw.includes("#board")) return { tab: "board", label: "Open message board" };
  if (raw.includes("#club") || raw.includes("#directory")) return { tab: "club", label: "Open club directory" };
  return null;
}

export function AnnouncementsHomeCard({ token }) {
  const [items, setItems] = React.useState([]);

  React.useEffect(() => {
    if (!token) {
      setItems([]);
      return undefined;
    }
    const controller = new AbortController();
    requestJson("/announcements", { token, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setItems(Array.isArray(data?.announcements) ? data.announcements : []);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [token]);

  if (!token || !items.length) return null;

  return h("section", {
    className: "player-card member-announcements-card",
    "data-react-home-announcements": "ready",
    "aria-label": "Club announcements",
  }, [
    h("div", { className: "member-announcements-head", key: "head" }, [
      h(Megaphone, { "aria-hidden": true, key: "icon", size: 18 }),
      h("h2", { key: "title" }, "Club announcements"),
    ]),
    ...items.map((item) => {
      const target = targetTabForHref(item.href);
      const day = formatEventDay(String(item.createdAt || "").slice(0, 10));
      const meta = [item.authorName, day].filter(Boolean).join(" · ");
      return h("article", {
        className: "member-announcement-item",
        "data-member-announcement": item.id,
        key: item.id,
      }, [
        h("h3", { className: "member-announcement-title", key: "title" }, item.title),
        h("p", { className: "member-announcement-body", key: "body" }, item.body),
        meta ? h("p", { className: "player-card-meta", key: "meta" }, meta) : null,
        target ? h("button", {
          type: "button",
          className: "player-btn",
          onClick: () => selectDashboardTab(target.tab),
          key: "action",
        }, target.label) : null,
      ].filter(Boolean));
    }),
  ]);
}
