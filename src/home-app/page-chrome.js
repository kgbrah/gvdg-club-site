import React from "react";
import { Menu, X } from "lucide-react";

import { ClubLogo } from "../shared/club-logo.js";
import { siteCurrentPage, SiteNavItems, useSiteMoreMenu } from "../shared/site-nav.js";
import { HomeThemeToggle } from "./page-controls.js";

const h = React.createElement;

function icon(Icon) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    size: 24,
    strokeWidth: 2.4,
  });
}

export function HomePageChrome() {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const page = siteCurrentPage();
  const more = useSiteMoreMenu(menuOpen);

  React.useEffect(() => {
    let ticking = false;
    function update() {
      setScrolled(window.scrollY > 100);
      ticking = false;
    }
    function handleScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }
    window.addEventListener("scroll", handleScroll, { passive: true });
    update();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  function closeMenu() {
    setMenuOpen(false);
    more.closeMore();
  }

  return h("header", { className: scrolled ? "scrolled" : "", "data-react-home-chrome": "true" }, h("nav", null, [
    h(ClubLogo, { href: "#", key: "logo", onClick: closeMenu }),
    h("ul", { className: menuOpen ? "nav-links active" : "nav-links", id: "navLinks", key: "links" },
      SiteNavItems({
        moreOpen: more.moreOpen,
        page,
        onNavigate: closeMenu,
        onToggleMore: more.onToggleMore,
      })),
    h("div", { className: "nav-right", key: "controls" }, [
      h(HomeThemeToggle, { key: "theme" }),
      h("button", {
        "aria-controls": "navLinks",
        "aria-expanded": menuOpen ? "true" : "false",
        "aria-label": menuOpen ? "Close menu" : "Open menu",
        className: "menu-toggle",
        key: "menu",
        onClick: () => setMenuOpen((current) => !current),
        title: menuOpen ? "Close menu" : "Open menu",
        type: "button",
      }, icon(menuOpen ? X : Menu)),
    ]),
  ]));
}
