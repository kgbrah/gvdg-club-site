import React from "react";
import { Bell, CircleHelp, Mail, UsersRound } from "lucide-react";
import { ClubLogo } from "../shared/club-logo.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { appHref } from "../shared/app-navigation.js";
import { adminJson, adminToken } from "./admin-api.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";

const h = React.createElement;
const MESSAGES_HREF = "gvdg-members.html" + appHref("member", "messages");
const REFRESH_MS = 60_000;

// Unread messages and new notifications for the signed-in admin, the same counts the member app's top bar shows.
function useAdminInbox() {
  const [inbox, setInbox] = React.useState({ unread: 0, unseen: 0 });
  React.useEffect(() => {
    let live = true;
    async function load() {
      if (!adminToken() || document.visibilityState === "hidden") return;
      try {
        const data = await adminJson("/me/messages/summary");
        if (live) setInbox({ unread: Number(data?.unread) || 0, unseen: Number(data?.unseen) || 0 });
      } catch {
        /* the icons still open Messages */
      }
    }
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  return inbox;
}

function HeaderIcon({ name, label, count, icon: Icon }) {
  const badge = count > 9 ? "9+" : count > 0 ? String(count) : "";
  return h("a", {
    className: "admin-header-icon",
    "data-admin-header": name,
    href: MESSAGES_HREF,
    "aria-label": badge ? `${label}, ${badge} new` : label,
  }, [
    h(Icon, { "aria-hidden": true, size: 20, key: "icon" }),
    badge ? h("span", { className: "admin-header-badge", "aria-hidden": true, key: "badge" }, badge) : null,
  ]);
}

export function AdminPageChrome() {
  const inbox = useAdminInbox();
  return h("header", { className: "admin-app-header", "data-react-admin-chrome": "true" }, h("nav", { "aria-label": "Admin header" }, [
    h("div", { className: "admin-header-brand", key: "brand" }, [
      h(ClubLogo, { href: "admin.html", key: "logo" }),
      h("strong", { key: "admin" }, "Admin"),
    ]),
    h("div", { className: "admin-header-actions", key: "actions" }, [
      // Light/dark, as in the member app's top bar (owner: "a light/dark theme control wired into top bar for admin").
      h(PlayerThemeToggle, { key: "theme" }),
      // Shorter on phones ("Members"), and icons on the narrowest, so the bar fits beside the theme button.
      h("a", { className: "admin-header-link admin-header-members", href: "gvdg-members.html", key: "members", "aria-label": "Member app" }, [
        h(UsersRound, { className: "admin-header-glyph", "aria-hidden": true, size: 20, key: "icon" }),
        h("span", { className: "admin-header-full", key: "full" }, "Member app"),
        h("span", { className: "admin-header-short", key: "short" }, "Members"),
      ]),
      h(CrottsHelpLink, { className: "admin-header-link admin-header-help", key: "help" }, [
        h(CircleHelp, { className: "admin-header-glyph", "aria-hidden": true, size: 20, key: "icon" }),
        h("span", { className: "admin-header-help-text", key: "text" }, "Help"),
      ]),
      h(HeaderIcon, { key: "messages", name: "messages", label: "Messages", count: inbox.unread, icon: Mail }),
      h(HeaderIcon, { key: "notices", name: "notices", label: "Notifications", count: inbox.unseen, icon: Bell }),
    ]),
  ]));
}
