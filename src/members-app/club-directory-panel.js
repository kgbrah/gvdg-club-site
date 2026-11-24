import React from "react";
import { KarmaChip } from "../shared/karma.js";
import { PdgaCredit, PdgaLink, pdgaPlayerHref } from "../shared/pdga-credit.js";
import { CalendarDays, Search, Star, Trophy, Users } from "lucide-react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { memberFullName, memberInitials } from "./club-data.js";
import { AutocompleteInput } from "../shared/autocomplete.js";

const h = React.createElement;
const PAGE_SIZE = 12;
const BATCH_LIMIT = 20;
const FILTERS = [
  { key: "all", label: "All Members" },
  { key: "founding", label: "Founding (2004)" },
  { key: "pdga", label: "PDGA Members" },
];

function StatCard({ icon, value, label }) {
  return h("div", { className: "members-stat-card" }, [
    h("div", { className: "members-stat-icon", "aria-hidden": "true", key: "icon" }, h(icon, { size: 28, strokeWidth: 2.4 })),
    h("div", { className: "members-stat-number", key: "value" }, value),
    h("div", { className: "members-stat-label", key: "label" }, label),
  ]);
}

function yearRange(yearData) {
  const years = Object.keys(yearData).map(Number).filter(Number.isFinite);
  if (!years.length) return 0;
  return Math.max(...years) - Math.min(...years);
}

function DirectoryStats({ members, yearData }) {
  const foundingCount = members.filter((member) => member.yearJoined === 2004).length;
  return h("div", { className: "members-stats-grid", "data-react-directory-stats": "ready" }, [
    h(StatCard, { icon: Users, value: members.length, label: "Total Members", key: "total" }),
    h(StatCard, { icon: Trophy, value: members.filter((member) => member.pdga).length, label: "PDGA Members", key: "pdga" }),
    h(StatCard, { icon: CalendarDays, value: yearRange(yearData), label: "Years Active", key: "years" }),
    h(StatCard, { icon: Star, value: foundingCount, label: "Founding Members", key: "founding" }),
  ]);
}

function GrowthChart({ yearData }) {
  const entries = Object.entries(yearData).sort(([a], [b]) => Number(a) - Number(b));
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return h("div", { className: "members-chart-container", "data-react-directory-chart": "ready" }, [
    h("h3", { className: "members-chart-title", key: "title" }, "Membership Growth Since 2004"),
    h("div", { className: "members-chart", key: "chart" }, entries.map(([year, count]) => h("div", {
      className: "members-chart-bar",
      style: { height: `${Math.max(4, (count / max) * 100)}%` },
      "data-tooltip": `${year}: ${count} new members`,
      role: "img",
      "aria-label": `${year}: ${count} new members`,
      key: year,
    }))),
    h("div", { className: "members-chart-labels", key: "labels" }, entries.map(([year]) =>
      h("span", { className: "members-chart-label", key: year }, year.slice(2)),
    )),
  ]);
}

function memberMatchesFilter(member, filter) {
  if (filter === "founding") return member.yearJoined === 2004;
  if (filter === "pdga") return Boolean(member.pdga);
  return true;
}

function dirRatingText(info) {
  if (!info) return "Not found";
  const parts = [info.rating != null ? `${info.rating} rated` : "Unrated"];
  if (info.classification === "P") parts.push("Pro");
  else if (info.classification === "A") parts.push("Am");
  if (info.membershipStatus && info.membershipStatus !== "current") parts.push(info.membershipStatus);
  return parts.join(" · ");
}

function MemberCard({ member, canLookup, ratingEntry, loading, onCheckRating }) {
  const fullName = memberFullName(member);
  const classNames = ["member-card", member.yearJoined === 2004 ? "founding" : "", member.special ? "special-badge" : ""].filter(Boolean).join(" ");
  const hasEntry = ratingEntry !== undefined;
  return h("div", { className: classNames, "data-badge": member.special || undefined }, [
    h("div", { className: "member-avatar", key: "avatar" }, memberInitials(member)),
    h("div", { className: "member-name", key: "name" }, [fullName, h(KarmaChip, { key: "karma", pdga: member.pdga })]),
    h("div", { className: "member-since", key: "since" }, `Member since ${member.yearJoined}`),
    member.pdga ? h("div", { className: "member-pdga", key: "pdga" }, [
      h(PdgaLink, { href: pdgaPlayerHref(member.pdga), key: "link" }, `PDGA #${member.pdga}`),
      hasEntry
        ? h("span", { className: "pdga-dir-rating", key: "rating" }, dirRatingText(ratingEntry))
        : canLookup
          ? h("button", {
            type: "button",
            className: "pdga-dir-check-btn",
            disabled: loading,
            "data-check-pdga-rating": String(member.pdga),
            key: "check",
            onClick: () => onCheckRating && onCheckRating(member.pdga),
          }, loading ? "Checking…" : "Check rating")
          : null,
    ].filter(Boolean)) : null,
  ]);
}

export function MemberDirectoryPanel({ data }) {
  const [searchTerm, setSearchTerm] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [displayCount, setDisplayCount] = React.useState(PAGE_SIZE);
  const [ratingsByPdga, setRatingsByPdga] = React.useState({});
  const [loadingBatch, setLoadingBatch] = React.useState(false);
  const [loadingSingle, setLoadingSingle] = React.useState("");
  const [ratingError, setRatingError] = React.useState("");
  const members = data?.members || [];
  const yearData = data?.yearData || {};
  const token = storageGet(TOKEN_KEY);

  const filtered = React.useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return members
      .filter((member) => memberMatchesFilter(member, filter))
      .filter((member) => {
        if (!query) return true;
        return memberFullName(member).toLowerCase().includes(query) || String(member.pdga || "").includes(query);
      })
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  }, [filter, members, searchTerm]);

  React.useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [filter, searchTerm]);

  if (!data) return h("div", { className: "dash-note", "data-react-member-directory": "loading" }, "Loading member directory…");

  const visible = filtered.slice(0, displayCount);
  const unloadedVisiblePdga = [...new Set(
    visible.map((m) => m.pdga).filter((n) => n && ratingsByPdga[n] === undefined),
  )].slice(0, BATCH_LIMIT);
  const nameSuggestions = members.map((member) => memberFullName(member));
  const remaining = Math.max(0, filtered.length - displayCount);

  async function fetchPdgaBatch(numbers, single = "") {
    if (!token || !numbers.length || loadingBatch || loadingSingle) return;
    setRatingError("");
    if (single) setLoadingSingle(single);
    else setLoadingBatch(true);
    try {
      const result = await requestJson(`/pdga/players/batch?numbers=${encodeURIComponent(numbers.join(","))}`, { token });
      setRatingsByPdga((current) => ({ ...current, ...(result?.players || {}) }));
    } catch (error) {
      setRatingError(error?.status === 429 ? "Rate limit reached — try again in a few minutes." : "PDGA ratings are unavailable right now.");
    } finally {
      if (single) setLoadingSingle("");
      else setLoadingBatch(false);
    }
  }

  return h("section", { className: "react-member-directory", "data-react-member-directory": "ready", "aria-labelledby": "reactMemberDirectoryTitle" }, [
    h("h3", { className: "my-dashboard-title", id: "reactMemberDirectoryTitle", key: "title" }, "Member Directory"),
    h(DirectoryStats, { members, yearData, key: "stats" }),
    h(GrowthChart, { yearData, key: "chart" }),
    h("div", { className: "members-controls", key: "controls" }, [
      h(AutocompleteInput, {
        suggestions: nameSuggestions,
        wrapperClassName: "members-search-wrap",
        type: "search",
        className: "members-search",
        placeholder: "Search members by name or PDGA #…",
        "aria-label": "Search members by name or PDGA number",
        value: searchTerm,
        onChange: (event) => setSearchTerm(event.target.value),
        key: "search",
      }),
      FILTERS.map((item) => h("button", {
        type: "button",
        className: `members-filter-btn${filter === item.key ? " active" : ""}`,
        "aria-pressed": filter === item.key ? "true" : "false",
        onClick: () => setFilter(item.key),
        key: item.key,
      }, item.label)),
      token && unloadedVisiblePdga.length ? h("button", {
        type: "button",
        className: "members-filter-btn pdga-dir-batch-btn",
        disabled: loadingBatch || Boolean(loadingSingle),
        "data-directory-load-ratings": "true",
        key: "load-pdga",
        onClick: () => { void fetchPdgaBatch(unloadedVisiblePdga); },
      }, loadingBatch ? "Loading PDGA…" : "Load PDGA ratings") : null,
    ].filter(Boolean)),
    ratingError ? h("p", { className: "dash-note", role: "alert", key: "rating-error" }, ratingError) : null,
    h("div", { className: "members-grid", key: "grid" }, visible.length
      ? visible.map((member) => h(MemberCard, {
        member,
        canLookup: Boolean(token),
        ratingEntry: member.pdga ? ratingsByPdga[member.pdga] : undefined,
        loading: loadingBatch || loadingSingle === String(member.pdga || ""),
        onCheckRating: (pdga) => { void fetchPdgaBatch([pdga], String(pdga)); },
        key: `${memberFullName(member)}-${member.yearJoined}-${member.pdga || ""}`,
      }))
      : h("div", { className: "members-no-results" }, [
        h(Search, { size: 32, "aria-hidden": "true", key: "icon" }),
        h("p", { key: "text" }, "No members found."),
      ])),
    remaining ? h("div", { className: "members-load-more", key: "load" }, h("button", {
      type: "button",
      className: "members-load-btn",
      onClick: () => setDisplayCount((count) => count + PAGE_SIZE),
    }, `Show More (${remaining} remaining)`)) : null,
    h("div", { className: "members-count", role: "status", "aria-live": "polite", key: "count" },
      filtered.length ? `Showing ${Math.min(displayCount, filtered.length)} of ${filtered.length} members` : ""),
    Object.keys(ratingsByPdga).length ? h(PdgaCredit, { key: "pdga-credit" }) : null,
  ]);
}
