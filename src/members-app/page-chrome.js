import React from "react";
import { Bell, Mail, UserRound } from "lucide-react";

import { ClubLogo } from "../shared/club-logo.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { InstallCoachBanner } from "../shared/install-coach-ui.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";

import { selectDashboardTab } from "./dashboard-shell.js";
import { useInboxSummary } from "./inbox-summary.js";
import { useSessionToken } from "./session-token.js";

const h = React.createElement;

function countLabel(count) {
  return count > 9 ? "9+" : String(count);
}

function HeaderIcon({ name, label, count, icon: Icon, onClick }) {
  const badge = count > 0 ? countLabel(count) : "";
  return h("button", {
    type: "button",
    className: "member-header-icon",
    "data-member-header": name,
    "aria-label": badge ? `${label}, ${badge} new` : label,
    onClick,
  }, [
    h(Icon, { "aria-hidden": true, size: 20, key: "icon" }),
    badge ? h("span", { className: "member-header-badge", "aria-hidden": true, key: "badge" }, badge) : null,
  ]);
}

export function MemberPageChrome({ showInstall = true } = {}) {
  const [signedIn, setSignedIn] = React.useState(() => document.body.dataset.memberShell === "members");
  const [authMode, setAuthMode] = React.useState("login");
  const token = useSessionToken();
  const inbox = useInboxSummary(signedIn ? token : "");
  React.useEffect(() => {
    const update = (event) => setSignedIn(event.detail?.view === "members");
    const updateAuthMode = (event) => setAuthMode(event.detail?.mode || "login");
    window.addEventListener("gvdg:member-shell-view", update);
    window.addEventListener("gvdg:member-auth-mode", updateAuthMode);
    return () => {
      window.removeEventListener("gvdg:member-shell-view", update);
      window.removeEventListener("gvdg:member-auth-mode", updateAuthMode);
    };
  }, []);

  return h(React.Fragment, null, [
    h("header", { className: "member-app-header", "data-react-page-chrome": "true", key: "header" }, h("nav", { "aria-label": "Member header" }, [
      h(ClubLogo, {
        href: signedIn ? "#home" : "index.html", key: "logo",
        onClick: signedIn ? (event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          selectDashboardTab("overview");
        } : undefined,
      }),
      h("div", { className: "member-header-controls", key: "controls" }, [
        h(PlayerThemeToggle, { key: "theme" }),
        h(CrottsHelpLink, { className: "member-header-link", key: "help" }, "Help"),
        signedIn ? h("button", {
          className: "member-header-link", key: "account", type: "button", onClick: () => selectDashboardTab("account"),
        }, [h(UserRound, { "aria-hidden": true, key: "icon", size: 18 }), "Account"]) : null,
        signedIn ? h(HeaderIcon, {
          key: "messages", name: "messages", label: "Messages", count: inbox.unread, icon: Mail,
          onClick: () => selectDashboardTab("messages"),
        }) : null,
        signedIn ? h(HeaderIcon, {
          key: "notices", name: "notices", label: "Notifications", count: inbox.unseen, icon: Bell,
          onClick: () => selectDashboardTab("messages"),
        }) : null,
      ]),
    ])),
    signedIn || !showInstall || authMode === "pin" || authMode === "profile" ? null : h(InstallCoachBanner, { key: "install" }),
  ]);
}
