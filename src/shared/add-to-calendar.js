// "Add to calendar": a small menu instead of a bare .ics download (which on a phone, and in the installed app, just
// lands in Downloads). Google Calendar and Outlook open their own "new event" page filled in (on Android, Google's
// opens the Calendar app when it's installed); Apple Calendar, or any other app, gets the .ics file, which an iPhone
// or Mac opens straight into Calendar. The phone's own calendar comes first: Apple's on iPhone / iPad / Mac, Google's
// everywhere else. The menu is placed on the page itself (not inside the card), so a card's clipping or glass effect
// can't cut it off.
import React from "react";
import { createPortal } from "react-dom";

import { downloadCalendarFile, googleCalendarUrl, outlookCalendarUrl, preferredCalendar } from "./event-calendar.js";

const h = React.createElement;
const MENU_WIDTH = 260;

function choices(item) {
  const google = { key: "google", label: "Google Calendar", href: googleCalendarUrl(item) };
  const outlook = { key: "outlook", label: "Outlook", href: outlookCalendarUrl(item) };
  const file = (label) => ({ key: "file", label, download: true });
  return preferredCalendar() === "apple"
    ? [file("Apple Calendar"), google, outlook]
    : [google, outlook, file("Other calendar app (.ics file)")];
}

/** `children` replaces the label (an icon and text, say). */
export function AddToCalendarButton({ item, className = "passkey-btn", label = "Add to calendar", children = null }) {
  const [open, setOpen] = React.useState(false);
  const [place, setPlace] = React.useState(null);
  const button = React.useRef(null);
  const menu = React.useRef(null);
  const focused = React.useRef(false);
  const id = React.useId();
  const close = React.useCallback((refocus) => {
    setOpen(false);
    setPlace(null);
    focused.current = false;
    if (refocus) button.current?.focus();
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    function position() {
      const box = button.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
      const height = menu.current?.offsetHeight || 150;
      const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
      const fitsBelow = window.innerHeight - box.bottom >= height + 12;
      const top = fitsBelow || box.top < height + 12 ? box.bottom + 6 : box.top - height - 6;
      setPlace({ top: Math.round(top), left: Math.round(left), width: Math.round(width) });
    }
    function onKey(event) {
      if (event.key === "Escape") { event.preventDefault(); close(true); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(menu.current?.querySelectorAll("[role=menuitem]") || [])];
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement);
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
    function onPointer(event) {
      if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) close(false);
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  React.useEffect(() => {
    if (!open || !place || focused.current) return;
    focused.current = true;
    menu.current?.querySelector("[role=menuitem]")?.focus();
  }, [open, place]);

  if (!item) return null;
  const options = open ? choices(item) : [];
  return h(React.Fragment, null, [
    h("button", {
      "aria-controls": open ? id : undefined, "aria-expanded": open, "aria-haspopup": "menu", className, "data-calendar-menu-button": "true",
      key: "button", onClick: () => (open ? close(false) : setOpen(true)), ref: button, type: "button",
    }, children || label),
    open && typeof document !== "undefined" ? createPortal(h("div", {
      "aria-label": "Add to calendar", className: "cal-menu", id, key: "menu", ref: menu, role: "menu",
      style: place ? { top: place.top + "px", left: place.left + "px", width: place.width + "px" } : { visibility: "hidden" },
    }, options.map((option) => (option.download
      ? h("button", {
        className: "cal-menu-item", key: option.key, role: "menuitem", type: "button",
        onClick: () => { downloadCalendarFile(item); close(true); },
      }, option.label)
      : h("a", {
        className: "cal-menu-item", href: option.href, key: option.key, rel: "noopener noreferrer", role: "menuitem", target: "_blank",
        onClick: () => close(false),
      }, option.label)))), document.body) : null,
  ]);
}
