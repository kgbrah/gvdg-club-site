import React from "react";

import {
  formatClubDateTime,
  formatEventDate,
  formatLabel,
  statusLabel,
  typeLabel,
} from "../shared/events-model.js";
import { WeatherStrip } from "../score-app/weather-strip.js";
import { HoleMap } from "../shared/hole-map.js";
import { liveWatchHref } from "../shared/live-watch.js";
import { unawardedLiveCtps } from "../shared/live-pots-model.js";
import { displayMatchStatus } from "../shared/match-status.js";
import { TeeSignSvg } from "../shared/tee-sign-svg.js";
import { UDiscExportDetails, udiscDeepLink } from "../shared/udisc-export.js";
import { useEventsEventDetail } from "./events-detail-data.js";
import { EventLiveChat } from "./events-live-chat.js";
import { EventFieldRoster } from "../shared/event-field-roster.js";
import { LiveStandings } from "./live-standings.js";

const h = React.createElement;

function cleanClassName(value) {
  return String(value || "").replace(/[^a-z0-9_-]/gi, "");
}

function safeHref(raw) {
  if (!raw) return "";
  const value = String(raw);
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function cellText(value, fallback = "0") {
  return value == null || value === "" ? fallback : String(value);
}

function fmtToPar(value) {
  const n = Number(value) || 0;
  return n === 0 ? "E" : n > 0 ? `+${n}` : String(n);
}

function parseJson(raw, fallback = null) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseMatchResult(raw) {
  const match = parseJson(raw, null);
  return match && match.status ? match : null;
}

function Badge({ className = "", text }) {
  return h("span", { className: `badge ${className}`.trim() }, text || "");
}

function BackButton() {
  function backToHub() {
    window.location.hash = "";
  }

  return h("button", { className: "back-link", onClick: backToHub, type: "button" }, "\u2190 All events");
}

function DetailFact({ label, value }) {
  if (value == null || value === "") return null;
  return h("div", { className: "detail-fact" }, [
    h("div", { className: "label", key: "label" }, label),
    h("div", { className: "value", key: "value" }, value),
  ]);
}

function ExternalLink({ href, text }) {
  const clean = safeHref(href);
  if (!clean) return null;
  return h("a", { href: clean, rel: "noopener noreferrer", target: "_blank" }, text);
}

function DetailFacts({ course, courseSummary, event }) {
  const udiscHref = course && safeHref(course.udisc_url);
  const courseName = course && course.name ? String(course.name) : "";
  const venueText = courseSummary || courseName;
  const hasMultipleVenues = Array.isArray(event.event_courses) && event.event_courses.length > 1;
  const externalHref = safeHref(event.external_url);

  return h("div", { className: "detail-facts" }, [
    h(DetailFact, { key: "date", label: "Date", value: formatEventDate(event.date) }),
    event.starts_at ? h(DetailFact, { key: "starts", label: "Starts", value: formatClubDateTime(event.starts_at) }) : null,
    event.registration_deadline
      ? h(DetailFact, {
        key: "registration",
        label: "Registration closes",
        value: formatClubDateTime(event.registration_deadline),
      })
      : null,
    event.checkin_deadline
      ? h(DetailFact, {
        key: "checkin",
        label: "Check-in closes",
        value: formatClubDateTime(event.checkin_deadline),
      })
      : null,
    event.format ? h(DetailFact, { key: "format", label: "Format", value: formatLabel(event.format) }) : null,
    venueText
      ? h(DetailFact, {
        key: "course",
        label: hasMultipleVenues ? "Courses / layouts" : "Course",
        value: udiscHref && !hasMultipleVenues
          ? h(React.Fragment, null, [
            `${venueText} `,
            h(ExternalLink, { href: udiscHref, key: "link", text: "(UDisc)" }),
          ])
          : venueText,
      })
      : null,
    externalHref
      ? h(DetailFact, {
        key: "external",
        label: "More info",
        value: h(ExternalLink, { href: externalHref, text: "External link" }),
      })
      : null,
  ]);
}

function keepScoreHref(data) {
  const event = data.event || {};
  let href = `score.html?event=${encodeURIComponent(event.id || "")}`;
  if (!data.memberToken && data.guestReg && data.guestReg.guestToken) {
    href += `&gt=${encodeURIComponent(data.guestReg.guestToken)}`;
  }
  return href;
}

function LivePanel({ data }) {
  const snapshot = data.liveSnapshot || null;
  const liveCtps = unawardedLiveCtps(snapshot && snapshot.liveCtps, data.extras && data.extras.ctps);
  const canScore = Boolean(data.memberToken || (data.guestReg && data.guestReg.guestToken));
  return h(React.Fragment, null, [
    h("div", { className: "live-banner", key: "banner" }, [
      h("span", { className: "live-dot", key: "dot" }),
      h("span", { key: "label" }, "Live scoring in progress"),
      h("span", { className: "lb-conn", key: "connection" }, data.liveConnection || "Connecting"),
    ]),
    h("a", { className: "btn-watch-live", href: liveWatchHref({ eventId: data.event && data.event.id }), key: "watch" }, "Watch live"),
    canScore
      ? h("a", { className: "btn-keep-score", href: keepScoreHref(data), key: "score" }, "Keep score for my card")
      : null,
    snapshot && snapshot.weather
      ? h("div", { className: "live-weather", key: "weather" }, h(WeatherStrip, { title: "Round weather", weather: snapshot.weather }))
      : null,
    liveCtps.length
      ? h("ul", { className: "extras-list", key: "live-ctps" }, liveCtps.map((ctp) =>
        h("li", { key: ctp.id || ctp.hole }, `CTP hole ${ctp.hole}${ctp.division ? ` (${ctp.division})` : ""} · Leader: ${ctp.leaderName}`),
      ))
      : null,
    h(LiveStandings, { key: "standings", snapshot }),
    h(EventLiveChat, {
      apiBase: data.apiBase || "",
      eventId: data.event && data.event.id,
      key: "chat",
      memberName: data.memberName || "",
      memberToken: data.memberToken || "",
    }),
  ]);
}

function fmtBreakdown(raw) {
  const breakdown = parseJson(raw, {}) || {};
  const parts = [];
  const add = (key, label) => {
    const value = Number(breakdown[key]) || 0;
    if (value) parts.push(`${value} ${label}${value > 1 ? "s" : ""}`);
  };
  add("aces", "ace");
  add("eagles", "eagle");
  add("birdies", "birdie");
  add("pars", "par");
  add("bogeys", "bogey");
  add("doubles_plus", "dbl+");
  return parts.join(" · ");
}

function FinalResults({ course, data }) {
  const results = Array.isArray(data.finalResults) ? data.finalResults : [];
  const loaded = data.finalResultsLoaded === true;
  const matchplay = results.some((result) => parseMatchResult(result && result.match_result));
  const columns = matchplay ? ["Pos", "Player", "Match", "Scoring"] : ["Pos", "Player", "Total", "To Par", "Scoring"];
  const udiscCourseId = course && course.udisc_course_id;
  const addable = results.filter((result) => result && result.scorecard);
  const canExportToUdisc = Boolean(udiscDeepLink(udiscCourseId) && addable.length);

  return h("section", { "data-react-events-final-results": "true" }, [
    h("h3", { className: "roster-title", key: "title" }, "Final results"),
    !loaded
      ? h("p", { className: "lb-empty", key: "loading" }, "Loading results...")
      : !results.length
        ? h("p", { className: "lb-empty", key: "empty" }, "Results not posted yet.")
        : h("div", { className: "lb-wrap", key: "table" }, h("table", { className: "lb-table" }, [
          h("thead", { key: "head" }, h("tr", null, columns.map((label) => h("th", { key: label }, label)))),
          h("tbody", { key: "body" }, results.map((result, index) => {
            const match = parseMatchResult(result && result.match_result);
            const toPar = Number(result && result.to_par) || 0;
            const scoringGroup = parseJson(result && result.scoring_group, null);
            const scoringLabel = scoringGroup && scoringGroup.label ? String(scoringGroup.label) : "";
            const name = cellText(result && result.name, "Player");
            return h("tr", { key: `${result && result.place}|${name}|${index}` }, [
              h("td", { className: "lb-pos", key: "pos" }, result && result.place != null ? String(result.place) : "-"),
              h("td", { className: "lb-name", key: "name" }, [
                name,
                scoringLabel ? h("span", { className: "lb-members", key: "group" }, ` · ${scoringLabel}`) : null,
              ]),
              matchplay
                ? h("td", { className: "lb-match", key: "match" }, match ? displayMatchStatus(match) : "-")
                : h("td", { key: "total" }, result && result.total != null ? String(result.total) : "-"),
              matchplay ? null : h("td", {
                className: `lb-topar${toPar < 0 ? " under" : toPar > 0 ? " over" : ""}`,
                key: "to-par",
              }, result && result.to_par != null ? fmtToPar(result.to_par) : "-"),
              h("td", { className: "res-chips", key: "breakdown" }, fmtBreakdown(result && result.breakdown)),
            ]);
          })),
        ])),
    canExportToUdisc
      ? h("div", { className: "udisc-export-section", key: "udisc" }, [
        h("h4", { className: "roster-title", key: "title" }, "Add your round to UDisc"),
        addable.map((result, index) => h(UDiscExportDetails, {
          courseId: udiscCourseId,
          key: `${result.name}|${index}`,
          label: result && result.name ? `Add ${result.name} to UDisc` : "Add to UDisc",
          scorecard: result && result.scorecard,
        })),
      ])
      : null,
  ]);
}

function EventExtras({ extras }) {
  const ctps = extras && Array.isArray(extras.ctps) ? extras.ctps : [];
  const acePot = extras && extras.acePot ? extras.acePot : null;
  const money = (cents) => `$${((Number(cents) || 0) / 100).toLocaleString()}`;
  const blocks = [];

  if (ctps.length) {
    blocks.push(h("h3", { className: "roster-title", key: "ctps-title" }, "CTPs (closest to pin)"));
    blocks.push(h("ul", { className: "extras-list", key: "ctps" }, ctps.map((ctp, index) => {
      const bits = [
        `Hole ${cellText(ctp.hole, "-")}`,
        ctp.division ? `(${ctp.division})` : "",
        ctp.prize ? String(ctp.prize) : "",
        ctp.winner_name ? `Winner: ${ctp.winner_name}` : "",
      ].filter(Boolean);
      return h("li", { key: `${ctp.hole}|${index}` }, bits.join(" · "));
    })));
  }

  if (acePot && ((Number(acePot.total_cents) || 0) > 0 || (acePot.status && acePot.status !== "active"))) {
    let text;
    if (acePot.status === "paid_out") text = `Paid out${acePot.winner_name ? ` to ${acePot.winner_name}` : ""}`;
    else if (acePot.status === "carried") text = `${money(acePot.total_cents)} carried to the next event`;
    else text = `${money(acePot.total_cents)} in the pot${acePot.contributors ? ` (${acePot.contributors} in)` : ""}`;
    blocks.push(h("h3", { className: "roster-title", key: "ace-title" }, "Ace pot"));
    blocks.push(h("p", { className: "detail-notes", key: "ace" }, text));
  }

  return blocks.length ? h(React.Fragment, null, blocks) : null;
}

function safeWinnerClass(value) {
  const key = String(value || "").toLowerCase();
  return key === "red" || key === "blue" || key === "tie" ? key : "";
}

function TeeSigns({ apiBase, teeSigns }) {
  const holes = teeSigns && Array.isArray(teeSigns.holes) ? teeSigns.holes : [];
  if (!holes.length) return null;
  const layout = teeSigns.layout || null;
  const courseName = teeSigns.courseName || "";

  return h(React.Fragment, null, [
    h("h3", { className: "roster-title", key: "title" }, `Tee Signs${layout && layout.name ? ` - ${layout.name}` : ""}`),
    h("div", { className: "tee-signs-grid", key: "grid" }, holes.map((hole) => {
      const winner = safeWinnerClass(hole.winner);
      const className = `ts-hole-card${winner ? ` winner-${winner}` : ""}`;
      const bits = [];
      if (hole.par != null) bits.push(`Par ${hole.par}`);
      if (hole.distance_ft != null) bits.push(`${hole.distance_ft} ft`);
      return h("div", { className, key: String(hole.hole) }, [
        h(HoleMap, { compact: true, hole, key: "map" }),
        hole.signId != null
          ? h("img", {
            alt: `Tee sign, hole ${hole.hole}`,
            className: "ts-hole-photo",
            key: "photo",
            loading: "lazy",
            src: `${apiBase}/tee-signs/${encodeURIComponent(hole.signId)}/image`,
          })
          : h("div", { className: "ts-hole-svg", key: "svg" }, h(TeeSignSvg, {
            courseName,
            hole: hole && hole.hole,
            layouts: [{
              color: (hole && (hole.color || (hole.tee && hole.tee.color))) || null,
              distance_ft: hole && hole.distance_ft != null ? hole.distance_ft : null,
              label: layout && layout.name ? layout.name : "Layout",
              par: hole && hole.par != null ? hole.par : null,
            }],
          })),
        h("div", { className: "ts-hole-meta", key: "meta" }, [
          h("span", { className: "ts-hole-num", key: "hole" }, `Hole ${hole.hole}`),
          bits.length ? ` · ${bits.join(" · ")}` : "",
        ]),
      ]);
    })),
  ]);
}

function PlayerRoster({ event }) {
  const field = Array.isArray(event.field) && event.field.length ? event.field : (Array.isArray(event.players) ? event.players : []);
  return h(EventFieldRoster, { players: field });
}

export function EventsEventDetailApp() {
  const data = useEventsEventDetail();
  if (!data) return null;
  const event = data.event || {};
  const course = data.course || null;
  const typeClass = cleanClassName(event.type);
  const statusClass = cleanClassName(event.status);

  return h(React.Fragment, null, [
    h(BackButton, { key: "back" }),
    h("article", { className: "detail-card", key: "card", "data-react-events-event-detail": "true" }, [
      h("div", { className: "detail-head", key: "head" }, [
        h("h2", { className: "detail-title", key: "title" }, event.name || "Event"),
        event.type ? h(Badge, { className: `type-badge ${typeClass}`, key: "type", text: typeLabel(event.type) }) : null,
        event.status ? h(Badge, { className: `status-badge ${statusClass}`, key: "status", text: statusLabel(event.status) }) : null,
      ]),
      event.status === "live" ? h(LivePanel, { data, key: "live" }) : null,
      event.status === "final" ? h(FinalResults, { course, data, key: "final" }) : null,
      h(DetailFacts, { course, courseSummary: data.courseSummary, event, key: "facts" }),
      event.notes ? h("div", { className: "detail-notes", key: "notes" }, String(event.notes)) : null,
      h(PlayerRoster, { event, key: "players" }),
      h(EventExtras, { extras: data.extras, key: "extras" }),
      h(TeeSigns, { apiBase: data.apiBase || "", key: "tee-signs", teeSigns: data.teeSigns }),
    ]),
  ]);
}
