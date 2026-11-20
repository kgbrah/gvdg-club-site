import React from "react";

import { requestJson } from "./api.js";
import { PdgaLink, pdgaPlayerHref } from "../shared/pdga-credit.js";

const h = React.createElement;
const PDGA_REFRESH_MS = 15 * 60 * 1000;

function ratingValue(value) {
  return value == null ? "-" : String(value);
}

export function usePdgaStats(pdgaNo) {
  const [state, setState] = React.useState({ status: pdgaNo ? "loading" : "empty", stats: null });

  React.useEffect(() => {
    if (!pdgaNo) {
      setState({ status: "empty", stats: null });
      return undefined;
    }

    const controller = new AbortController();
    let lastRequestedAt = 0;
    const load = (showLoading = false) => {
      lastRequestedAt = Date.now();
      if (showLoading) setState({ status: "loading", stats: null });
      void requestJson(`/pdga-stats?pdga=${encodeURIComponent(pdgaNo)}`, { signal: controller.signal })
        .then((stats) => {
          if (!stats || stats.official_rating == null) {
            setState({ status: "missing", stats: null });
            return;
          }
          setState({ status: "ready", stats });
        })
        .catch((error) => {
          if (error.name !== "AbortError") {
            lastRequestedAt = 0;
            setState({ status: "error", stats: null });
          }
        });
    };
    const refreshIfStale = () => {
      if (Date.now() - lastRequestedAt >= PDGA_REFRESH_MS) load();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };

    load(true);
    const refreshTimer = window.setInterval(refreshIfStale, PDGA_REFRESH_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [pdgaNo]);

  return state;
}

function RatingTile({ label, value, delta }) {
  return h("div", { className: "dash-tile" }, [
    h("div", { className: "dash-tile-num", key: "value" }, ratingValue(value)),
    delta ? h("div", { className: "dash-tile-delta", key: "delta" }, delta) : null,
    h("div", { className: "dash-tile-label", key: "label" }, label),
  ]);
}

export function PdgaDashboard({ pdgaNo, state, children, compact = false }) {
  const status = state.status;
  const stats = state.stats;
  const extras = children ? [children] : [];

  if (!pdgaNo) {
    return dashboardShell("empty", [
      h("div", { className: "react-pdga-status", key: "status" }, "No PDGA # is linked to your account yet. Your PDGA official rating will appear here once it is."),
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
      ...extras,
    ]);
  }

  if (status === "error") {
    return dashboardShell("error", [
      h("div", { className: "react-pdga-status error", key: "status" }, "Could not load PDGA stats. Please refresh and try again."),
      ...extras,
    ]);
  }

  // Only PDGA's official rating, from PDGA's API (PDGA's terms: no round-by-round ratings or event history kept here).
  const official = stats?.official_rating;

  if (compact) return dashboardShell("ready", extras);

  return dashboardShell("ready", [
    h("div", { className: "react-pdga-meta", key: "meta" }, h(PdgaLink, { href: pdgaPlayerHref(pdgaNo) }, `PDGA #${pdgaNo}`)),
    h("div", { className: "dash-rating-row", key: "ratings" }, [
      h(RatingTile, { label: "PDGA official rating", value: official, delta: stats?.rating_date ? `As of ${stats.rating_date}` : "", key: "official" }),
    ]),
    ...extras,
  ]);
}

function dashboardShell(status, children) {
  return h("div", {
    className: "react-pdga-dashboard",
    id: "membersReactRatingPanel",
    "data-react-pdga-dashboard": status,
  }, children);
}
