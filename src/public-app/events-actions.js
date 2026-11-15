import React from "react";
import { CalendarPlus, Check, Share2 } from "lucide-react";

import { downloadCalendarFile, calendarEventFromClub } from "../shared/event-calendar.js";
import { eventShareUrl } from "../shared/events-display.js";

const h = React.createElement;

function icon(Icon) {
  return h(Icon, { key: "i", "aria-hidden": "true", focusable: "false", size: 16, strokeWidth: 2 });
}

/** Client-generated .ics download. `event` needs name + date/starts_at (+ course_name/layout_name). */
export function EventCalendarButton({ event }) {
  const item = React.useMemo(() => calendarEventFromClub(event), [event]);
  if (!item) return null;
  return h("button", {
    className: "event-action-btn",
    onClick: () => downloadCalendarFile(item),
    type: "button",
  }, [icon(CalendarPlus), h("span", { key: "t" }, "Add to calendar")]);
}

/** Web Share API with a copy-link fallback. */
export function EventShareButton({ event }) {
  const [state, setState] = React.useState("idle");
  React.useEffect(() => {
    if (state === "idle") return undefined;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (!event || event.id == null || event.id === "") return null;

  async function share() {
    const url = eventShareUrl(window.location.origin, window.location.pathname, event.id);
    const title = String(event.name || "Club event");
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setState("failed");
    }
  }

  const label = state === "copied" ? "Link copied" : state === "failed" ? "Copy failed" : "Share";
  return h("button", { className: "event-action-btn", onClick: share, type: "button" }, [
    icon(state === "copied" ? Check : Share2),
    h("span", { key: "t", "aria-live": "polite" }, label),
  ]);
}
