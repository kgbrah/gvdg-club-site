import React from "react";
import { ChevronDown } from "lucide-react";

import { CrottsHelpLink } from "./crotts-widget.js";

const h = React.createElement;

export const SITE_NAV_HOME = { label: "Home", href: "index.html", page: "index" };
export const SITE_NAV_PRIMARY = [
  { label: "Keep score", href: "score.html", page: "score" },
  { label: "Events", href: "events.html", page: "events" },
  { label: "Members", href: "gvdg-members.html", page: "gvdg-members" },
];
export const SITE_NAV_MORE = [
  { label: "Ryder Cup", href: "ryder-cup.html", page: "ryder-cup" },
  { label: "Pro Shop", href: "pro-shop.html", page: "pro-shop" },
  { label: "Blog", href: "gvdg-blog.html", page: "gvdg-blog" },
];
export const SITE_DONATE_URL = "https://www.paypal.com/paypalme/greenvillediscgolf";

export function siteCurrentPage() {
  const path = String(window.location.pathname || "").toLowerCase();
  const basename = path.replace(/[#?].*$/, "").replace(/^.*\//, "").replace(/\.html$/, "");
  return basename === "" ? "index" : basename;
}

export function siteMoreIsCurrent(page) {
  return SITE_NAV_MORE.some((item) => item.page === page);
}

function navLink(item, page, onNavigate) {
  const current = item.page === page;
  return h("li", {
    className: item.page === "index" ? "nav-home" : undefined,
    key: item.href,
  }, h("a", {
    "aria-current": current ? "page" : undefined,
    href: item.href,
    onClick: onNavigate,
  }, item.label));
}

export function SiteNavItems({ page, moreOpen, onNavigate, onToggleMore }) {
  const moreCurrent = siteMoreIsCurrent(page);
  return [
    navLink(SITE_NAV_HOME, page, onNavigate),
    ...SITE_NAV_PRIMARY.map((item) => navLink(item, page, onNavigate)),
    h("li", { className: "nav-more" + (moreOpen ? " is-open" : ""), key: "more" }, [
      h("button", {
        "aria-current": moreCurrent ? "true" : undefined,
        "aria-expanded": moreOpen ? "true" : "false",
        "aria-haspopup": "true",
        className: "nav-more-btn" + (moreCurrent ? " is-current" : ""),
        key: "btn",
        type: "button",
        onClick: (event) => {
          event.stopPropagation();
          onToggleMore();
        },
      }, [
        "More",
        h(ChevronDown, {
          "aria-hidden": "true",
          className: "nav-more-caret",
          focusable: "false",
          key: "caret",
          size: 16,
          strokeWidth: 2.4,
        }),
      ]),
      h("ul", { className: "nav-more-menu", key: "menu" }, [
        ...SITE_NAV_MORE.map((item) => navLink(item, page, onNavigate)),
        h("li", { key: "help" }, h(CrottsHelpLink, { onClick: onNavigate })),
      ]),
    ]),
    h("li", { key: "donate" }, h("a", {
      className: "nav-donate",
      href: SITE_DONATE_URL,
      onClick: onNavigate,
      rel: "noopener noreferrer",
      target: "_blank",
    }, "Donate")),
  ];
}

export function useSiteMoreMenu(menuOpen) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => {
    if (menuOpen) setMoreOpen(false);
  }, [menuOpen]);
  React.useEffect(() => {
    if (!moreOpen) return undefined;
    function close() {
      setMoreOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  return {
    moreOpen,
    onToggleMore: () => setMoreOpen((open) => !open),
    closeMore: () => setMoreOpen(false),
  };
}
