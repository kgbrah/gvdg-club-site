import React from "react";
import { CalendarDays, ChevronDown, ChevronUp, ExternalLink, Info } from "lucide-react";

const h = React.createElement;
const PREVIOUS_RESULTS_EVENT = "gvdg:events-previous-results";
const PREVIOUS_RESULTS_INITIAL = 3;
const PREVIOUS_RESULTS_PAGE_SIZE = 12;

function icon(Icon, size = 16) {
  return h(Icon, {
    "aria-hidden": "true",
    focusable: "false",
    size,
    strokeWidth: 2.4,
  });
}

function publishedResults() {
  const results = window.__gvdgEventsPreviousResults;
  return Array.isArray(results) ? results : [];
}

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

function resultKey(item, index) {
  return [
    item && item.href,
    item && item.name,
    item && item.dateText,
    String(index),
  ].filter(Boolean).join("|");
}

function Badge({ className = "", text }) {
  return h("span", {
    className: `badge ${className}`.trim(),
  }, text || "Result");
}

function MetaRow({ children, iconNode }) {
  return h("div", { className: "meta-row" }, [
    h("span", { className: "meta-icon", key: "icon" }, iconNode),
    h("span", { key: "text" }, children),
  ]);
}

function PreviousResultCard({ item }) {
  const href = safeHref(item && item.href);
  const external = !!(item && item.external && href && !href.startsWith("#"));
  const tag = href ? "a" : "div";
  const typeClass = cleanClassName(item && item.typeClass);
  const statusClass = cleanClassName(item && item.status);

  const props = {
    className: "event-card",
  };
  if (href) props.href = href;
  if (external) {
    props.target = "_blank";
    props.rel = "noopener noreferrer";
  }

  return h(tag, props, [
    h("div", { className: "event-card-top", key: "top" }, [
      h("h3", { className: "event-name", key: "name" }, item && item.name ? String(item.name) : "Previous result"),
      h(Badge, {
        className: `type-badge ${typeClass}`,
        key: "badge",
        text: item && item.label ? String(item.label) : "Result",
      }),
    ]),
    h("div", { className: "event-meta", key: "meta" }, [
      h(MetaRow, { iconNode: icon(CalendarDays), key: "date" }, item && item.dateText ? String(item.dateText) : "Date TBD"),
      item && item.detail
        ? h(MetaRow, { iconNode: icon(Info), key: "detail" }, String(item.detail))
        : null,
    ]),
    item && item.status
      ? h("div", { className: "event-card-top", key: "status" }, h(Badge, {
        className: `status-badge ${statusClass}`,
        text: String(item.statusLabel || item.status),
      }))
      : null,
    item && item.cta
      ? h("div", { className: "event-cta", key: "cta" }, [
        String(item.cta),
        external ? h("span", { className: "event-cta-icon", key: "icon" }, icon(ExternalLink, 14)) : null,
      ])
      : null,
  ]);
}

export function EventsPreviousResultsApp() {
  const [results, setResults] = React.useState(publishedResults);
  const [expanded, setExpanded] = React.useState(false);
  const [visible, setVisible] = React.useState(PREVIOUS_RESULTS_INITIAL);

  React.useEffect(() => {
    function update(event) {
      const next = Array.isArray(event.detail && event.detail.results) ? event.detail.results : publishedResults();
      setResults(next);
      setVisible((current) => Math.min(Math.max(current, PREVIOUS_RESULTS_INITIAL), Math.max(next.length, PREVIOUS_RESULTS_INITIAL)));
      if (!next.length) setExpanded(false);
    }
    window.addEventListener(PREVIOUS_RESULTS_EVENT, update);
    update({ detail: { results: publishedResults() } });
    return () => window.removeEventListener(PREVIOUS_RESULTS_EVENT, update);
  }, []);

  React.useEffect(() => {
    setVisible((current) => Math.min(Math.max(current, PREVIOUS_RESULTS_INITIAL), Math.max(results.length, PREVIOUS_RESULTS_INITIAL)));
    if (!results.length) setExpanded(false);
  }, [results.length]);

  if (!results.length) return null;

  const shownCount = Math.min(visible, results.length);
  const Indicator = expanded ? ChevronUp : ChevronDown;

  return h("section", { className: "previous-results-panel", "data-react-events-previous-results": "true" }, [
    h("button", {
      "aria-controls": "previousResultsBody",
      "aria-expanded": expanded ? "true" : "false",
      className: "previous-results-toggle",
      key: "toggle",
      onClick: () => setExpanded((current) => !current),
      type: "button",
    }, [
      h("span", { className: "previous-results-title", key: "title" }, [
        h("strong", { key: "strong" }, expanded ? "Hide previous results" : "See previous results"),
        h("span", { key: "count" }, `${results.length} previous result${results.length === 1 ? "" : "s"} available`),
      ]),
      h("span", { className: "previous-results-indicator", key: "indicator" }, icon(Indicator, 22)),
    ]),
    h("div", {
      className: "previous-results-body",
      hidden: !expanded,
      id: "previousResultsBody",
      key: "body",
    }, expanded ? [
      h("div", { className: "events-grid", key: "grid" }, results.slice(0, shownCount).map((item, index) =>
        h(PreviousResultCard, { item, key: resultKey(item, index) }))),
      h("div", { className: "previous-results-actions", key: "actions" }, [
        h("div", { className: "previous-results-status", key: "status" }, `Showing ${shownCount} of ${results.length}`),
        shownCount < results.length
          ? h("button", {
            className: "previous-results-btn",
            key: "more",
            onClick: () => setVisible((current) => Math.min(results.length, current + PREVIOUS_RESULTS_PAGE_SIZE)),
            type: "button",
          }, "Load more")
          : null,
        shownCount > PREVIOUS_RESULTS_INITIAL
          ? h("button", {
            className: "previous-results-btn secondary",
            key: "less",
            onClick: () => setVisible(PREVIOUS_RESULTS_INITIAL),
            type: "button",
          }, "Show less")
          : null,
      ]),
    ] : null),
  ]);
}
