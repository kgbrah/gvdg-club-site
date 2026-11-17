import React from "react";
import { currentAdminRoute, currentAdminAuthGateState } from "./admin-shell-state.js";

import { adminJson, adminRequest } from "./admin-api.js";

const h = React.createElement;

const ERRORS = {
  tag_taken: "That number is already on a bag.",
  member_not_found: "No member matches that.",
  need_two: "Enter scores for at least two tag holders.",
  not_a_holder: "Every score has to belong to someone with a tag.",
  invalid_player: "Scores have to be whole numbers.",
  stale_tags: "Those tags changed before this challenge was confirmed.",
  name_required: "Name the series.",
  member_already_linked: "That member is already linked to another player in this league.",
  league_challenge: "Only the two members can answer a league challenge. You can cancel it.",
  no_league: "That league ladder is not available.",
};

function challengeLine(challenge) {
  return `${challenge.challengerName} #${challenge.challengerTag} (${challenge.challengerScore}) called out ${challenge.defenderName} #${challenge.defenderTag} (${challenge.defenderScore})`;
}

function LeagueAdminSection({ entry, members, busy, run }) {
  const [picked, setPicked] = React.useState({});
  const league = entry.league || {};
  const challenges = Array.isArray(entry.challenges) ? entry.challenges : [];
  const closed = Array.isArray(entry.closed) ? entry.closed : [];
  const holders = Array.isArray(entry.holders) ? entry.holders : [];
  const unlinked = holders.filter((holder) => !holder.linked);
  return h("div", { "data-admin-bag-league": league.id, id: "admin-bag-league-" + league.id, tabIndex: -1 }, [
    h("h3", { className: "al-h", key: "head" }, `${league.name} (UDisc league)`),
    h("p", { className: "al-note", key: "note" },
      "Imported from UDisc. Each import resets this ladder to UDisc's order and closes open challenges. Members answer their own challenges; you can cancel one."),
    challenges.length
      ? h("div", { key: "open" }, challenges.map((challenge) => h("div", { className: "sc-hole-pager-row", key: challenge.id }, [
        h("div", { key: "text" }, challengeLine(challenge)),
        h("button", {
          className: "admin-btn",
          disabled: busy,
          key: "cancel",
          onClick: () => run(() => adminSend(`/admin/bag-tags/challenges/${challenge.id}/cancel`, "POST", {})),
          type: "button",
        }, "Cancel"),
      ])))
      : h("p", { className: "al-note", key: "none" }, "No open challenges."),
    closed.length
      ? h("div", { key: "closed" }, [
        h("h4", { className: "al-h", key: "head" }, "Recently closed"),
        ...closed.map((challenge) => h("div", { className: "sc-hole-pager-row", key: challenge.id },
          h("div", null, `${challengeLine(challenge)} · ${challenge.closedNote || challenge.status}`))),
      ])
      : null,
    holders.length
      ? h("div", { key: "ladder" }, [
        h("h4", { className: "al-h", key: "head" }, "Current ladder"),
        ...holders.map((holder) => h("div", { className: "sc-hole-pager-row", key: holder.tagNumber },
          h("div", null, `#${holder.tagNumber} ${holder.name}${holder.linked ? "" : " (no member account linked)"}`))),
      ])
      : null,
    unlinked.length
      ? h("div", { key: "unlinked" }, [
        h("h4", { className: "al-h", key: "head" }, "Link players to members"),
        ...unlinked.map((holder) => h("div", { className: "sc-hole-pager-row", key: holder.tagNumber }, [
          h("div", { key: "who" }, `#${holder.tagNumber} ${holder.name}`),
          h("select", {
            "aria-label": `Member for ${holder.name}`,
            key: "pick",
            onChange: (event) => setPicked((current) => ({ ...current, [holder.name]: event.target.value })),
            value: picked[holder.name] || "",
          }, [
            h("option", { key: "blank", value: "" }, "Choose a member"),
            ...members.map((member) => h("option", { key: member.memberId, value: member.memberId }, member.name || member.memberId)),
          ]),
          h("button", {
            className: "admin-btn",
            disabled: busy || !picked[holder.name],
            key: "link",
            onClick: () => run(() => adminSend(`/admin/bag-tags/leagues/${league.id}/link`, "POST", {
              playerName: holder.name,
              memberId: picked[holder.name],
            })),
            type: "button",
          }, "Link"),
        ])),
      ])
      : null,
  ]);
}

async function adminSend(path, method, body) {
  const response = await adminRequest(path, { method, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(ERRORS[data.error] || "Could not update bag tags.");
    throw error;
  }
  return data;
}

export function AdminBagTagsPanel() {
  const [board, setBoard] = React.useState(null);
  const [members, setMembers] = React.useState([]);
  const [seriesForm, setSeriesForm] = React.useState({ name: "Club bag tags", season: String(new Date().getFullYear()) });
  const [assign, setAssign] = React.useState({ memberId: "", tagNumber: "" });
  const [scores, setScores] = React.useState({});
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [seriesFilter, setSeriesFilter] = React.useState("all");

  const load = React.useCallback(async () => {
    if (document.body.dataset.adminPanel !== "visible") return;
    try {
      const [nextBoard, roster] = await Promise.all([
        adminJson("/admin/bag-tags"),
        adminJson("/admin/members"),
      ]);
      setBoard(nextBoard);
      setMembers(Array.isArray(roster.members) ? roster.members : []);
      setMessage("");
    } catch (error) {
      if (error && error.status === 401) return;
      setMessage(error.message || "Could not load bag tags.");
    }
  }, []);

  React.useEffect(() => {
    function maybe() {
      if (currentAdminRoute().tab === "bag-tags" && currentAdminAuthGateState().status === "panel") load();
    }
    window.addEventListener("gvdg:admin-active-tab", maybe);
    window.addEventListener("gvdg:admin-auth-gate", maybe);
    maybe();
    return () => {
      window.removeEventListener("gvdg:admin-active-tab", maybe);
      window.removeEventListener("gvdg:admin-auth-gate", maybe);
    };
  }, [load]);

  async function run(action) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      window.dispatchEvent(new CustomEvent("gvdg:admin-needs-refresh"));
      await load();
    } catch (error) {
      setMessage(error.message || "Could not update bag tags.");
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    const route = currentAdminRoute();
    if (!board || route.tab !== "bag-tags" || !["requests", "challenges"].includes(route.filter)) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById("admin-bag-" + route.filter);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [board]);

  const holders = board && Array.isArray(board.holders) ? board.holders : [];
  const challenges = board && Array.isArray(board.challenges) ? board.challenges : [];
  const requests = board && Array.isArray(board.requests) ? board.requests : [];
  const series = board && board.series;
  const leagues = board && Array.isArray(board.leagues) ? board.leagues : [];
  const showClub = seriesFilter === "all" || seriesFilter === "club";
  const nextTag = holders.reduce((max, holder) => Math.max(max, Number(holder.tagNumber) || 0), 0) + 1;
  const tagValue = assign.tagNumber === "" ? String(nextTag) : assign.tagNumber;

  return h("div", { "data-react-admin-bag-tags": "ready" }, [
    h("h2", { className: "admin-pane-heading", key: "title" }, "Bag tags"),
    h("p", { className: "al-note", key: "note" }, "Lower number is better. Settle a card by score, or confirm a head-to-head challenge. A tie keeps the better tag."),
    !series
      ? h("form", {
        className: "admin-form",
        key: "create",
        onSubmit: (event) => {
          event.preventDefault();
          run(() => adminSend("/admin/bag-tags/series", "POST", seriesForm));
        },
      }, [
        h("label", { key: "name" }, ["Series name", h("input", {
          key: "input",
          maxLength: 80,
          onChange: (event) => setSeriesForm((current) => ({ ...current, name: event.target.value })),
          required: true,
          value: seriesForm.name,
        })]),
        h("label", { key: "season" }, ["Season", h("input", {
          key: "input",
          maxLength: 40,
          onChange: (event) => setSeriesForm((current) => ({ ...current, season: event.target.value })),
          value: seriesForm.season,
        })]),
        h("button", { className: "admin-btn", disabled: busy, key: "submit", type: "submit" }, "Start series"),
      ])
      : null,
    series
      ? h("form", {
        className: "admin-form",
        key: "assign",
        onSubmit: (event) => {
          event.preventDefault();
          run(async () => {
            await adminSend("/admin/bag-tags/assign", "POST", {
              memberId: assign.memberId,
              seriesId: series.id,
              tagNumber: Number(tagValue),
            });
            setAssign((current) => ({ ...current, tagNumber: "" }));
          });
        },
      }, [
        h("h3", { className: "al-h", key: "head" }, series.season ? `${series.name} · ${series.season}` : series.name),
        h("label", { key: "member" }, ["Member", h("select", {
          key: "select",
          onChange: (event) => setAssign((current) => ({ ...current, memberId: event.target.value })),
          required: true,
          value: assign.memberId,
        }, [
          h("option", { key: "blank", value: "" }, "Choose a member"),
          ...members.map((member) => h("option", { key: member.memberId, value: member.memberId }, member.name || member.memberId)),
        ])]),
        h("label", { key: "tag" }, ["Tag number", h("input", {
          inputMode: "numeric",
          key: "input",
          min: 1,
          onChange: (event) => setAssign((current) => ({ ...current, tagNumber: event.target.value })),
          required: true,
          value: tagValue,
        })]),
        h("p", { className: "al-note", key: "next" }, `Next new player is #${nextTag}. Type a free number to fill a gap.`),
        h("button", { className: "admin-btn", disabled: busy, key: "submit", type: "submit" }, "Assign tag"),
      ])
      : null,
    series && requests.length
      ? h("div", { key: "requests", id: "admin-bag-requests", tabIndex: -1 }, [
        h("h3", { className: "al-h", key: "head" }, "Tag requests"),
        ...requests.map((request) => h("div", { className: "sc-hole-pager-row", key: request.memberId }, [
          h("div", { key: "who" }, request.name || request.memberId),
          h("button", {
            className: "admin-btn",
            disabled: busy || nextTag > 500,
            key: "give",
            onClick: () => run(() => adminSend("/admin/bag-tags/assign", "POST", {
              memberId: request.memberId,
              seriesId: series.id,
              tagNumber: nextTag,
            })),
            type: "button",
          }, `Give #${nextTag}`),
        ])),
      ])
      : null,
    holders.length
      ? h("div", { key: "holders" }, [
        h("h3", { className: "al-h", key: "head" }, "Current tags"),
        ...holders.map((holder) => h("div", { className: "sc-hole-pager-row", key: holder.memberId }, [
          h("div", { key: "who" }, `#${holder.tagNumber} ${holder.name}`),
          h("input", {
            "aria-label": `Score for ${holder.name}`,
            className: "sc-score-input",
            inputMode: "numeric",
            key: "score",
            onChange: (event) => setScores((current) => ({ ...current, [holder.memberId]: event.target.value })),
            placeholder: "Score",
            value: scores[holder.memberId] || "",
          }),
          h("button", {
            className: "admin-btn",
            disabled: busy,
            key: "release",
            onClick: () => run(() => adminSend("/admin/bag-tags/release", "POST", {
              memberId: holder.memberId,
              seriesId: series.id,
            })),
            type: "button",
          }, "Release"),
        ])),
        h("button", {
          className: "admin-btn",
          disabled: busy,
          key: "settle",
          onClick: () => {
            const players = holders
              .filter((holder) => String(scores[holder.memberId] || "").trim() !== "")
              .map((holder) => ({ memberId: holder.memberId, score: Number(scores[holder.memberId]) }));
            return run(async () => {
              await adminSend("/admin/bag-tags/settle", "POST", { players, seriesId: series.id });
              setScores({});
            });
          },
          type: "button",
        }, "Settle this card"),
      ])
      : null,
    leagues.length
      ? h("label", { className: "al-note", key: "filter" }, [
        "Series ",
        h("select", {
          key: "select",
          "aria-label": "Filter by series",
          onChange: (event) => setSeriesFilter(event.target.value),
          value: seriesFilter,
        }, [
          h("option", { key: "all", value: "all" }, "All series"),
          h("option", { key: "club", value: "club" }, series ? `Club: ${series.name}` : "Club series"),
          ...leagues.map((entry) => h("option", { key: entry.league.id, value: "league-" + entry.league.id }, entry.league.name)),
        ]),
      ])
      : null,
    showClub && challenges.length
      ? h("div", { key: "challenges", id: "admin-bag-challenges", tabIndex: -1 }, [
        h("h3", { className: "al-h", key: "head" }, "Challenges waiting"),
        ...challenges.map((challenge) => h("div", { className: "sc-hole-pager-row", key: challenge.id }, [
          h("div", { key: "text" },
            `${challenge.challengerName} #${challenge.challengerTag} (${challenge.challengerScore}) called out ${challenge.defenderName} #${challenge.defenderTag} (${challenge.defenderScore})`),
          h("button", {
            className: "admin-btn",
            disabled: busy,
            key: "confirm",
            onClick: () => run(() => adminSend(`/admin/bag-tags/challenges/${challenge.id}/confirm`, "POST", {})),
            type: "button",
          }, "Confirm"),
        ])),
      ])
      : null,
    ...leagues
      .filter((entry) => seriesFilter === "all" || seriesFilter === "league-" + entry.league.id)
      .map((entry) => h(LeagueAdminSection, { busy, entry, key: "league-" + entry.league.id, members, run })),
    message ? h("p", { className: "al-note", key: "message" }, message) : null,
  ]);
}
