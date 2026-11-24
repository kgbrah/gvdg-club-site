import React from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { LiveScoringPanel, WalletPanel } from "./activity-panels.js";
import { FirstUseGuide } from "./first-use-guide.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { dollars, formatEventDay, formatToPar } from "./format.js";
import { HomeJobs } from "./home-jobs.js";
import { useMemberContext } from "./member-context.js";
import { historyLocked } from "./membership-needed.js";
import { membershipHomeHint } from "../shared/membership-status.js";
import { PdgaAnnualStats, PdgaEventLinkForm, pdgaEventTitle, usePdgaStats } from "./pdga-dashboard.js";
import { PlayStatsPanel } from "./play-stats-panel.js";
import { useRegistrationData } from "./registration-data.js";
import { eventMeta, pickUpNext } from "./registration-utils.js";
import { latestHomeRound } from "./play-page-model.js";
import { EventScheduleFacts } from "../shared/event-schedule.js";
import { EventFieldRoster } from "../shared/event-field-roster.js";
import { AddToCalendarButton } from "../shared/add-to-calendar.js";
import { EmailReminderCard, WelcomeCard } from "./welcome-card.js";
import { BagTagPanel } from "./bag-tag-panel.js";
import { InboxHomeAlert } from "./inbox-home-alert.js";
import { useInboxSummary } from "./inbox-summary.js";
import { AnnouncementsHomeCard } from "./announcements-home-card.js";
import { WorkdaysHomeCard } from "./workdays-home-card.js";
import { calendarEventFromClub, calendarEventFromPdga, calendarEventFromPdgaRegistration } from "../shared/event-calendar.js";
import { GoingLine, pdgaEventMeta, readPdgaRegistrations } from "./pdga-registrations.js";
import { KarmaChip } from "../shared/karma.js";
import { PdgaCredit, PdgaLink, pdgaEventHref, pdgaPlayerHistoryHref, pdgaPlayerHref } from "../shared/pdga-credit.js";
import { PdgaMembershipCard, pdgaMembershipNeedsAttention } from "../shared/pdga-membership.js";
import { checkPdgaMembershipAgain, usePdgaMembership } from "./pdga-membership.js";
import { OnDemandPdgaLiveDrawer, extractPdgaEventId } from "../shared/pdga-live-panel.js";
import { resolveApiBase } from "../shared/api-base.js";
import { SIGNUP_LINK } from "../shared/outside-link.js";
import { shownProfilePhoto } from "../shared/profile-photo.js";

const h = React.createElement;

// "Recently returned" (Lost & Found): data from the inbox summary Home already loads; code only when needed.
const ReturnedHomeCard = React.lazy(() => import("./returned-home-card.js").then((module) => ({ default: module.ReturnedHomeCard })));

function HomeReturned({ token }) {
  const recent = useInboxSummary(token).lostFound?.recent || [];
  if (!recent.length) return null;
  return h(React.Suspense, { fallback: null }, h(ReturnedHomeCard, { recent }));
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "G";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function HomeHero({ context, pdgaState }) {
  const stats = pdgaState.stats;
  const live = pdgaState.status === "ready" ? stats?.live_rating ?? null : null;
  // Fall back to PDGA's official rating when no recent PDGA Live rounds produce a live estimate.
  const official = pdgaState.status === "ready" ? stats?.official_rating ?? null : null;
  const ratingValue = live != null ? live : official;
  const photo = shownProfilePhoto(context.photo) || null;
  const meta = context.pdgaNo ? `PDGA #${context.pdgaNo}` : "";

  return h("div", {
    className: "player-home-hero",
    "data-react-home-hero": "ready",
    "data-react-member-banner": "ready",
  }, [
    photo
      ? h("img", { className: "player-avatar", src: photo, alt: "", key: "avatar" })
      : h("div", { className: "player-avatar player-avatar-fallback", key: "avatar" }, initials(context.name)),
    h("div", { className: "player-who", key: "who" }, [
      // Your own karma next to your name (the name trims with "…", the chip always shows).
      h("h2", { key: "name" }, h("span", { className: "karma-line" }, [
        h("span", { key: "n" }, context.name || "Member"),
        h(KarmaChip, { key: "karma", memberId: context.sub || "" }),
      ])),
      // Your PDGA number links to your pdga.com page (PDGA's attribution rules).
      meta ? h("p", { key: "meta" }, h(PdgaLink, { href: pdgaPlayerHref(context.pdgaNo) }, meta)) : null,
      pdgaState.status === "empty" ? h("p", { key: "pdga-empty" }, "No PDGA # is linked yet.") : null,
      pdgaState.status === "missing" ? h("p", { key: "pdga-missing" }, "PDGA ratings are unavailable right now.") : null,
      pdgaState.status === "error" ? h("p", { key: "pdga-error" }, "Could not load PDGA stats.") : null,
    ]),
    h("div", {
      className: "player-rating-pill",
      "data-react-live-rating": live != null ? "true" : undefined,
      "data-react-pdga-rating": ratingValue != null ? "true" : "empty",
      key: "rating",
    }, [
      h("b", { className: "dash-tile-num", "data-rating-value": "true", key: "value" }, ratingValue != null ? String(ratingValue) : "—"),
      h("span", { key: "label" }, live != null ? "Live rating estimate" : "PDGA rating"),
    ]),
  ]);
}

function UpNextCard({ events, registrations }) {
  const { event, registration } = pickUpNext(events, registrations);
  if (!event) {
    return h("section", { className: "player-story-block", "data-react-home-next": "empty" }, [
      h("h3", { key: "title" }, "Up next"),
      h("p", { className: "player-card-meta", key: "empty" }, "Nothing on your schedule right now."),
      h("div", { className: "member-action-grid", key: "actions" }, [
        h("button", {
          type: "button",
          className: "player-btn primary",
          onClick: () => selectDashboardTab("events"),
          key: "events",
        }, "See events"),
      ]),
    ]);
  }

  const when = formatEventDay(event.date);
  const fee = event.entry_fee_cents ? dollars(event.entry_fee_cents) : null;
  const meta = [when, eventMeta(event), fee].filter(Boolean).join(" · ");
  const live = event.status === "live";
  const chip = live ? "Live" : registration ? "You're in" : "Open";
  const actionLabel = live && registration ? "Open scorecard" : registration ? "View event" : "Register";

  return h("div", { className: "player-story-block", "data-react-home-next": registration ? "registered" : "ready" }, [
    h("h3", { key: "title" }, "Up next"),
    h("div", { className: "player-event-name", key: "name" }, event.name || "Club event"),
    meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
    h(EventScheduleFacts, { event, key: "schedule" }),
    h(EventFieldRoster, { compact: true, key: "field", players: event.field }),
    h("div", { className: "player-chip-row", key: "chips" }, [
      h("span", { className: `player-chip${live ? " live" : ""}`, key: "status" }, chip),
      event.play_format === "doubles" ? h("span", { className: "player-chip", key: "format" }, "Doubles") : null,
    ].filter(Boolean)),
    h("div", { className: "member-action-grid", key: "actions" }, [
      h("button", {
        type: "button",
        className: "player-btn primary",
        onClick: () => {
          if (live && registration) {
            window.location.href = `score.html?event=${encodeURIComponent(event.id)}`;
            return;
          }
          selectDashboardTab("events", { eventId: event.id });
        },
        key: "register",
      }, actionLabel),
      h(AddToCalendarButton, { className: "player-btn", item: calendarEventFromClub(event), key: "cal", label: "Calendar" }),
    ]),
  ]);
}

const CLUB_ORIGIN = { lat: 35.6127, lng: -77.3664 };

/** Next PDGA: the member's own next registered PDGA event (checked hourly via PDGA's API), else the nearest upcoming one. */
function NextPdgaCard({ token }) {
  const [event, setEvent] = React.useState(null);
  const [mine, setMine] = React.useState(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const query = `/pdga-events?lat=${encodeURIComponent(CLUB_ORIGIN.lat)}&lng=${encodeURIComponent(CLUB_ORIGIN.lng)}`;
    requestJson(query, { signal: controller.signal })
      .then((data) => {
        const events = Array.isArray(data?.events) ? data.events : [];
        setEvent(events[0] || null);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setEvent(null);
      });
    if (token) {
      requestJson("/pdga-registrations", { signal: controller.signal, token })
        .then((data) => setMine(readPdgaRegistrations(data).mine[0] || null))
        .catch(() => {});
    }
    return () => controller.abort();
  }, [token]);

  if (mine) {
    const liveId = extractPdgaEventId(mine.eventId, mine.url);
    return h("div", { className: "player-story-block", "data-react-home-pdga": "registered", key: "pdga" }, [
      h("h3", { key: "title" }, "Next PDGA"),
      h(PdgaLink, { as: "div", className: "player-event-name", href: mine.url, key: "name" }, mine.name),
      h("div", { className: "player-card-meta", key: "meta" }, pdgaEventMeta(mine)),
      h("div", { className: "player-chip-row", key: "chips" }, h("span", { className: "player-chip" }, "You're registered" + (mine.division ? " · " + mine.division : ""))),
      mine.going?.length ? h(GoingLine, { className: "player-card-meta", going: mine.going, key: "going", prefix: "Also going: " }) : null,
      h("div", { className: "member-action-grid", key: "actions" }, [
        h("a", { className: "player-btn primary", href: mine.url, key: "pdga", rel: "noopener noreferrer", target: "_blank" }, "PDGA page"),
        h(AddToCalendarButton, { className: "player-btn", item: calendarEventFromPdgaRegistration(mine), key: "cal", label: "Calendar" }),
        h("button", { className: "player-btn", key: "all", type: "button", onClick: () => selectDashboardTab("events") }, "All events"),
      ]),
      liveId ? h(OnDemandPdgaLiveDrawer, {
        apiBase: resolveApiBase(),
        eventId: liveId,
        pdgaUrl: mine.url,
        division: mine.division || "",
        buttonClassName: "player-btn",
        key: "live",
      }) : null,
    ].filter(Boolean));
  }
  if (!event) return null;
  const miles = typeof event.miles === "number" ? `${event.miles.toFixed(1)} mi` : "";
  const meta = [event.date, event.course, miles].filter(Boolean).join(" · ");
  const liveId = extractPdgaEventId(event.eventId, event.pdgaUrl);
  return h("div", { className: "player-story-block", "data-react-home-pdga": "ready", key: "pdga" }, [
    h("h3", { key: "title" }, "Next PDGA"),
    h(PdgaLink, { as: "div", className: "player-event-name", href: event.pdgaUrl, key: "name" }, event.name),
    meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
    h("div", { className: "member-action-grid", key: "actions" }, [
      h("a", {
        className: "player-btn primary",
        href: event.url,
        key: "register",
        // The club's own PDGA events register on the club site (a path here): open it in place.
        ...(String(event.url || "").startsWith("/") ? {} : SIGNUP_LINK),
      }, "Register"),
      h(AddToCalendarButton, { className: "player-btn", item: calendarEventFromPdga(event), key: "cal", label: "Calendar" }),
      h("button", {
        className: "player-btn",
        key: "all",
        type: "button",
        onClick: () => selectDashboardTab("events"),
      }, "All events"),
    ]),
    liveId ? h(OnDemandPdgaLiveDrawer, {
      apiBase: resolveApiBase(),
      eventId: liveId,
      pdgaUrl: event.pdgaUrl,
      buttonClassName: "player-btn",
      key: "live",
    }) : null,
  ].filter(Boolean));
}

function LastRoundCard(props) {
  const context = useMemberContext();
  if (historyLocked(context)) return null;
  return h(LastRoundCardBody, props);
}

function LastRoundCardBody({ token, onCasualHistory }) {
  const [state, setState] = React.useState({ status: "idle", row: null });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", row: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", row: null });
    requestJson("/my-results?all=1", { token, signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        onCasualHistory(Array.isArray(payload?.casual) && payload.casual.length > 0);
        setState({ status: "ready", row: latestHomeRound(payload?.results, payload?.casual) });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "error", row: null });
      });
    return () => controller.abort();
  }, [token, onCasualHistory]);

  const row = state.row;
  const meta = row
    ? [
      formatEventDay(row.when),
      row.kind === "casual" ? "Casual" : (row.place != null ? "Competitive" : null),
      row.layout || null,
    ].filter(Boolean).join(" · ")
    : "";
  return h("div", { className: "player-story-block", "data-react-home-last-round": state.status }, [
    h("h3", { key: "title" }, "Last round"),
    row
      ? h("a", {
        className: "player-list-row",
        href: row.href,
        key: "row",
      }, [
        h("div", { className: "member-list-copy", key: "copy" }, [
          h("div", { className: "player-event-name", key: "name" }, row.title || "Round"),
          meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
          row.mix ? h("div", { className: "player-card-meta", key: "mix" }, row.mix) : null,
        ]),
        h("div", { className: "player-score", key: "score" }, [
          h("b", { key: "par" }, row.toPar != null ? formatToPar(row.toPar) : row.total != null ? String(row.total) : "—"),
          h("span", { key: "place" }, row.place != null ? `#${row.place}` : "Card"),
          row.rating != null ? h("span", { className: "round-rating", key: "rating", "aria-label": `Round rating ${row.rating}` }, String(row.rating)) : null,
        ]),
      ])
      : h("p", { className: "player-card-meta", key: "empty", role: state.status === "error" ? "alert" : undefined },
        state.status === "loading" ? "Loading last round…" : state.status === "error" ? "Could not load your last round." : "No finished round yet."),
  ]);
}

function RatingMove({ stats, status, pdgaNo, refreshing, refreshMessage, onRefresh }) {
  if (status !== "ready" || !stats) return null;
  const official = stats.official_rating;
  const annual = Array.isArray(stats.annual_stats) ? stats.annual_stats : [];
  if (official == null && !annual.length) return null;
  const previous = stats.previous_rating;
  let move = stats.rating_date ? `As of ${stats.rating_date}` : "Official rating";
  let tone = "";
  if (official != null && previous != null && previous !== official) {
    const delta = official - previous;
    tone = delta > 0 ? "up" : "down";
    move = `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} from ${previous}`;
  }
  return h("div", { className: "player-story-block", key: "rating" }, [
    h("div", { className: "player-job-head", key: "head" }, [
      h("h3", { key: "title" }, "PDGA official rating"),
      onRefresh ? h("button", {
        type: "button",
        className: "player-job-link pdga-refresh-btn",
        "data-pdga-refresh": "true",
        disabled: refreshing,
        key: "refresh",
        onClick: () => { void onRefresh(); },
      }, refreshing ? "Refreshing…" : "Refresh") : null,
    ].filter(Boolean)),
    official != null ? h("div", { className: "player-story-rating", key: "row" }, [
      h("b", { key: "n" }, String(official)),
      h("span", { className: `player-story-move ${tone}`.trim(), key: "move" }, move),
    ]) : null,
    refreshMessage ? h("p", { className: "player-card-meta", role: "status", key: "msg" }, refreshMessage) : null,
    annual.length ? h("div", { className: "pdga-home-annual", key: "annual" }, [
      h(PdgaAnnualStats, { pdgaNo, rows: annual, compact: true, key: "list" }),
      h("button", {
        type: "button",
        className: "player-job-link",
        key: "stats-tab",
        onClick: () => selectDashboardTab("season"),
      }, "Full PDGA stats"),
    ]) : null,
  ].filter(Boolean));
}

function PdgaHistory({ stats, pdgaNo, token, onReload }) {
  if (!pdgaNo) return null;
  const events = Array.isArray(stats?.events) ? stats.events : [];
  const historyHref = pdgaPlayerHistoryHref(pdgaNo);
  const summaryLabel = events.length ? `PDGA events (${events.length})` : "PDGA events & round loader";
  return h("details", { className: "dash-collapse player-story-history", key: "history" }, [
    h("summary", { className: "dash-collapse-summary", key: "summary" }, summaryLabel),
    events.length
      ? h("div", { className: "player-story-events", key: "list" }, events.slice(0, 6).map((event, index) =>
        h("div", { className: "player-list-row", key: `${event.tournament || "event"}-${event.epoch || index}` }, [
          h("div", { className: "member-list-copy", key: "copy" }, [
            h(PdgaLink, { as: "div", className: "player-event-name", href: pdgaEventHref(event.eventId), key: "name" }, pdgaEventTitle(event.tournament) || "Event"),
            h("div", { className: "player-card-meta", key: "meta" }, [event.date, event.division].filter(Boolean).join(" · ")),
          ]),
          h("div", { className: "player-score", key: "score" }, [
            h("b", { key: "r" }, event.rounds?.[0]?.rating != null ? String(event.rounds[0].rating) : "—"),
            h("span", { key: "l" }, "Round rating"),
          ]),
        ]),
      ))
      : h("p", { className: "player-card-meta", key: "empty" }, "No recent regional PDGA Live rounds matched yet. Load a tournament by PDGA event # below."),
    h(PdgaEventLinkForm, { pdgaNo, token, onLinked: onReload, key: "link-form" }),
    historyHref ? h("p", { className: "player-card-meta pdga-history-more", key: "more" }, h("a", {
      className: "pdga-link",
      href: historyHref,
      rel: "noopener noreferrer",
      target: "_blank",
    }, "Full PDGA history on PDGA.com")) : null,
  ].filter(Boolean));
}

export function MemberOverviewDashboard() {
  const context = useMemberContext();
  const token = storageGet(TOKEN_KEY);
  const pdgaState = usePdgaStats(context.pdgaNo);
  const pdgaMembership = usePdgaMembership();
  const registration = useRegistrationData();

  const [activeRound, setActiveRound] = React.useState(false);
  const [playedCasual, setPlayedCasual] = React.useState(false);
  const accountHeading = React.useRef(null);
  if (!token) return null;

  return h("div", { className: "react-overview-dashboard player-home", "data-react-overview-dashboard": "ready" }, [
    h(WelcomeCard, { key: "welcome" }),
    h(EmailReminderCard, { key: "email-reminder" }),
    h(InboxHomeAlert, { key: "inbox" }),
    h(HomeHero, { context, pdgaState, key: "hero" }),
    h("div", { className: "member-home-feature", key: "feature" }, [
      h("div", { className: "member-home-play", key: "play" }, [
        h(LiveScoringPanel, { token, compact: true, onCasualActive: setActiveRound, key: "live-scoring" }),
        h(FirstUseGuide, { playedCasual: playedCasual || activeRound, key: "first-use",
          onDismiss: () => accountHeading.current?.focus({ preventScroll: true }),
        }),
      ]),
      h("section", { className: "member-home-services", "aria-label": "Your club account", key: "account" }, [
        h("h2", { key: "heading", ref: accountHeading, tabIndex: -1 }, "Your club account"),
        h(WalletPanel, { token, compact: true, key: "wallet" }),
        h("button", {
          className: "member-account-row member-account-link", type: "button", key: "membership",
          onClick: () => selectDashboardTab("account"),
        }, [
          h(ShieldCheck, { className: "member-account-icon", size: 20, "aria-hidden": true, key: "icon" }),
          h("span", { className: "member-account-copy", key: "copy" }, [
            h("strong", { key: "label" }, "Membership and profile"),
            h("small", { key: "hint" }, membershipHomeHint(context.membership) || "Profile, sign-in and settings"),
          ]),
          h(ChevronRight, { className: "member-account-chevron", size: 18, "aria-hidden": true, key: "arrow" }),
        ]),
        h(BagTagPanel, { key: "bag-tags", token, compact: true }),
      ]),
    ]),
    h(AnnouncementsHomeCard, { token, key: "announcements" }),
    h(WorkdaysHomeCard, { token, key: "workdays" }),
    h(HomeJobs, {
      events: registration.state.events,
      registrations: registration.state.registrations,
      token,
      onReload: registration.reload,
      key: "jobs",
    }),
    h("section", { className: "player-card player-story", "data-react-home-story": "ready", key: "story" }, [
      h(RatingMove, {
        stats: pdgaState.stats,
        status: pdgaState.status,
        pdgaNo: context.pdgaNo,
        refreshing: pdgaState.refreshing,
        refreshMessage: pdgaState.refreshMessage,
        onRefresh: pdgaState.refresh,
        key: "rating",
      }),
      h(LastRoundCard, { token, onCasualHistory: setPlayedCasual, key: "recent" }),
      h(UpNextCard, { events: registration.state.events, registrations: registration.state.registrations, key: "up-next" }),
      h(NextPdgaCard, { key: "next-pdga", token }),
      h(PdgaHistory, { stats: pdgaState.stats, pdgaNo: context.pdgaNo, token, onReload: pdgaState.reload, key: "history" }),
      // Renewal nudge: only when the member's PDGA membership has lapsed or ends soon.
      pdgaMembershipNeedsAttention(pdgaMembership)
        ? h("div", { className: "player-story-block", key: "pdga-membership" }, h(PdgaMembershipCard, { data: pdgaMembership, compact: true, credit: false, onCheckAgain: checkPdgaMembershipAgain })) : null,
      h(PdgaCredit, { key: "pdga-credit" }),
    ]),
    h(PlayStatsPanel, { compact: true, key: "play-stats", pdgaStats: pdgaState.stats, onPdgaReload: pdgaState.reload }),
    h(HomeReturned, { key: "returned", token }),
  ]);
}
