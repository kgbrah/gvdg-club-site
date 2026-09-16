import React from "react";
import { Menu, X } from "lucide-react";

import { ClubLogo } from "../shared/club-logo.js";
import { CrottsHelpLink } from "../shared/crotts-widget.js";
import { PlayerThemeToggle, themeRoot } from "../shared/player-theme-chrome.js";
import { paintPlayerTheme } from "../shared/player-theme-session.js";

const h = React.createElement;

const NAV_ITEMS = [
  { label: "Home", href: "index.html", page: "index" },
  { label: "Club Events", href: "events.html", page: "events" },
  { label: "Members", href: "gvdg-members.html", page: "gvdg-members" },
  { label: "Pro Shop", href: "pro-shop.html", page: "pro-shop" },
  { label: "Admin", href: "admin.html", page: "admin" },
];

const SESSION_KEYS = ["gvdg_member_token", "gvdg_member_name", "gvdg_member_pdga"];

function icon(Icon, size = 24) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    size,
    strokeWidth: 2.4,
  });
}

function currentPage() {
  const path = String(window.location.pathname || "").toLowerCase();
  const basename = path.replace(/[#?].*$/, "").replace(/^.*\//, "").replace(/\.html$/, "");
  return basename === "" ? "index" : basename;
}

function clearSession() {
  for (const key of SESSION_KEYS) {
    sessionStorage.removeItem(key);
  }
}

export function AdminPageChrome() {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const [signedIn, setSignedIn] = React.useState(() => {
    try {
      return Boolean(sessionStorage.getItem("gvdg_member_token"));
    } catch {
      return false;
    }
  });
  const page = currentPage();

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
  }

  function navLink(item) {
    const current = item.page === page;
    return h("li", { key: item.href }, h("a", {
      "aria-current": current ? "page" : undefined,
      className: current ? "active" : undefined,
      href: item.href,
      onClick: closeMenu,
    }, item.label));
  }

  function backToMembers(key) {
    return h("a", { href: "gvdg-members.html", key, onClick: closeMenu }, [
      h("span", { className: "nav-account-full", key: "full" }, "Back to Members"),
      h("span", { className: "nav-account-short", key: "short" }, "Members"),
    ]);
  }

  function helpLink(key) {
    return h(CrottsHelpLink, { key, onClick: closeMenu });
  }

  function logout(key) {
    if (!signedIn) return null;
    return h("a", {
      className: "logout-link",
      href: "gvdg-members.html",
      key,
      onClick: () => {
        clearSession();
        paintPlayerTheme(null, themeRoot());
        setSignedIn(false);
      },
    }, "Log out");
  }

  return h("header", { className: scrolled ? "scrolled" : "", "data-react-admin-chrome": "true" }, h("nav", null, [
    h(ClubLogo, { href: "index.html", key: "logo", onClick: closeMenu }),
    h("ul", { className: menuOpen ? "nav-links active" : "nav-links", id: "adminNavLinks", key: "links" }, [
      ...NAV_ITEMS.map(navLink),
      h("li", { key: "help" }, helpLink("mobile-help-link")),
      h("li", { className: "nav-mobile-account", key: "mobile-members" }, backToMembers("mobile-members-link")),
      signedIn ? h("li", { className: "nav-mobile-account", key: "mobile-logout" }, logout("mobile-logout-link")) : null,
    ]),
    h("div", { className: "nav-right", key: "controls" }, [
      h("div", { className: "nav-account", key: "account" }, [
        backToMembers("desktop-members-link"),
        helpLink("desktop-help-link"),
        logout("desktop-logout-link"),
      ]),
      h("button", {
        "aria-controls": "adminNavLinks",
        "aria-expanded": menuOpen ? "true" : "false",
        "aria-label": menuOpen ? "Close menu" : "Open menu",
        className: "menu-toggle",
        key: "menu",
        onClick: () => setMenuOpen((current) => !current),
        title: menuOpen ? "Close menu" : "Open menu",
        type: "button",
      }, icon(menuOpen ? X : Menu)),
      h(PlayerThemeToggle, { key: "theme" }),
    ]),
  ]));
}
