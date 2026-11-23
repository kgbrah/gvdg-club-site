// PDGA events club members are registered for (NC, VA and SC, checked hourly via PDGA's official REST API +
// documented PDGA Live API): the member's own in My events and on Home, and the ones clubmates are going to.
import React from "react";
import { KarmaChip } from "../shared/karma.js";

import { AddToCalendarButton } from "../shared/add-to-calendar.js";
import { calendarEventFromPdgaRegistration, dateRangeText } from "../shared/event-calendar.js";
import { PdgaCredit, PdgaLink } from "../shared/pdga-credit.js";

const h = React.createElement;
const TIERS = { L: "League", NT: "National Tour", M: "Major", ES: "Elite Series", XM: "Major" };
const SHOWN_NAMES = 6;

export const EMPTY_PDGA_REGISTRATIONS = { mine: [], club: [] };

/** GET /pdga-registrations -> { mine, club }; never throws. */
export function readPdgaRegistrations(data) {
  return {
    mine: Array.isArray(data?.mine) ? data.mine : [],
    club: Array.isArray(data?.club) ? data.club : [],
  };
}

export function tierLabel(tier) {
  const value = String(tier || "").trim().toUpperCase();
  if (!value) return "";
  return TIERS[value] || value + "-tier";
}

/** "Ada Lovelace (MA2), Bo Burnham (MA40) and 3 more". */
export function goingText(going) {
  const list = Array.isArray(going) ? going : [];
  const names = list.slice(0, SHOWN_NAMES).map((person) => (person.division ? `${person.name} (${person.division})` : person.name));
  const rest = list.length - names.length;
  return names.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

/** "Also going: Ada Lovelace (MA2) ✦ 10, Bo Burnham (MA40) and 3 more", each name with its karma. */
export function GoingLine({ going, prefix, className = "pdga-registration-going" }) {
  const list = Array.isArray(going) ? going : [];
  const shown = list.slice(0, SHOWN_NAMES);
  const rest = list.length - shown.length;
  return h("p", { className }, [
    prefix,
    ...shown.flatMap((person, index) => [
      index ? ", " : null,
      person.division ? `${person.name} (${person.division})` : person.name,
      h(KarmaChip, { karmaKey: person.karmaKey, key: "karma-" + index }),
    ]),
    rest > 0 ? ` and ${rest} more` : null,
  ]);
}

export function pdgaEventMeta(event) {
  return [dateRangeText(event.start, event.end), tierLabel(event.tier), event.location].filter(Boolean).join(" · ");
}

export function PdgaRegistrationCard({ event, mine = false }) {
  const going = Array.isArray(event.going) ? event.going : [];
  return h("article", {
    className: "register-card pdga-registration-card", "data-pdga-mine": mine ? "true" : "false", "data-pdga-registration": event.eventId,
  }, [
    h("div", { className: "register-head", key: "head" }, [
      h(PdgaLink, { className: "register-name", href: event.url, key: "name" }, event.name),
      h("span", { className: "player-chip", key: "chip" }, "PDGA"),
    ]),
    h("p", { className: "register-date", key: "date" }, dateRangeText(event.start, event.end)),
    h("p", { className: "pdga-event-where", key: "where" }, [tierLabel(event.tier), event.location].filter(Boolean).join(" · ")),
    mine ? h("p", { className: "pdga-registration-you", key: "you" }, "You're registered" + (event.division ? " · " + event.division : "")) : null,
    going.length ? h(GoingLine, { going, key: "going", prefix: mine ? "Also going: " : "Going: " }) : null,
    h("div", { className: "register-actions", key: "actions" }, [
      h("a", { className: "passkey-btn", href: event.url, key: "pdga", rel: "noopener noreferrer", target: "_blank" }, "PDGA page"),
      h(AddToCalendarButton, { item: calendarEventFromPdgaRegistration(event), key: "cal" }),
    ]),
  ]);
}

/** Events clubmates are registered for (not the viewer's own: those are in My events). */
export function ClubmatesAtPdgaSection({ events }) {
  if (!Array.isArray(events) || !events.length) return null;
  return h("section", { className: "pdga-events pdga-club-going", "data-pdga-club-going": events.length }, [
    h("h3", { className: "my-dashboard-title", key: "title" }, "Clubmates at PDGA events"),
    h("p", { className: "dash-note", key: "note" }, "Club members registered for PDGA events in North Carolina, Virginia and South Carolina. Checked hourly via PDGA's API."),
    h("div", { key: "list" }, events.map((event) => h(PdgaRegistrationCard, { event, key: event.eventId }))),
    h(PdgaCredit, { key: "credit" }),
  ]);
}
