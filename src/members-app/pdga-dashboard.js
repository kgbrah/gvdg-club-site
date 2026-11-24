import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import {
  PdgaLink,
  pdgaEventHref,
  pdgaLiveEventHref,
  pdgaPlayerHistoryHref,
  pdgaPlayerHref,
  pdgaPlayerStatsHref,
} from "../shared/pdga-credit.js";

const h = React.createElement;

const HTML_ENTITY_MAP = {
  amp: "&",
  apos: "'",
  quot: '"',
  "#039": "'",
};

const ROUND_STAT_CHIP_LABELS = [
  ["fwh", "FWH"],
  ["c1r", "C1R"],
  ["c2r", "C2R"],
  ["parked", "Parked"],
  ["scramble", "Scramble"],
  ["c1p", "C1P"],
  ["c1x", "C1X"],
  ["c2p", "C2P"],
];

// Shared per-PDGA-number subscribers so refreshing or linking an event updates Home and Stats together.
const pdgaStatsListeners = new Map();

function notifyPdgaStatsChanged(pdgaNo, updater) {
  const listeners = pdgaStatsListeners.get(String(pdgaNo || ""));
  if (!listeners) return;
  for (const listener of listeners) listener(updater);
}

export function pdgaEventTitle(value) {
  return String(value || "").replace(/&(#\d+|#x[\da-fA-F]+|amp|apos|quot|#039);/g, (match, entity) => {
    if (HTML_ENTITY_MAP[entity]) return HTML_ENTITY_MAP[entity];
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return match;
  }).trim();
}

export function pdgaEventYear(event) {
  const match = String(event && event.date || "").match(/(\d{4})/);
  if (match) return match[1];
  const epoch = Number(event && event.epoch);
  if (Number.isFinite(epoch) && epoch > 0) {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" }).format(new Date(epoch * 1000));
  }
  return "Unknown";
}

export function pdgaCurrentYear(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(now);
}

export function groupPdgaEventsByYear(events) {
  const groups = [];
  const index = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const year = pdgaEventYear(event);
    let group = index.get(year);
    if (!group) {
      group = { year, events: [] };
      index.set(year, group);
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups.sort((a, b) => String(b.year).localeCompare(String(a.year), undefined, { numeric: true }));
}

export function formatPdgaPlace(place, dnf = false) {
  if (dnf) return "DNF";
  const n = Number(place);
  if (!Number.isInteger(n) || n <= 0) return "";
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const rem10 = n % 10;
  return `${n}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

export function formatPdgaToPar(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "E";
  return n > 0 ? `+${Math.round(n)}` : String(Math.round(n));
}

export function pdgaRoundStatChips(stats) {
  if (!stats || typeof stats !== "object") return [];
  const chips = [];
  for (const [key, label] of ROUND_STAT_CHIP_LABELS) {
    const entry = stats[key];
    const opp = Number(entry?.opp);
    const hit = Number(entry?.hit);
    if (!Number.isFinite(opp) || opp <= 0 || !Number.isFinite(hit) || hit < 0) continue;
    chips.push({ id: key, label, text: `${label} ${Math.round((hit / opp) * 100)}%` });
  }
  const obHoles = Number(stats.ob?.holes);
  const obCount = Number(stats.ob?.count);
  if (Number.isFinite(obHoles) && obHoles > 0 && Number.isFinite(obCount) && obCount >= 0) {
    chips.push({ id: "ob", label: "OB", text: `OB ${obCount}` });
  }
  return chips;
}

export function formatPdgaAnnualSummary(row) {
  if (!row || typeof row !== "object") return [];
  const parts = [];
  if (row.events != null) parts.push(`${row.events} ${row.events === 1 ? "event" : "events"}`);
  if (row.rounds != null) parts.push(`${row.rounds} ${row.rounds === 1 ? "round" : "rounds"}`);
  if (row.points != null) parts.push(`${row.points} pts`);
  if (row.prize != null && row.prize > 0) {
    parts.push(`$${Number(row.prize).toLocaleString(undefined, { maximumFractionDigits: 2 })} cash`);
  }
  if (row.playersDefeated != null && row.playersDefeated > 0) {
    parts.push(`${row.playersDefeated} defeated`);
  }
  if (row.wins != null && row.wins > 0) parts.push(`${row.wins} ${row.wins === 1 ? "win" : "wins"}`);
  return parts;
}

function ratingValue(value) {
  return value == null ? "-" : String(value);
}

function eventMeta(event) {
  const place = formatPdgaPlace(event.place, event.dnf);
  const toPar = formatPdgaToPar(event.to_par);
  const totalText = event.total != null ? `${event.total}${toPar ? ` (${toPar})` : ""}` : toPar;
  return [event.date || "", event.division || "", place, totalText].filter(Boolean).join(" · ");
}

function eventRatings(event) {
  const ratings = (event.rounds || []).map((round) => round.rating).filter((value) => value != null);
  return ratings.length ? ratings.join(" - ") : "-";
}

function roundMixText(round) {
  const parts = [];
  if (round.aces > 0) parts.push(`${round.aces} ace${round.aces === 1 ? "" : "s"}`);
  if (round.eagles > 0) parts.push(`${round.eagles} eagle${round.eagles === 1 ? "" : "s"}`);
  if (round.birdies > 0) parts.push(`${round.birdies} birdie${round.birdies === 1 ? "" : "s"}`);
  if (round.pars > 0) parts.push(`${round.pars} par${round.pars === 1 ? "" : "s"}`);
  if (round.bogeys > 0) parts.push(`${round.bogeys} bogey${round.bogeys === 1 ? "" : "s"}`);
  if (round.doubles_plus > 0) parts.push(`${round.doubles_plus} dbl+`);
  return parts.join(" · ");
}

function EventRatingRow({ ratings }) {
  const label = ratings === "-" ? "Rating" : "Round ratings";
  return h("div", { className: "dash-event-rating-row", key: "rating-row" }, [
    h("span", { className: "dash-event-rating-label", key: "label" }, label),
    h("span", {
      "aria-label": ratings === "-" ? "Round ratings unavailable" : `Round ratings: ${ratings}`,
      className: "dash-event-ratings",
      key: "ratings",
    }, ratings),
  ]);
}

function hasPdgaPayload(stats) {
  return Boolean(
    stats
    && (stats.official_rating != null
      || (Array.isArray(stats.annual_stats) && stats.annual_stats.length)
      || (Array.isArray(stats.events) && stats.events.length)
      || (Array.isArray(stats.play_rounds) && stats.play_rounds.length)),
  );
}

/** Policy A hook: loads once from temporary D1 cache on mount and exposes explicit on-demand refresh/reload. */
export function usePdgaStats(pdgaNo) {
  const [state, setState] = React.useState({
    status: pdgaNo ? "loading" : "empty",
    stats: null,
    refreshing: false,
    refreshMessage: "",
  });
  const activeControllerRef = React.useRef(null);

  React.useEffect(() => {
    if (!pdgaNo) {
      setState({ status: "empty", stats: null, refreshing: false, refreshMessage: "" });
      return undefined;
    }

    const key = String(pdgaNo);
    let listeners = pdgaStatsListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      pdgaStatsListeners.set(key, listeners);
    }
    const syncListener = (nextState) => {
      setState(nextState);
    };
    listeners.add(syncListener);

    const controller = new AbortController();
    activeControllerRef.current = controller;
    setState({ status: "loading", stats: null, refreshing: false, refreshMessage: "" });

    void requestJson(`/pdga-stats?pdga=${encodeURIComponent(key)}`, { signal: controller.signal })
      .then((stats) => {
        if (controller.signal.aborted) return;
        setState(hasPdgaPayload(stats)
          ? { status: "ready", stats, refreshing: false, refreshMessage: "" }
          : { status: "missing", stats: null, refreshing: false, refreshMessage: "" });
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setState({ status: "error", stats: null, refreshing: false, refreshMessage: "" });
        }
      });

    return () => {
      controller.abort();
      listeners.delete(syncListener);
      if (!listeners.size) pdgaStatsListeners.delete(key);
    };
  }, [pdgaNo]);

  const fetchLatest = React.useCallback(async (fresh = false) => {
    if (!pdgaNo) return;
    const key = String(pdgaNo);
    const token = fresh ? storageGet(TOKEN_KEY) : null;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setState((current) => ({ ...current, refreshing: true, refreshMessage: "" }));
    try {
      const qs = `/pdga-stats?pdga=${encodeURIComponent(key)}${fresh ? "&fresh=1" : ""}`;
      const stats = await requestJson(qs, { signal: controller.signal, ...(token ? { token } : {}) });
      if (controller.signal.aborted) return;
      const next = hasPdgaPayload(stats)
        ? { status: "ready", stats, refreshing: false, refreshMessage: fresh ? "Updated from PDGA." : "" }
        : { status: "missing", stats: null, refreshing: false, refreshMessage: "" };
      notifyPdgaStatsChanged(key, () => next);
    } catch (error) {
      if (error.name === "AbortError") return;
      const msg = error?.status === 429
        ? "Refreshed recently — try again in a few minutes."
        : "Could not refresh from PDGA right now.";
      setState((current) => ({ ...current, refreshing: false, refreshMessage: msg }));
    }
  }, [pdgaNo]);

  const refresh = React.useCallback(() => fetchLatest(true), [fetchLatest]);
  const reload = React.useCallback(() => fetchLatest(false), [fetchLatest]);

  return { ...state, refresh, reload };
}

function RatingTile({ label, value, delta, live = false }) {
  const props = {
    className: "dash-tile",
  };
  if (live) {
    props["data-react-live-rating"] = "true";
  }
  return h("div", props, [
    h("div", { className: "dash-tile-num", key: "value" }, ratingValue(value)),
    delta ? h("div", { className: "dash-tile-delta", key: "delta" }, delta) : null,
    h("div", { className: "dash-tile-label", key: "label" }, label),
  ]);
}

function RecentEvent({ event }) {
  const ratings = eventRatings(event);
  const title = pdgaEventTitle(event.tournament) || "Event";
  const rounds = Array.isArray(event.rounds) ? event.rounds : [];
  const hasRoundDetails = rounds.some((r) => r.score != null || r.holes > 0 || pdgaRoundStatChips(r.stats).length > 0);
  const eventHref = pdgaEventHref(event.eventId);
  const liveHref = event.live_url || pdgaLiveEventHref(event.eventId, event.division);

  return h("article", { className: "dash-event" }, [
    h("div", { className: "dash-event-main", key: "main" }, [
      h("div", { className: "dash-event-copy", key: "copy" }, [
        h(PdgaLink, { as: "div", className: "dash-event-name", href: eventHref, key: "name" }, title),
        h("div", { className: "dash-event-date", key: "date" }, eventMeta(event)),
      ]),
      h(EventRatingRow, { ratings, key: "rating-row" }),
    ]),
    (hasRoundDetails || eventHref || liveHref) ? h("details", { className: "dash-event-details", key: "details" }, [
      h("summary", { key: "summary" }, "Round details & stats"),
      hasRoundDetails ? h("div", { className: "dash-round-list", key: "rounds" }, rounds.map((round, index) => {
        const toPar = formatPdgaToPar(round.to_par);
        const scoreText = round.score != null
          ? `${round.score}${toPar ? ` (${toPar})` : ""}`
          : toPar || "—";
        const mixText = roundMixText(round);
        const statChips = pdgaRoundStatChips(round.stats);
        return h("div", { className: "dash-round-item", key: round.round || String(index) }, [
          h("div", { className: "dash-round-head", key: "head" }, [
            h("span", { className: "dash-round-label", key: "label" }, [
              `Rd ${round.round || index + 1}`,
              round.date ? ` · ${round.date}` : "",
            ].join("")),
            h("span", { className: "dash-round-score-wrap", key: "score" }, [
              h("strong", { className: "dash-round-score", key: "total" }, scoreText),
              round.rating != null ? h("span", { className: "round-rating", key: "rating" }, String(round.rating)) : null,
            ]),
          ]),
          mixText ? h("p", { className: "dash-round-mix", key: "mix" }, mixText) : null,
          statChips.length ? h("div", { className: "dash-round-chips", key: "chips" }, statChips.map((chip) =>
            h("span", { className: "dash-round-chip", key: chip.id }, chip.text),
          )) : null,
        ].filter(Boolean));
      })) : null,
      (eventHref || liveHref) ? h("div", { className: "dash-event-links", key: "links" }, [
        eventHref ? h("a", {
          className: "pdga-link pdga-profile-link",
          href: eventHref,
          key: "event",
          rel: "noopener noreferrer",
          target: "_blank",
        }, "PDGA event page") : null,
        liveHref ? h("a", {
          className: "pdga-link pdga-profile-link",
          href: liveHref,
          key: "live",
          rel: "noopener noreferrer",
          target: "_blank",
        }, "PDGA Live scorecard") : null,
      ].filter(Boolean)) : null,
    ].filter(Boolean)) : null,
  ]);
}

function eventCard(event, index) {
  return h(RecentEvent, { event, key: event.eventId || `${event.tournament || "event"}-${event.epoch || index}` });
}

export function PdgaAnnualStats({ pdgaNo, rows, compact = false }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const shown = compact ? list.slice(0, 2) : list;
  return h("section", {
    className: compact ? "pdga-annual-section compact" : "pdga-annual-section",
    "data-pdga-annual-stats": compact ? "compact" : "ready",
    "aria-label": "PDGA season totals",
  }, [
    compact ? null : h("h4", { className: "dash-subtitle", key: "title" }, "PDGA season totals"),
    h("div", { className: "pdga-annual-list", key: "list" }, shown.map((row) => {
      const key = `${row.year}-${row.divisionCode}`;
      const summary = formatPdgaAnnualSummary(row).join(" · ");
      const yearHref = row.url || pdgaPlayerStatsHref(pdgaNo, row.year);
      return h("article", { className: "pdga-annual-row", "data-pdga-annual-row": key, key }, [
        h("div", { className: "pdga-annual-head", key: "head" }, [
          h("strong", { key: "title" }, `${row.year} · ${row.divisionCode}`),
          row.rating != null ? h("span", { className: "round-rating", key: "rating" }, String(row.rating)) : null,
        ]),
        summary ? h("p", { className: "pdga-annual-meta", key: "summary" }, summary) : null,
        yearHref ? h("a", {
          className: "pdga-link pdga-profile-link",
          href: yearHref,
          key: "link",
          rel: "noopener noreferrer",
          target: "_blank",
        }, `View ${row.year} on PDGA.com`) : null,
      ].filter(Boolean));
    })),
  ].filter(Boolean));
}

const PDGA_SCAN_STATES = [
  { code: "ALL", label: "NC / VA / SC" },
  { code: "NC", label: "NC" },
  { code: "VA", label: "VA" },
  { code: "SC", label: "SC" },
];

export function PdgaEventFinder({ pdgaNo, token, onLinked, compact = false }) {
  const [value, setValue] = React.useState("");
  const [stateCode, setStateCode] = React.useState("ALL");
  const [busyMode, setBusyMode] = React.useState("");
  const [linkingId, setLinkingId] = React.useState(null);
  const [status, setStatus] = React.useState("");
  const [results, setResults] = React.useState([]);
  const [scanRemaining, setScanRemaining] = React.useState(0);
  if (!pdgaNo || !token) return null;

  const busy = Boolean(busyMode || linkingId);

  async function linkEventInput(raw, targetId = null) {
    if (targetId != null) setLinkingId(targetId);
    else setBusyMode("link");
    setStatus("");
    try {
      const res = await requestJson("/pdga/link-event", {
        method: "POST",
        token,
        body: { event: raw },
      });
      const linkedName = res?.linked?.name || "event";
      const divNote = res?.linked?.division ? ` (${res.linked.division})` : "";
      setStatus(`Added ${linkedName}${divNote}.`);
      if (targetId != null) {
        setResults((current) => current.map((item) => (item.eventId === targetId ? { ...item, linked: true } : item)));
      } else {
        setValue("");
      }
      if (onLinked) void onLinked();
    } catch (error) {
      if (error?.status === 404 && error?.data?.error === "player_not_in_event") {
        setStatus(`PDGA #${pdgaNo} wasn't found on that event's PDGA Live roster.`);
      } else if (error?.status === 404) {
        setStatus("Event wasn't found on PDGA Live.");
      } else if (error?.status === 400) {
        setStatus("Enter a PDGA event # (e.g. 107755) or pdga.com event URL.");
      } else if (error?.status === 429) {
        setStatus("Too many lookups — try again later.");
      } else {
        setStatus("Could not load that event right now.");
      }
    } finally {
      setLinkingId(null);
      setBusyMode("");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const raw = value.trim();
    if (busy || (!raw && stateCode === "ALL")) return;
    if (/^#?[1-9]\d{0,7}$/.test(raw) || /pdga\.com\/(?:tour|live)\/event\/[1-9]\d{0,7}/i.test(raw)) {
      await linkEventInput(raw);
      return;
    }
    setBusyMode("search");
    setStatus("");
    try {
      const params = new URLSearchParams();
      if (raw) params.set("q", raw);
      if (stateCode && stateCode !== "ALL") params.set("state", stateCode);
      params.set("live", "1");
      const res = await requestJson(`/pdga/events/search?${params.toString()}`, { token });
      const list = Array.isArray(res?.events) ? res.events : [];
      setResults(list);
      setStatus(list.length ? `Found ${list.length} matching PDGA ${list.length === 1 ? "event" : "events"}.` : "No matching PDGA events found. Try another name, state, or event #.");
    } catch (error) {
      setStatus(error?.status === 429 ? "Too many searches — try again in a few minutes." : "Could not search PDGA events right now.");
    } finally {
      setBusyMode("");
    }
  }

  async function runScan() {
    if (busy) return;
    setBusyMode("scan");
    setStatus("");
    try {
      const res = await requestJson("/pdga/scan-my-events", {
        method: "POST",
        token,
        body: { state: stateCode },
      });
      const matched = Number(res?.matched) || 0;
      const scanned = Number(res?.scanned) || 0;
      const remaining = Math.max(0, Number(res?.remaining) || 0);
      setScanRemaining(remaining);
      if (matched > 0) {
        setStatus(`Checked ${scanned} ${scanned === 1 ? "event" : "events"} — linked ${matched} ${matched === 1 ? "tournament" : "tournaments"}.`);
        if (onLinked) void onLinked();
      } else if (scanned > 0) {
        setStatus(`Checked ${scanned} recent ${scanned === 1 ? "event" : "events"} — no new matches.${remaining > 0 ? ` ${remaining} more left to check.` : ""}`);
      } else {
        setStatus("All recent cached regional events were already checked.");
      }
    } catch (error) {
      if (error?.status === 429) {
        setStatus("Scanned recently — try again in a few minutes.");
      } else {
        setStatus("Could not scan PDGA Live rosters right now.");
      }
    } finally {
      setBusyMode("");
    }
  }

  const regionLabel = stateCode === "ALL" ? "NC/VA/SC" : stateCode;
  const scanLabel = busyMode === "scan"
    ? "Scanning…"
    : scanRemaining > 0
      ? `Scan more (${scanRemaining} left)`
      : `Scan recent ${regionLabel}`;
  const historyHref = pdgaPlayerHistoryHref(pdgaNo);

  return h("div", { className: compact ? "pdga-finder compact" : "pdga-finder", "data-pdga-finder": "ready" }, [
    h("div", { className: "pdga-finder-scan", key: "scan-row" }, [
      h("select", {
        "aria-label": "PDGA region",
        className: "form-input pdga-finder-state",
        disabled: busy,
        key: "state",
        value: stateCode,
        onChange: (event) => {
          setStateCode(event.target.value);
          setScanRemaining(0);
        },
      }, PDGA_SCAN_STATES.map((opt) => h("option", { key: opt.code, value: opt.code }, opt.label))),
      h("button", {
        type: "button",
        className: "dashboard-action pdga-finder-scan-btn",
        "data-pdga-scan": "true",
        disabled: busy,
        key: "scan",
        onClick: () => { void runScan(); },
      }, scanLabel),
    ]),
    h("form", { className: "pdga-link-form", "data-pdga-link-form": "ready", key: "form", onSubmit: submit }, [
      h("div", { className: "pdga-link-row", key: "row" }, [
        h("input", {
          type: "text",
          className: "form-input pdga-link-input",
          value,
          disabled: busy,
          maxLength: 160,
          placeholder: "Event name, PDGA #, or pdga.com URL",
          "aria-label": "Search PDGA event or enter event ID",
          key: "input",
          onChange: (event) => setValue(event.target.value),
        }),
        h("button", {
          type: "submit",
          className: "dashboard-action",
          disabled: busy || (!value.trim() && stateCode === "ALL"),
          key: "submit",
        }, busyMode === "search" ? "Searching…" : busyMode === "link" ? "Adding…" : "Find / Add"),
      ]),
    ]),
    status ? h("p", { className: "pdga-source-note", role: "status", key: "status" }, status) : null,
    results.length ? h("div", { className: "pdga-finder-results", key: "results" }, results.map((item) =>
      h("div", { className: "pdga-finder-row", key: item.eventId }, [
        h("div", { className: "pdga-finder-copy", key: "copy" }, [
          h(PdgaLink, { as: "div", className: "pdga-finder-name", href: item.url, key: "name" }, pdgaEventTitle(item.name) || `PDGA Event #${item.eventId}`),
          h("div", { className: "player-card-meta", key: "meta" }, [item.startDate, item.tier, item.location].filter(Boolean).join(" · ")),
        ]),
        h("button", {
          type: "button",
          className: "pdga-finder-load-btn",
          disabled: busy || item.linked,
          key: "load",
          onClick: () => { void linkEventInput(String(item.eventId), item.eventId); },
        }, linkingId === item.eventId ? "Checking…" : item.linked ? "Linked" : "Load rounds"),
      ]),
    )) : null,
    historyHref ? h("p", { className: "pdga-finder-help", key: "help" }, h("a", {
      className: "pdga-link",
      href: historyHref,
      rel: "noopener noreferrer",
      target: "_blank",
    }, "Find your event #s on PDGA.com")) : null,
  ].filter(Boolean));
}

export function PdgaEventLinkForm(props) {
  return h(PdgaEventFinder, props);
}

function TournamentList({ events }) {
  const groups = groupPdgaEventsByYear(events);
  const currentYear = pdgaCurrentYear();
  const list = groups.length <= 1
    ? groups.flatMap((group) => group.events.map(eventCard))
    : groups.map((group) => h("details", {
      className: "dash-event-year",
      key: group.year,
      open: group.year === currentYear || undefined,
    }, [
      h("summary", { className: "dash-event-year-summary", key: "summary" }, `${group.year} (${group.events.length})`),
      h("div", { className: "dash-event-year-list", key: "list" }, group.events.map(eventCard)),
    ]));

  return h("details", { className: "dash-collapse", key: "events" }, [
    h("summary", { className: "dash-subtitle dash-collapse-summary", key: "title" }, `Tournaments (${events.length})`),
    h("div", { key: "list" }, list),
  ]);
}

export function PdgaDashboard({ pdgaNo, state, children, compact = false }) {
  const status = state.status;
  const stats = state.stats;
  const token = storageGet(TOKEN_KEY);
  const extras = children ? [children] : [];

  if (!pdgaNo) {
    return dashboardShell("empty", [
      h("div", { className: "react-pdga-status", key: "status" }, "No PDGA # is linked to your account yet. PDGA ratings and tournament history will appear here once it is."),
      ...extras,
    ]);
  }

  if (status === "loading") {
    return dashboardShell("loading", [
      h("div", { className: "react-pdga-status", key: "status" }, "Loading your stats…"),
      ...extras,
    ]);
  }

  if (status === "missing") {
    return dashboardShell("missing", [
      h("div", { className: "react-pdga-status", key: "status" }, `PDGA did not return a rating for #${pdgaNo}. Refresh in a few minutes.`),
      token && state.refresh ? h("div", { className: "pdga-profile-links", key: "actions" }, [
        h("button", {
          type: "button",
          className: "pdga-refresh-btn",
          "data-pdga-refresh": "true",
          disabled: state.refreshing,
          key: "refresh",
          onClick: () => { void state.refresh(); },
        }, state.refreshing ? "Refreshing…" : "Refresh PDGA stats"),
      ]) : null,
      state.refreshMessage ? h("p", { className: "pdga-source-note", role: "status", key: "refresh-msg" }, state.refreshMessage) : null,
      ...extras,
    ].filter(Boolean));
  }

  if (status === "error") {
    return dashboardShell("error", [
      h("div", { className: "react-pdga-status error", key: "status" }, "Could not load PDGA stats. Please refresh and try again."),
      token && state.refresh ? h("div", { className: "pdga-profile-links", key: "actions" }, [
        h("button", {
          type: "button",
          className: "pdga-refresh-btn",
          "data-pdga-refresh": "true",
          disabled: state.refreshing,
          key: "refresh",
          onClick: () => { void state.refresh(); },
        }, state.refreshing ? "Refreshing…" : "Try again"),
      ]) : null,
      ...extras,
    ].filter(Boolean));
  }

  const events = Array.isArray(stats?.events) ? stats.events : [];
  const annualStats = Array.isArray(stats?.annual_stats) ? stats.annual_stats : [];
  const live = stats?.live_rating;
  const official = stats?.official_rating;
  const delta = live != null && official != null
    ? `${live - official >= 0 ? "+" : ""}${live - official} vs official`
    : "";

  const history = events.length
    ? h(TournamentList, { events, key: "events" })
    : official != null && !compact
      ? h("p", { className: "pdga-source-note", key: "empty-history" }, [
        "No recent regional PDGA Live rounds matched automatically yet. Load a tournament below or view all sanctioned finishes on ",
        h("a", {
          className: "pdga-link",
          href: pdgaPlayerHistoryHref(pdgaNo),
          key: "history-link",
          rel: "noopener noreferrer",
          target: "_blank",
        }, "PDGA.com"),
        ".",
      ])
      : null;

  if (compact) {
    return dashboardShell("ready", [
      ...extras,
      history,
    ]);
  }

  const currentYear = pdgaCurrentYear();
  const profileHref = pdgaPlayerHref(pdgaNo);
  const historyHref = pdgaPlayerHistoryHref(pdgaNo);
  const statsYearHref = pdgaPlayerStatsHref(pdgaNo, currentYear);

  return dashboardShell("ready", [
    h("div", { className: "react-pdga-meta pdga-profile-links", key: "meta" }, [
      h(PdgaLink, { href: profileHref, key: "num" }, `PDGA #${pdgaNo}`),
      profileHref ? h("a", {
        className: "pdga-link pdga-profile-link",
        href: profileHref,
        key: "profile",
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Official PDGA profile") : null,
      historyHref ? h("a", {
        className: "pdga-link pdga-profile-link",
        href: historyHref,
        key: "history",
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Full ratings history") : null,
      statsYearHref ? h("a", {
        className: "pdga-link pdga-profile-link",
        href: statsYearHref,
        key: "year-stats",
        rel: "noopener noreferrer",
        target: "_blank",
      }, `${currentYear} stats on PDGA.com`) : null,
      token && state.refresh ? h("button", {
        type: "button",
        className: "pdga-refresh-btn",
        "data-pdga-refresh": "true",
        disabled: state.refreshing,
        key: "refresh",
        onClick: () => { void state.refresh(); },
      }, state.refreshing ? "Refreshing…" : "Refresh PDGA stats") : null,
    ].filter(Boolean)),
    state.refreshMessage ? h("p", { className: "pdga-source-note", role: "status", key: "refresh-msg" }, state.refreshMessage) : null,
    h("p", { className: "pdga-source-note", key: "source" },
      "Official ratings and season totals come from PDGA's API; recent round breakdowns come from PDGA Live. Club rounds and UDisc imports stay separate above."),
    h("div", { className: "dash-rating-row", key: "ratings" }, [
      h(RatingTile, { label: "Live rating estimate", value: live, delta, live: true, key: "live" }),
      h(RatingTile, { label: "PDGA official rating", value: official, delta: stats?.rating_date ? `As of ${stats.rating_date}` : "", key: "official" }),
      // The highest single round rating among recent PDGA Live rounds (not a peak official rating).
      h(RatingTile, { label: "Best round rating", value: stats?.peak_rating, key: "peak" }),
      h(RatingTile, { label: "Events", value: stats?.events_count != null ? stats.events_count : events.length, key: "events" }),
    ]),
    h(PdgaAnnualStats, { pdgaNo, rows: annualStats, key: "annual" }),
    h(PdgaEventLinkForm, { pdgaNo, token, onLinked: state.reload, key: "link-event" }),
    ...extras,
    history,
  ].filter(Boolean));
}

function dashboardShell(status, children) {
  return h("div", {
    className: "react-pdga-dashboard",
    id: "membersReactRatingPanel",
    "data-react-pdga-dashboard": status,
  }, children);
}
