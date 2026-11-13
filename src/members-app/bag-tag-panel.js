import React from "react";

import { request } from "./api.js";

const h = React.createElement;

const ERRORS = {
  challenge_open: "You already have a challenge waiting.",
  must_challenge_better_tag: "Challenge someone with a lower tag number.",
  invalid_challenge: "Enter both scores as whole numbers.",
  not_a_holder: "Both players need a tag.",
  stale_tags: "The tags changed. Issue the challenge again.",
  rate_limited: "Too many challenges. Try again later.",
  no_series: "The club has not started a bag tag series.",
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

export function BagTagPanel({ token }) {
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

  if (!board || !board.series) return null;
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

  return h("section", { className: "player-story-block", "data-react-bag-tags": "ready" }, [
    h("h3", { key: "title" }, mine ? `Bag tag #${mine.tagNumber}` : "Bag tags"),
    h("p", { className: "player-card-meta", key: "note" }, mine
      ? "Lower number is better. Challenge someone above you, or wait for a card settle."
      : `${board.series.name} is active. Ask an admin for a tag.`),
    incoming.map((challenge) => h("div", { key: challenge.id }, [
      h("p", { className: "player-card-meta", key: "text" },
        `${challenge.challengerName} called out your #${challenge.defenderTag}. They shot ${challenge.challengerScore}, you shot ${challenge.defenderScore}.`),
      h("div", { className: "player-chip-row", key: "actions" }, [
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
      ? h("form", { key: "challenge", onSubmit: issue }, [
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
        h("button", { className: "player-btn primary", disabled: busy, key: "send", type: "submit" }, "Send challenge"),
      ])
      : null,
    message ? h("p", { className: "player-card-meta", key: "message" }, message) : null,
  ]);
}
