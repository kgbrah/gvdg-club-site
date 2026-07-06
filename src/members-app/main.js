import React from "react";
import { createRoot } from "react-dom/client";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;
const TOKEN_KEY = "gvdg_member_token";
const NAME_KEY = "gvdg_member_name";
const PDGA_KEY = "gvdg_member_pdga";

const TABS = [
  { key: "overview", label: "Overview", title: "Player Dashboard" },
  { key: "events", label: "Events", title: "Event Registration" },
  { key: "board", label: "Board", title: "Member Board" },
  { key: "tee", label: "Tee Signs", title: "Tee Sign Capture" },
  { key: "club", label: "Club", title: "GVDG Member Directory" },
];

const DEFAULT_TAB = TABS[0];
const tabKeys = new Set(TABS.map((tab) => tab.key));

function storageGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeTab(value) {
  return tabKeys.has(value) ? value : DEFAULT_TAB.key;
}

function tabTitle(key) {
  return TABS.find((tab) => tab.key === key)?.title || DEFAULT_TAB.title;
}

function tabFromLegacyDom() {
  const active = document.querySelector("#dashTabs .dash-tab.active");
  return safeTab(active?.getAttribute("data-dtab") || DEFAULT_TAB.key);
}

function initialState() {
  const tab = tabFromLegacyDom();
  const title = document.getElementById("memberSectionTitle")?.textContent?.trim() || tabTitle(tab);
  return { tab, title };
}

function authBase() {
  const host = window.location.hostname;
  const localAuthBase = ["127.0.0.1", "localhost"].includes(host) ? "http://127.0.0.1:8788" : "";
  const configured = document.getElementById("loginGate")?.dataset.authBase?.trim() || "";
  const fallback = host === "greenvillediscgolf.com" || host === "www.greenvillediscgolf.com"
    ? "https://auth.greenvillediscgolf.com"
    : "https://auth.gvdgclub.com";
  return (localAuthBase || configured || fallback).replace(/\/+$/, "");
}

function readMemberContext(detail = null) {
  const stored = window.GVDG_MEMBER_DASHBOARD_CONTEXT || {};
  const source = detail || stored;
  return {
    name: source.name || stored.name || storageGet(NAME_KEY) || null,
    pdgaNo: source.pdgaNo || stored.pdgaNo || storageGet(PDGA_KEY) || null,
    photo: source.photo || stored.photo || null,
    isAdmin: source.isAdmin === true || stored.isAdmin === true,
  };
}

function ratingValue(value) {
  return value == null ? "—" : String(value);
}

function eventMeta(event) {
  return [event.date || "", event.division || ""].filter(Boolean).join(" · ");
}

function eventRatings(event) {
  const ratings = (event.rounds || []).map((round) => round.rating).filter((value) => value != null);
  return ratings.length ? ratings.join(" · ") : "—";
}

async function requestJson(path, { signal, token = null } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${authBase()}${path}`, {
    cache: "no-store",
    headers,
    signal,
  });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json();
}

function selectTab(tab) {
  window.dispatchEvent(new CustomEvent("gvdg:select-dashboard-tab", { detail: { tab } }));
}

function MemberDashboardShell() {
  const [state, setState] = React.useState(initialState);

  React.useEffect(() => {
    function update(event) {
      const nextTab = safeTab(event.detail?.tab || tabFromLegacyDom());
      setState({
        tab: nextTab,
        title: event.detail?.title || tabTitle(nextTab),
      });
    }

    window.addEventListener("gvdg:dashboard-tab-selected", update);
    window.addEventListener("gvdg:member-dashboard-ready", update);
    return () => {
      window.removeEventListener("gvdg:dashboard-tab-selected", update);
      window.removeEventListener("gvdg:member-dashboard-ready", update);
    };
  }, []);

  return h(React.Fragment, null, [
    h("h2", { className: "section-title", id: "membersReactDashboardTitle", key: "title" }, state.title),
    h(
      "div",
      {
        className: "dash-tabs members-react-tabs",
        role: "tablist",
        "aria-label": "Member dashboard sections",
        key: "tabs",
      },
      TABS.map((tab) => {
        const active = state.tab === tab.key;
        return h(
          "button",
          {
            className: `dash-tab${active ? " active" : ""}`,
            type: "button",
            role: "tab",
            "aria-selected": active ? "true" : "false",
            "data-dtab": tab.key,
            key: tab.key,
            onClick: () => selectTab(tab.key),
          },
          tab.label,
        );
      }),
    ),
  ]);
}

function useMemberContext() {
  const [context, setContext] = React.useState(() => readMemberContext());

  React.useEffect(() => {
    function update(event) {
      setContext(readMemberContext(event.detail || null));
    }

    window.addEventListener("gvdg:member-profile-updated", update);
    window.addEventListener("gvdg:member-dashboard-ready", update);
    return () => {
      window.removeEventListener("gvdg:member-profile-updated", update);
      window.removeEventListener("gvdg:member-dashboard-ready", update);
    };
  }, []);

  React.useEffect(() => {
    const token = storageGet(TOKEN_KEY);
    if (!token || context.pdgaNo) return undefined;

    const controller = new AbortController();
    requestJson("/me", { signal: controller.signal, token })
      .then((profile) => {
        if (!profile || typeof profile !== "object") return;
        window.GVDG_MEMBER_DASHBOARD_CONTEXT = {
          name: profile.name || storageGet(NAME_KEY) || null,
          pdgaNo: profile.pdgaNo || storageGet(PDGA_KEY) || null,
          photo: profile.photo || null,
          isAdmin: profile.isAdmin === true,
        };
        setContext(readMemberContext(window.GVDG_MEMBER_DASHBOARD_CONTEXT));
      })
      .catch((error) => {
        if (error.name !== "AbortError") setContext(readMemberContext());
      });

    return () => controller.abort();
  }, [context.pdgaNo]);

  return context;
}

function usePdgaStats(pdgaNo) {
  const [state, setState] = React.useState({ status: pdgaNo ? "loading" : "empty", stats: null });

  React.useEffect(() => {
    if (!pdgaNo) {
      setState({ status: "empty", stats: null });
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: "loading", stats: null });
    requestJson(`/pdga-stats?pdga=${encodeURIComponent(pdgaNo)}`, { signal: controller.signal })
      .then((stats) => {
        if (!stats || (stats.official_rating == null && !(Array.isArray(stats.events) && stats.events.length))) {
          setState({ status: "missing", stats: null });
          return;
        }
        setState({ status: "ready", stats });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "error", stats: null });
      });

    return () => controller.abort();
  }, [pdgaNo]);

  return state;
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
  return h("div", { className: "dash-event" }, [
    h("div", { key: "main" }, [
      h("div", { className: "dash-event-name", key: "name" }, event.tournament || "Event"),
      h("div", { className: "dash-event-date", key: "date" }, eventMeta(event)),
    ]),
    h("div", { className: "dash-event-ratings", key: "ratings" }, eventRatings(event)),
  ]);
}

function ReactPdgaDashboard() {
  const context = useMemberContext();
  const { status, stats } = usePdgaStats(context.pdgaNo);

  if (!storageGet(TOKEN_KEY)) return null;

  if (!context.pdgaNo) {
    return h(
      "div",
      { className: "react-pdga-dashboard", "data-react-pdga-dashboard": "empty" },
      h("div", { className: "react-pdga-status" }, "No PDGA # is linked to your account yet. PDGA ratings and tournament history will appear here once it is."),
    );
  }

  if (status === "loading") {
    return h(
      "div",
      { className: "react-pdga-dashboard", "data-react-pdga-dashboard": "loading" },
      h("div", { className: "react-pdga-status" }, "Loading your stats..."),
    );
  }

  if (status === "missing") {
    return h(
      "div",
      { className: "react-pdga-dashboard", "data-react-pdga-dashboard": "missing" },
      h("div", { className: "react-pdga-status" }, `We couldn't find live data for PDGA #${context.pdgaNo} yet. Check back after the next sync.`),
    );
  }

  if (status === "error") {
    return h(
      "div",
      { className: "react-pdga-dashboard", "data-react-pdga-dashboard": "error" },
      h("div", { className: "react-pdga-status error" }, "Could not load PDGA stats. Please refresh and try again."),
    );
  }

  const events = Array.isArray(stats?.events) ? stats.events : [];
  const live = stats?.live_rating;
  const official = stats?.official_rating;
  const delta = live != null && official != null
    ? `${live - official >= 0 ? "+" : ""}${live - official} vs official`
    : "";

  return h("div", { className: "react-pdga-dashboard", "data-react-pdga-dashboard": "ready" }, [
    h("div", { className: "react-pdga-meta", key: "meta" }, `PDGA #${context.pdgaNo}`),
    h("div", { className: "dash-rating-row", key: "ratings" }, [
      h(RatingTile, { label: "Live Rating", value: live, delta, live: true, key: "live" }),
      h(RatingTile, { label: "Official", value: official, key: "official" }),
      h(RatingTile, { label: "Peak", value: stats?.peak_rating, key: "peak" }),
      h(RatingTile, { label: "Events", value: stats?.events_count != null ? stats.events_count : events.length, key: "events" }),
    ]),
    events.length ? h("div", { key: "events" }, [
      h("h4", { className: "dash-subtitle", key: "title" }, "Recent Tournaments"),
      h("div", { key: "list" }, events.slice(0, 6).map((event, index) => h(RecentEvent, { event, key: `${event.tournament || "event"}-${event.epoch || index}` }))),
    ]) : null,
  ]);
}

const mount = document.getElementById("membersReactDashboardShell");
if (mount) {
  createRoot(mount).render(h(MemberDashboardShell));
  document.getElementById("members")?.classList.add("members-react-shell-ready");
}

const ratingMount = document.getElementById("membersReactRatingPanel");
if (ratingMount) {
  createRoot(ratingMount).render(h(ReactPdgaDashboard));
  document.getElementById("members")?.classList.add("members-react-ratings-ready");
}
