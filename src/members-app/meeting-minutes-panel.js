import React from "react";
import { ChevronDown, Download } from "lucide-react";

const h = React.createElement;

function text(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function cleanTitle(value) {
  return String(value || "").replace(/^[^A-Za-z0-9]+/, "").trim();
}

function readItems(section) {
  return [...section.querySelectorAll("li")].map(text).filter(Boolean);
}

function readMinutesFromLegacyDom() {
  const root = document.getElementById("legacyMeetingMinutesPanel");
  if (!root) return [];
  return [...root.querySelectorAll(".meeting-minutes-item")].map((item, index) => {
    const sections = [...item.querySelectorAll(".meeting-minutes-section, .meeting-minutes-action-items")]
      .map((section) => ({
        title: cleanTitle(text(section.querySelector(".meeting-minutes-section-title"))),
        items: readItems(section),
        action: section.classList.contains("meeting-minutes-action-items"),
      }))
      .filter((section) => section.title && section.items.length);
    const download = item.querySelector(".meeting-minutes-download");
    return {
      id: `meeting-minutes-${index}`,
      date: text(item.querySelector(".meeting-minutes-date")),
      badge: text(item.querySelector(".meeting-minutes-badge")),
      sections,
      downloadHref: download?.getAttribute("href") || "",
    };
  }).filter((entry) => entry.date && entry.sections.length);
}

function MinutesSection({ section }) {
  return h("div", { className: section.action ? "meeting-minutes-action-items" : "meeting-minutes-section" }, [
    h("div", { className: "meeting-minutes-section-title", key: "title" }, section.title),
    h("ul", { key: "items" }, section.items.map((item) => h("li", { key: item }, item))),
  ]);
}

function MinutesItem({ minutes, expanded, onToggle }) {
  return h("article", { className: `meeting-minutes-item${expanded ? " expanded" : ""}` }, [
    h("button", {
      type: "button",
      className: "meeting-minutes-header",
      "aria-expanded": expanded ? "true" : "false",
      onClick: onToggle,
      key: "header",
    }, [
      h("span", { className: "meeting-minutes-info", key: "info" }, [
        h("span", { className: "meeting-minutes-date", key: "date" }, minutes.date),
        minutes.badge ? h("span", { className: `meeting-minutes-badge${minutes.badge.toLowerCase() === "new" ? " new" : ""}`, key: "badge" }, minutes.badge) : null,
      ]),
      h("span", { className: "meeting-minutes-toggle", "aria-hidden": "true", key: "toggle" }, h(ChevronDown, { size: 20 })),
    ]),
    h("div", { className: "meeting-minutes-content", key: "content" }, [
      minutes.sections.map((section) => h(MinutesSection, { section, key: section.title })),
      minutes.downloadHref ? h("a", { href: minutes.downloadHref, className: "meeting-minutes-download", download: true, key: "download" }, [
        h(Download, { size: 16, "aria-hidden": "true", key: "icon" }),
        "Download full minutes",
      ]) : null,
    ]),
  ]);
}

export function MeetingMinutesPanel() {
  const [minutes, setMinutes] = React.useState(() => readMinutesFromLegacyDom());
  const [expandedId, setExpandedId] = React.useState(() => minutes[0]?.id || "");

  React.useEffect(() => {
    const nextMinutes = readMinutesFromLegacyDom();
    setMinutes(nextMinutes);
    setExpandedId((current) => current || nextMinutes[0]?.id || "");
  }, []);

  return h("section", { className: "meeting-minutes-container react-meeting-minutes", "data-react-meeting-minutes": minutes.length ? "ready" : "empty", "aria-labelledby": "reactMeetingMinutesTitle" }, [
    h("h3", { className: "meeting-minutes-title", id: "reactMeetingMinutesTitle", key: "title" }, "Meeting Minutes"),
    minutes.length
      ? h("div", { className: "meeting-minutes-list", key: "list" }, minutes.map((item) => h(MinutesItem, {
        minutes: item,
        expanded: item.id === expandedId,
        onToggle: () => setExpandedId((current) => (current === item.id ? "" : item.id)),
        key: item.id,
      })))
      : h("p", { className: "dash-note", key: "empty" }, "Meeting minutes are temporarily unavailable."),
  ]);
}
