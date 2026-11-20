import React from "react";
import { ChevronDown, ChevronRight, MapPin } from "lucide-react";

import { safeExternalUrl } from "../shared/safe-url.js";
import {
  isClubEvent,
  parseHomepageEventCsv,
  parseHomepageEventDate,
  parseTournamentDate,
} from "../shared/home-feed-parse.js";
import { resolveApiBase } from "../shared/api-base.js";
import { PdgaCredit, PdgaLink } from "../shared/pdga-credit.js";

const h = React.createElement;
const VISIBLE_LIMIT = 5;
const EVENT_FEED_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTLTq17Bwgy6uW_9pG7dQODTmahv7vjxo9Y5EShHaeQYo9xPB2m7Nf5de8EcZvKgcrTbBLb97msMg4Q/pub?output=csv";
const RYDER_CUP_LEAGUE_URL = "events.html#league/4";
// Area Tournaments: PDGA-sanctioned events from PDGA's API (the Worker's /pdga-events, the club's developer account),
// within 60 miles of the club; each name links to its pdga.com event page and PDGA is credited under the list.
const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 };
const AREA_MILES = 60;
const PDGA_SEARCH_URL = "https://www.pdga.com/tour/search";

function icon(Icon, props = {}) {
  return h(Icon, {
    ...props,
    "aria-hidden": "true",
    focusable: "false",
    size: props.size || 16,
    strokeWidth: props.strokeWidth || 2.4,
  });
}

function isRyderCupEvent(event) {
  return /\bryder\s*cup\b/i.test(String(event?.title || ""));
}

function loading(className, spinnerClassName, text) {
  return h("div", { className, role: "status" }, [
    h("div", { className: spinnerClassName, key: "spinner" }),
    h("p", { key: "text" }, text),
  ]);
}

function ToggleButton({ expanded, label, onClick }) {
  return h("button", { className: "toggle-btn" + (expanded ? " expanded" : ""), type: "button", onClick }, [
    h("span", { className: "toggle-text", key: "text" }, expanded ? "Show less" : label),
    icon(ChevronDown, { className: "toggle-icon", key: "icon", size: 20 }),
  ]);
}

function EventItem({ event, index, visible }) {
  const localUrl = isRyderCupEvent(event) ? RYDER_CUP_LEAGUE_URL : "";
  const url = localUrl || safeExternalUrl(event.url);
  const dateInfo = parseHomepageEventDate(event.date);
  const Tag = url ? "a" : "div";
  const classes = ["event-item", "fade-in", "visible"];
  if (url) classes.push("has-link");
  if (dateInfo.isTBD) classes.push("tbd-event");
  if (!visible) classes.push("hidden-extra");
  const props = { className: classes.join(" "), key: `${event.title}-${event.date}-${index}` };
  if (url) {
    props.href = url;
    if (!localUrl) {
      props.target = "_blank";
      props.rel = "noopener noreferrer";
    }
  }
  return h(Tag, props, [
    h("div", { className: dateInfo.isTBD ? "event-date tbd" : "event-date", key: "date" }, [
      h("div", { className: "event-day", key: "day" }, dateInfo.isTBD ? "TBD" : String(dateInfo.day)),
      dateInfo.isTBD ? null : h("div", { className: "event-month", key: "month" }, dateInfo.month),
    ]),
    h("div", { className: "event-info", key: "info" }, [
      h("h3", { className: "event-title", key: "title" }, event.title),
      h("p", { className: "event-description", key: "description" }, event.description || ""),
    ]),
  ]);
}

/** /pdga-events -> the Area Tournaments rows: within 60 miles, PDGA's order (soonest first). */
export function areaTournamentsFromPdga(data, miles = AREA_MILES) {
  const events = Array.isArray(data && data.events) ? data.events : [];
  return events
    // "Within 60 miles": an event PDGA lists without coordinates can't be shown to be near, unless the club runs it.
    .filter((event) => event && event.name && ((event.miles != null && Number(event.miles) <= miles) || Number(event.clubEventId) > 0))
    .map((event) => {
      const pdgaUrl = safeExternalUrl(event.pdgaUrl);
      const clubEventId = Number(event.clubEventId);
      return {
        name: String(event.name),
        date: String(event.date || ""),
        tier: String(event.tier || ""),
        location: String(event.place || ""),
        pdgaUrl: /^https:\/\/www\.pdga\.com\//.test(pdgaUrl) ? pdgaUrl : "",
        clubEventId: Number.isInteger(clubEventId) && clubEventId > 0 ? clubEventId : null,
      };
    });
}

function TournamentItem({ tournament, visible }) {
  const dateInfo = parseTournamentDate(tournament.date);
  // The name links to the event's pdga.com page and covers the card, so the whole row still opens it.
  return h("div", { className: "tournament-item tournament-item-pdga" + (visible ? "" : " hidden-mobile") }, [
    h("div", { className: "tournament-date", key: "date" }, [
      h("span", { className: "month", key: "month" }, dateInfo ? dateInfo.month : "TBD"),
      h("span", { className: "day", key: "day" }, dateInfo ? String(dateInfo.day) : "--"),
    ]),
    h("div", { className: "tournament-info", key: "info" }, [
      h(PdgaLink, { as: "h4", className: "tournament-name", href: tournament.pdgaUrl, key: "name" }, tournament.name),
      h("div", { className: "tournament-meta", key: "meta" }, [
        tournament.location
          ? h("span", { className: "tournament-location", key: "location" }, [
              icon(MapPin, { key: "icon", size: 14 }),
              h("span", { key: "text" }, tournament.location),
            ])
          : null,
        tournament.tier ? h("span", { className: "tournament-tier", key: "tier" }, tournament.tier) : null,
        // The club runs this one: it registers on the club's event page.
        tournament.clubEventId
          ? h("a", { className: "tournament-register", href: `events.html#event/${tournament.clubEventId}`, key: "register" }, "Register with the club")
          : null,
      ]),
    ]),
    icon(ChevronRight, { className: "tournament-arrow", key: "arrow" }),
  ]);
}

export function HomeEventsFeed() {
  const [state, setState] = React.useState({ status: "loading", events: [] });
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`${EVENT_FEED_URL}&_cb=${Date.now()}`);
        if (!response.ok) throw new Error("feed_error");
        const events = parseHomepageEventCsv(await response.text())
          .filter((event) => !isClubEvent(event))
          .filter((event) => !parseHomepageEventDate(event.date).isPast)
          .sort((a, b) => parseHomepageEventDate(a.date).dateObj - parseHomepageEventDate(b.date).dateObj);
        if (active) setState({ status: events.length ? "ready" : "empty", events });
      } catch (error) {
        if (active) setState({ status: "error", events: [] });
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  if (state.status === "loading") {
    return h("div", { "data-react-home-events": "loading" }, h("div", { className: "event-list" }, loading("event-loading", "spinner", "Loading events.")));
  }
  if (state.status === "empty" || state.status === "error") {
    const message = state.status === "empty" ? "No upcoming events." : "Events could not be loaded.";
    return h("div", { "data-react-home-events": state.status }, h("div", { className: "event-list" }, h("div", { className: "no-events" }, h("p", null, message))));
  }

  const showToggle = state.events.length > VISIBLE_LIMIT;
  return h("div", { "data-react-home-events": "ready" }, [
    h("div", { className: "event-list" + (expanded ? " expanded" : ""), key: "list" },
      state.events.map((event, index) => h(EventItem, { event, index, visible: expanded || index < VISIBLE_LIMIT, key: `${event.title}-${event.date}-${index}` }))),
    showToggle
      ? h("div", { className: "event-toggle", key: "toggle" },
          h(ToggleButton, { expanded, label: `Show all ${state.events.length} events`, onClick: () => setExpanded((current) => !current) }))
      : null,
  ]);
}

export function AreaTournamentsFeed() {
  const [state, setState] = React.useState({ status: "loading", tournaments: [] });
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const query = `lat=${encodeURIComponent(CLUB_ORIGIN.lat)}&lng=${encodeURIComponent(CLUB_ORIGIN.lng)}`;
        const response = await fetch(`${resolveApiBase()}/pdga-events?${query}`, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error("feed_error");
        const tournaments = areaTournamentsFromPdga(await response.json());
        setState({ status: tournaments.length ? "ready" : "empty", tournaments });
      } catch (error) {
        if (error?.name !== "AbortError") setState({ status: "error", tournaments: [] });
      }
    }
    load();
    return () => controller.abort();
  }, []);

  if (state.status === "loading") {
    return h("div", { "data-react-home-tournaments": "loading" }, h("div", { className: "tournament-list" }, loading("tournament-loading", "loading-spinner", "Loading tournaments.")));
  }

  const footer = h("div", { className: "tournament-footer", key: "footer" },
    h("a", { className: "view-all-link", href: PDGA_SEARCH_URL, target: "_blank", rel: "noopener noreferrer" }, [
      h("span", { key: "text" }, "More events on PDGA.com"),
      icon(ChevronRight, { key: "icon", size: 14 }),
    ]));

  if (state.status === "empty" || state.status === "error") {
    const message = state.status === "empty" ? "No upcoming PDGA events within 60 miles." : "Tournaments could not be loaded.";
    return h("div", { "data-react-home-tournaments": state.status }, [
      h("div", { className: "tournament-list", key: "list" }, h("div", { className: "no-tournaments" }, h("p", null, message))),
      footer,
    ]);
  }

  const showToggle = state.tournaments.length > VISIBLE_LIMIT;
  return h("div", { "data-react-home-tournaments": "ready" }, [
    h("div", { className: "tournament-list" + (expanded ? " expanded" : ""), key: "list" },
      state.tournaments.map((tournament, index) => h(TournamentItem, { tournament, visible: expanded || index < VISIBLE_LIMIT, key: `${tournament.name}-${tournament.date}-${index}` }))),
    showToggle
      ? h("div", { className: "tournament-toggle", key: "toggle" },
          h(ToggleButton, { expanded, label: `Show all ${state.tournaments.length} tournaments`, onClick: () => setExpanded((current) => !current) }))
      : null,
    footer,
    // PDGA-sanctioned events from PDGA's API: PDGA's attribution.
    h(PdgaCredit, { key: "pdga-credit" }),
  ]);
}
