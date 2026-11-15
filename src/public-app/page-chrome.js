import React from "react";
import { Menu, X } from "lucide-react";

import { ClubLogo } from "../shared/club-logo.js";
import { PlayerThemeToggle } from "../shared/player-theme-chrome.js";
import { siteCurrentPage, SiteNavItems, useSiteMoreMenu } from "../shared/site-nav.js";

const h = React.createElement;

function icon(Icon, size = 24) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    size,
    strokeWidth: 2.4,
  });
}

export function PublicPageChrome() {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuButton = React.useRef(null);
  const navLinks = React.useRef(null);
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

  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const frame = window.requestAnimationFrame(() => {
      navLinks.current?.firstElementChild?.firstElementChild?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    more.closeMore();
  }

  function onNavKey(event) {
    if (event.key !== "Escape") return;
    if (more.moreOpen) {
      more.closeMore();
      event.target.closest(".nav-more")?.firstElementChild?.focus();
    } else if (menuOpen) {
      closeMenu();
      menuButton.current?.focus();
    }
  }

  return h("header", { className: scrolled ? "scrolled" : "", "data-react-public-chrome": "true" }, h("nav", { "aria-label": "Main navigation", onKeyDown: onNavKey }, [
    h(ClubLogo, { href: "index.html", key: "logo", onClick: closeMenu }),
    h("ul", { className: menuOpen ? "nav-links active" : "nav-links", id: "navLinks", key: "links", ref: navLinks },
      SiteNavItems({
        moreOpen: more.moreOpen,
        page,
        onNavigate: closeMenu,
        onToggleMore: more.onToggleMore,
      })),
    h("div", { className: "nav-right", key: "controls" }, [
      h(PlayerThemeToggle, { key: "theme" }),
      h("button", {
        "aria-controls": "navLinks",
        "aria-expanded": menuOpen ? "true" : "false",
        "aria-label": menuOpen ? "Close menu" : "Open menu",
        className: "menu-toggle",
        key: "menu",
        onClick: () => setMenuOpen((current) => !current),
        ref: menuButton,
        title: menuOpen ? "Close menu" : "Open menu",
        type: "button",
      }, icon(menuOpen ? X : Menu)),
    ]),
  ]));
}
