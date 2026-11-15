import React from "react";

import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { clearMemberSession, readMemberToken } from "../shared/member-session.js";
import { PlayerThemeToggle, themeRoot } from "../shared/player-theme-chrome.js";
import { paintPlayerTheme } from "../shared/player-theme-session.js";
import { ADMIN_DESTINATIONS } from "../shared/app-navigation.js";
import { AdminNeedsBadge } from "./admin-needs.js";

const h = React.createElement;

const NEEDS_TABS = new Set(["bag-tags", "members", "tee-signs"]);

const MORE_LINKS = ADMIN_DESTINATIONS.filter((item) => item.group === "more" && item.key !== "more");

function requestTab(tab, context = {}) {
  window.dispatchEvent(new CustomEvent("gvdg:admin-tab-request", { detail: { tab, ...context } }));
}

function clearSession() {
  clearMemberSession();
}

function AccountLinks() {
  const [signedIn, setSignedIn] = React.useState(() => Boolean(readMemberToken()));

  return h("div", { className: "admin-more-account", "data-admin-more-account": "ready" }, [
    h("p", { className: "admin-pane-kicker", key: "kicker" }, "Account"),
    h("div", { className: "admin-more-list", key: "list" }, [
      h("a", {
        className: "admin-more-link",
        href: "gvdg-members.html",
        key: "members",
      }, ["Members site", h("span", { "aria-hidden": "true", key: "chev" }, "›")]),
      h(CrottsHelpLink, {
        className: "admin-more-link",
        key: "help",
      }, ["Help", h("span", { "aria-hidden": "true", key: "chev" }, "›")]),
      h("button", { className: "admin-more-link", key: "notifications", type: "button", onClick: () => requestTab("today", { filter: "alerts" }) }, "Admin alerts"),
      h("div", { className: "admin-appearance-toggle", key: "appearance" }, [
        h("span", { key: "label" }, "Light or dark mode"), h(PlayerThemeToggle, { key: "toggle" }),
      ]),
      signedIn
        ? h("a", {
          className: "admin-more-link",
          href: "gvdg-members.html",
          key: "logout",
          onClick: () => {
            clearSession();
            paintPlayerTheme(null, themeRoot());
            setSignedIn(false);
          },
        }, ["Log out", h("span", { "aria-hidden": "true", key: "chev" }, "›")])
        : null,
    ]),
  ]);
}

export function AdminMorePage() {
  return h("div", { "data-react-admin-more": "ready" }, [
    h("div", { className: "admin-more-list", key: "list" }, MORE_LINKS.map((item) => h("button", {
      className: "admin-more-link",
      key: item.key,
      onClick: () => requestTab(item.key, item.key === "tee-signs" ? { filter: "candidate" } : {}),
      type: "button",
    }, [
      h("span", { className: "admin-more-label", key: "label" }, [
        item.label,
        NEEDS_TABS.has(item.key) ? h(AdminNeedsBadge, { key: "badge", tab: item.key }) : null,
      ]),
      h("span", { "aria-hidden": "true", key: "chev" }, "›"),
    ]))),
    h(AccountLinks, { key: "account" }),
  ]);
}
