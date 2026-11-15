import React from "react";
import { UserRound } from "lucide-react";

import { ClubLogo } from "../shared/club-logo.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { InstallCoachBanner } from "../shared/install-coach-ui.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";

import { selectDashboardTab } from "./dashboard-shell.js";

const h = React.createElement;

export function MemberPageChrome() {
  const [signedIn, setSignedIn] = React.useState(() => document.body.dataset.memberShell === "members");
  React.useEffect(() => {
    const update = (event) => setSignedIn(event.detail?.view === "members");
    window.addEventListener("gvdg:member-shell-view", update);
    return () => window.removeEventListener("gvdg:member-shell-view", update);
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
        h(CrottsHelpLink, { className: "member-header-link", key: "help" }, "Help"),
        signedIn ? h("button", {
          className: "member-header-link", key: "account", type: "button", onClick: () => selectDashboardTab("account"),
        }, [h(UserRound, { "aria-hidden": true, key: "icon", size: 18 }), "Account"])
          : h(PlayerThemeToggle, { key: "theme" }),
      ]),
    ])),
    signedIn ? null : h(InstallCoachBanner, { key: "install" }),
  ]);
}
