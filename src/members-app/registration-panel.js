import React from "react";
import { MoreLink } from "./more-link.js";

import { useMemberContext } from "./member-context.js";
import { CasualRoundsSection } from "./registration-casual.js";
import { CompletedEventSection, EventRegistrationSections } from "./registration-events.js";
import { PdgaEventsSection } from "./pdga-events-panel.js";
import { ClubmatesAtPdgaSection } from "./pdga-registrations.js";
import { useRegistrationData } from "./registration-data.js";

const h = React.createElement;

export function MemberRegistrationPanel({ eventId } = {}) {
  const context = useMemberContext();
  const { token, state, reload } = useRegistrationData();
  React.useEffect(() => {
    if (!eventId || state.status !== "ready") return undefined;
    const frame = requestAnimationFrame(() => {
      const event = document.querySelector(`[data-member-event-id="${eventId}"]`);
      event?.scrollIntoView({ block: "start" });
      event?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [eventId, state.status]);

  if (!token) return null;

  return h("div", { className: "react-registration-panel events-timeline member-subpage", "data-react-registration-panel": state.status }, [
    h("nav", { className: "member-subactions", "aria-label": "Event tools", key: "event-tools" }, [
      h(MoreLink, { tab: "leagues", className: "dashboard-action", key: "league" }),
      h(MoreLink, { tab: "results", className: "dashboard-action", key: "results" }),
    ]),
    state.status === "loading" && !state.events.length && !state.registrations.length ? h("p", { className: "dash-note", key: "loading" }, "Loading registration options…") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error" }, "Registration is temporarily unavailable. Please refresh or try again in a minute.") : null,
    state.status !== "error" ? h("div", { className: "member-events-sections", key: "content" }, [
      h(EventRegistrationSections, {
        events: state.events,
        registrations: state.registrations,
        token,
        paymentsConfig: state.paymentsConfig,
        onReload: reload,
        pdgaMine: state.pdga.mine,
        key: "events",
      }),
      h(PdgaEventsSection, { key: "pdga" }),
      h(ClubmatesAtPdgaSection, { events: state.pdga.club, key: "pdga-club" }),
      h(CasualRoundsSection, {
        token,
        requests: state.casualRequests,
        viewerSub: context.sub,
        onReload: reload,
        key: "casual",
      }),
    ]) : h(PdgaEventsSection, { key: "pdga" }),
  ]);
}

/** Event results tab: the member's finished registrations, above the club results list. */
export function MemberCompletedEvents() {
  const { token, state, reload } = useRegistrationData();
  if (!token || state.status === "error") return null;
  return h(CompletedEventSection, {
    events: state.events,
    registrations: state.registrations,
    token,
    paymentsConfig: state.paymentsConfig,
    onReload: reload,
  });
}
