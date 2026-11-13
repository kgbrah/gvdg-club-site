import React from "react";

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
};

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
      if (document.body.dataset.adminTab === "bag-tags") load();
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
      await load();
    } catch (error) {
      setMessage(error.message || "Could not update bag tags.");
    } finally {
      setBusy(false);
    }
  }

  const holders = board && Array.isArray(board.holders) ? board.holders : [];
  const challenges = board && Array.isArray(board.challenges) ? board.challenges : [];
  const series = board && board.series;
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
    challenges.length
      ? h("div", { key: "challenges" }, [
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
    message ? h("p", { className: "al-note", key: "message" }, message) : null,
  ]);
}
