import React from "react";

import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { clearMemberSession, readMemberToken } from "../shared/member-session.js";
import { themeRoot } from "../shared/player-theme-chrome.js";
import { paintPlayerTheme } from "../shared/player-theme-session.js";

const h = React.createElement;

const MORE_LINKS = [
  { tab: "courses", label: "Courses" },
  { tab: "layouts", label: "Layouts" },
  { tab: "tee-signs", label: "Tee signs" },
  { tab: "leagues-mgmt", label: "Leagues" },
  { tab: "fundraisers", label: "Fundraisers" },
  { tab: "meetings", label: "Meetings" },
  { tab: "members", label: "Members" },
  { tab: "data-archive", label: "Data archive" },
];

function requestTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:admin-tab-request", { detail: { tab } }));
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
    h("h2", { className: "admin-pane-heading", key: "title" }, "More"),
    h("p", { className: "dash-note", key: "note" }, "Courses, club ops, members, and archives."),
    h("div", { className: "admin-more-list", key: "list" }, MORE_LINKS.map((item) => h("button", {
      className: "admin-more-link",
      key: item.tab,
      onClick: () => requestTab(item.tab),
      type: "button",
    }, [item.label, h("span", { "aria-hidden": "true", key: "chev" }, "›")]))),
    h(AccountLinks, { key: "account" }),
  ]);
}
