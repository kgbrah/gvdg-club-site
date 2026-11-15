import React from "react";
import { Tag } from "lucide-react";

import { request } from "./api.js";
import { BagTagLeagueOrder } from "./club-leagues.js";

const h = React.createElement;

const ERRORS = {
  challenge_open: "You already have a challenge waiting.",
  must_challenge_better_tag: "Challenge someone with a lower tag number.",
  invalid_challenge: "Enter both scores as whole numbers.",
  not_a_holder: "Both players need a tag.",
  stale_tags: "The tags changed. Issue the challenge again.",
  rate_limited: "Too many challenges. Try again later.",
  no_series: "The club has not started a bag tag series.",
  already_holding: "You already have a tag.",
  request_limited: "Too many requests. Try again later.",
};

async function send(path, token, method, body) {
  const response = await request(path, { token, method, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(ERRORS[data.error] || "Could not update bag tags.");
    error.code = data.error || "";
    throw error;
  }
  return data;
}

function TagLadder({ holders, mine }) {
  const rows = holders.map((holder) => ({ id: holder.memberId, tag: holder.tagNumber, name: holder.name || "Member", you: false }));
  if (mine && !rows.some((row) => row.id === mine.memberId)) {
    rows.push({ id: mine.memberId, tag: mine.tagNumber, name: mine.name || "You", you: true });
  } else if (mine) {
    for (const row of rows) row.you = row.id === mine.memberId;
  }
  rows.sort((a, b) => a.tag - b.tag);
  if (!rows.length) return null;
  return h("ol", { className: "tag-ladder", "aria-label": "Bag tag ladder", key: "ladder" }, rows.map((row) => {
    const reachable = mine && !row.you && row.tag < mine.tagNumber;
    return h("li", {
      className: "tag-ladder-row" + (row.you ? " is-you" : "") + (reachable ? " is-reachable" : ""),
      "aria-current": row.you ? "true" : undefined,
      key: row.id || row.tag,
    }, [
      h("span", { className: "tag-ladder-num", key: "n" }, "#" + row.tag),
      h("span", { className: "tag-ladder-name", key: "name" }, row.name),
      row.you ? h("span", { className: "tag-ladder-flag", key: "f" }, "You")
        : reachable ? h("span", { className: "tag-ladder-flag quiet", key: "f" }, "Can challenge") : null,
    ]);
  }));
}

export function BagTagPanel({ token, compact = false }) {
  const [board, setBoard] = React.useState(null);
  const [defenderId, setDefenderId] = React.useState("");
  const [scores, setScores] = React.useState({ mine: "", theirs: "" });
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!token) return;
    try {
      setBoard(await send("/bag-tags/mine", token, "GET"));
    } catch (error) {
      setMessage(error.message || "Could not load bag tags.");
    }
  }, [token]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (!board || !board.series) return h(BagTagLeagueOrder, { compact });
  const mine = board.mine;
  const holders = Array.isArray(board.holders) ? board.holders : [];
  const challenges = Array.isArray(board.challenges) ? board.challenges : [];
  const targets = holders.filter((holder) => mine && holder.tagNumber < mine.tagNumber);
  const incoming = challenges.filter((challenge) => challenge.defenderId === (mine && mine.memberId));

  async function issue(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const mineScore = Number(scores.mine);
    const theirScore = Number(scores.theirs);
    if (!Number.isInteger(mineScore) || !Number.isInteger(theirScore)) {
      setMessage(ERRORS.invalid_challenge);
      setBusy(false);
      return;
    }
    try {
      await send("/bag-tags/challenges", token, "POST", {
        defenderId,
        challengerScore: mineScore,
        defenderScore: theirScore,
      });
      setDefenderId("");
      setScores({ mine: "", theirs: "" });
      setMessage("Challenge sent. They confirm the scores.");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not send the challenge.");
    } finally {
      setBusy(false);
    }
  }

  async function answer(id, action) {
    setBusy(true);
    setMessage("");
    try {
      await send(`/bag-tags/challenges/${id}/${action}`, token, "POST", {});
      setMessage(action === "confirm" ? "Tags updated." : "Challenge declined.");
      await load();
    } catch (error) {
      setMessage(error.message || "Could not answer the challenge.");
    } finally {
      setBusy(false);
    }
  }

  async function requestTag() {
    setBusy(true);
    setMessage("");
    try {
      await send("/bag-tags/request", token, "POST", {});
      await load();
    } catch (error) {
      setMessage(error.message || "Could not request a tag.");
    } finally {
      setBusy(false);
    }
  }

  const requested = Boolean(board.request && board.request.createdAt);

  return h("section", { className: "bag-tag-home" + (compact ? " member-home-tags" : ""), "data-react-bag-tags": "ready" }, [
    h("div", { className: "bag-tag-home-row member-list-row" + (compact ? " member-account-row" : ""), key: "head" }, [
      compact ? h(Tag, { className: "member-account-icon", size: 20, "aria-hidden": true, key: "icon" }) : null,
      h("div", { className: compact ? "member-account-copy" : "member-list-copy", key: "copy" }, [
        h("h3", { className: compact ? undefined : "member-list-name", key: "title" }, mine ? `Bag tag #${mine.tagNumber}` : "Bag tags"),
        h("p", { className: "player-card-meta" + (compact ? "" : " member-list-meta"), key: "note" }, mine
          ? (compact ? "Club tag series" : "Lower number is better. Challenge someone above you, or wait for a card settle.")
          : requested
            ? (compact ? "Request sent" : "Request sent. An admin will hand you the next number.")
            : `${board.series.name} is active.`),
      ]),
      !mine && !requested
        ? h("button", {
          className: compact ? "member-account-action member-list-action" : "player-job-link member-list-action",
          disabled: busy,
          key: "request",
          onClick: requestTag,
          type: "button",
          "aria-label": "Request a tag",
        }, busy ? "Requesting…" : "Request tag")
        : null,
    ]),
    !compact && (holders.length || mine) ? h(TagLadder, { holders, mine, key: "ladder" }) : null,
    h(BagTagLeagueOrder, { compact, key: "imported" }),
    incoming.map((challenge) => h("div", { className: "member-tag-detail tag-incoming", key: challenge.id }, [
      h("p", { className: "player-card-meta", key: "text" },
        `${challenge.challengerName} called out your #${challenge.defenderTag}. They shot ${challenge.challengerScore}, you shot ${challenge.defenderScore}.`),
      h("div", { className: "member-action-grid", key: "actions" }, [
        h("button", {
          className: "player-btn primary",
          disabled: busy,
          key: "yes",
          onClick: () => answer(challenge.id, "confirm"),
          type: "button",
        }, "Confirm"),
        h("button", {
          className: "player-btn",
          disabled: busy,
          key: "no",
          onClick: () => answer(challenge.id, "decline"),
          type: "button",
        }, "Decline"),
      ]),
    ])),
    mine && targets.length
      ? h("form", { className: "member-tag-detail member-tag-form tag-challenge-form", key: "challenge", onSubmit: issue }, [
        h("label", { className: "player-card-meta", key: "who" }, [
          "Challenge",
          h("select", {
            key: "select",
            onChange: (event) => setDefenderId(event.target.value),
            required: true,
            value: defenderId,
          }, [
            h("option", { key: "blank", value: "" }, "Pick a better tag"),
            ...targets.map((holder) => h("option", { key: holder.memberId, value: holder.memberId },
              `#${holder.tagNumber} ${holder.name}`)),
          ]),
        ]),
        h("label", { className: "player-card-meta", key: "mine" }, [
          "Your score",
          h("input", {
            inputMode: "numeric",
            key: "input",
            onChange: (event) => setScores((current) => ({ ...current, mine: event.target.value })),
            required: true,
            value: scores.mine,
          }),
        ]),
        h("label", { className: "player-card-meta", key: "theirs" }, [
          "Their score",
          h("input", {
            inputMode: "numeric",
            key: "input",
            onChange: (event) => setScores((current) => ({ ...current, theirs: event.target.value })),
            required: true,
            value: scores.theirs,
          }),
        ]),
        h("div", { className: "member-action-grid", key: "send-row" }, [
          h("button", { className: "player-btn primary", disabled: busy, key: "send", type: "submit" }, "Send challenge"),
        ]),
      ])
      : null,
    message ? h("p", { role: "status", className: "player-card-meta member-tag-detail", key: "message" }, message) : null,
  ]);
}
