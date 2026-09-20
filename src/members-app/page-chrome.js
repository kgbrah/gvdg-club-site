import React from "react";
import { Menu, X } from "lucide-react";

import { ClubLogo } from "../shared/club-logo.js";
import { InstallCoachBanner } from "../shared/install-coach-ui.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";
import { siteCurrentPage, SiteNavItems, useSiteMoreMenu } from "../shared/site-nav.js";

const h = React.createElement;

function icon(Icon, size = 22) {
  return h(Icon, {
    size,
    strokeWidth: 2.3,
    "aria-hidden": "true",
    focusable: "false",
  });
}

export function MemberPageChrome() {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const page = siteCurrentPage();
  const more = useSiteMoreMenu(menuOpen);

  function closeMenu() {
    setMenuOpen(false);
    more.closeMore();
  }

  return h(React.Fragment, null, [
    h("header", { "data-react-page-chrome": "true", key: "header" }, h("nav", null, [
    h(ClubLogo, { href: "gvdg-members.html", key: "logo", onClick: closeMenu }),
    h("div", { className: "nav-right", key: "nav" }, [
      h("button", {
        "aria-controls": "navLinks",
        "aria-expanded": menuOpen ? "true" : "false",
        "aria-label": menuOpen ? "Close menu" : "Open menu",
        className: "menu-toggle",
        key: "menu",
        onClick: () => setMenuOpen((current) => !current),
        title: menuOpen ? "Close menu" : "Open menu",
        type: "button",
      }, icon(menuOpen ? X : Menu, 24)),
      h("ul", {
        className: menuOpen ? "nav-links active" : "nav-links",
        id: "navLinks",
        key: "links",
      }, SiteNavItems({
        moreOpen: more.moreOpen,
        page,
        onNavigate: closeMenu,
        onToggleMore: more.onToggleMore,
      })),
      h(PlayerThemeToggle, { key: "theme" }),
    ]),
  ])),
    h(InstallCoachBanner, { key: "install" }),
  ]);
}
