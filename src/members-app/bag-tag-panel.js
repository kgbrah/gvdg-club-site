import React from "react";
import { KarmaChip, karmaSuffix, useKarmaDirectory } from "../shared/karma.js";
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
  no_league: "That league ladder is not available.",
};

export const LEAGUE_NOTE = "Imported from UDisc. The ladder resets to UDisc's order at each import (Sundays 3pm). Record challenge results in UDisc to keep them.";
export const NO_TAG_HINT = "Challenges unlock once you hold a tag. Request a club tag, or join a bag-tag league.";

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

function TagLadder({ holders, mine, label }) {
  const rows = holders.map((holder) => ({
    id: holder.memberId || "tag-" + holder.tagNumber,
    linked: holder.memberId != null,
    tag: holder.tagNumber,
    name: holder.name || "Member",
    you: false,
  }));
  if (mine && !rows.some((row) => row.id === mine.memberId)) {
    rows.push({ id: mine.memberId, linked: true, tag: mine.tagNumber, name: mine.name || "You", you: true });
  } else if (mine) {
    for (const row of rows) row.you = row.id === mine.memberId;
  }
  rows.sort((a, b) => a.tag - b.tag);
  if (!rows.length) return null;
  return h("ol", { className: "tag-ladder", "aria-label": label || "Bag tag ladder", key: "ladder" }, rows.map((row) => {
    const reachable = mine && !row.you && row.linked && row.tag < mine.tagNumber;
    return h("li", {
      className: "tag-ladder-row" + (row.you ? " is-you" : "") + (reachable ? " is-reachable" : ""),
      "aria-current": row.you ? "true" : undefined,
      key: row.id || row.tag,
    }, [
      h("span", { className: "tag-ladder-num", key: "n" }, "#" + row.tag),
      h("span", { className: "tag-ladder-name", key: "name" }, [row.name, h(KarmaChip, { key: "karma", memberId: row.linked || row.you ? row.id : "" })]),
      row.you ? h("span", { className: "tag-ladder-flag", key: "f" }, "You")
        : reachable ? h("span", { className: "tag-ladder-flag quiet", key: "f" }, "Can challenge") : null,
    ]);
  }));
}

function closedText(challenge, memberId) {
  const note = challenge.closedNote || challenge.status;
  if (challenge.challengerId === memberId) {
    return `Your challenge to ${challenge.defenderName} (#${challenge.defenderTag}) ended (${note}).`;
  }
  return `${challenge.challengerName}'s challenge for your #${challenge.defenderTag} ended (${note}).`;
}

function moveText(move) {
  if (move.kind === "challenge") return `App challenge (not in UDisc): ${move.summary}`;
  return move.summary;
}

/** Challenge cards, the challenge form, and notices for one ladder (club series or one league). */
function ChallengeArea({ token, compact, leagueId, leagueName, mine, holders, challenges, closed, onChanged, showForm, part }) {
  const karma = useKarmaDirectory();
  const [defenderId, setDefenderId] = React.useState("");
  const [scores, setScores] = React.useState({ mine: "", theirs: "" });
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const myId = mine && mine.memberId;
  const targets = holders.filter((holder) => mine && holder.memberId && holder.tagNumber < mine.tagNumber);
  const incoming = challenges.filter((challenge) => challenge.defenderId === myId);
  const outgoing = challenges.filter((challenge) => challenge.challengerId === myId);

  async function issue(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const mineScore = Number(scores.mine);
    const theirScore = Number(scores.theirs);
    if (!Number.isInteger(mineScore) || !Number.isInteger(theirScore) || scores.mine === "" || scores.theirs === "") {
      setMessage(ERRORS.invalid_challenge);
      setBusy(false);
      return;
    }
    try {
      await send("/bag-tags/challenges", token, "POST", {
        defenderId,
        challengerScore: mineScore,
        defenderScore: theirScore,
        ...(leagueId ? { leagueId } : {}),
      });
      setDefenderId("");
      setScores({ mine: "", theirs: "" });
      setMessage("Challenge sent. They confirm the scores.");
      await onChanged();
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
      await onChanged();
    } catch (error) {
      setMessage(error.message || "Could not answer the challenge.");
      if (error.code === "stale_tags") await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const cards = part !== "form";
  const form = part !== "cards" && showForm;
  return h(React.Fragment, null, [
    ...(!cards ? [] : [incoming.map((challenge) => h("div", {
      className: "member-tag-detail tag-incoming",
      "data-league-id": leagueId || undefined,
      key: "in-" + challenge.id,
    }, [
      h("p", { className: "player-card-meta", key: "text" }, [
        `${leagueName ? leagueName + ": " : ""}${challenge.challengerName}`,
        challenge.challengerId ? h(KarmaChip, { key: "karma", memberId: challenge.challengerId }) : null,
        ` called out your #${challenge.defenderTag}. They shot ${challenge.challengerScore}, you shot ${challenge.defenderScore}.`,
      ]),
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
    outgoing.map((challenge) => h("p", { className: "player-card-meta member-tag-detail", key: "out-" + challenge.id }, [
      `${leagueName ? leagueName + ": " : ""}Waiting on ${challenge.defenderName}`,
      challenge.defenderId ? h(KarmaChip, { key: "karma", memberId: challenge.defenderId }) : null,
      ` (#${challenge.defenderTag}) to confirm your scores.`,
    ])),
    closed.map((challenge) => h("p", {
      className: "player-card-meta member-tag-detail tag-closed",
      key: "closed-" + challenge.id,
      role: "status",
    }, (leagueName ? leagueName + ": " : "") + closedText(challenge, myId))),
    ])
    ,
    form && mine && targets.length
      ? h("form", {
        className: "member-tag-detail member-tag-form tag-challenge-form",
        "data-league-id": leagueId || undefined,
        key: "challenge",
        onSubmit: issue,
      }, [
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
              `#${holder.tagNumber} ${holder.name}${karmaSuffix(karma, { memberId: holder.memberId })}`)),
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

function LeagueSection({ token, compact, entry, onChanged, primary }) {
  const league = entry.league || {};
  const holders = Array.isArray(entry.holders) ? entry.holders : [];
  const challenges = Array.isArray(entry.challenges) ? entry.challenges : [];
  const closed = Array.isArray(entry.closed) ? entry.closed : [];
  const moves = Array.isArray(entry.moves) ? entry.moves : [];
  const mine = entry.mine;
  return h("section", {
    className: "bag-tag-home bag-tag-league" + (compact ? " member-home-tags" : ""),
    "data-bag-tag-league": league.id,
    "data-react-bag-tags": primary ? "ready" : undefined,
  }, [
    h("div", { className: "bag-tag-home-row member-list-row" + (compact ? " member-account-row" : ""), key: "head" }, [
      compact ? h(Tag, { className: "member-account-icon", size: 20, "aria-hidden": true, key: "icon" }) : null,
      h("div", { className: compact ? "member-account-copy" : "member-list-copy", key: "copy" }, [
        h("h3", { className: compact ? undefined : "member-list-name", key: "title" }, league.name || "Bag tag league"),
        h("p", { className: "player-card-meta" + (compact ? "" : " member-list-meta"), key: "note" },
          mine ? `Your tag #${mine.tagNumber}` + (compact ? "" : ". Lower number is better.") : "Bag tag league"),
      ]),
    ]),
    !compact ? h("p", { className: "player-card-meta member-tag-detail tag-league-note", key: "imported" }, LEAGUE_NOTE) : null,
    !compact && holders.length ? h(TagLadder, { holders, mine, label: `${league.name || "League"} tag ladder`, key: "ladder" }) : null,
    h(ChallengeArea, {
      challenges,
      closed,
      holders,
      key: "area",
      leagueId: league.id,
      leagueName: league.name,
      mine,
      onChanged,
      showForm: !compact,
      token,
    }),
    !compact && moves.length
      ? h("ul", { className: "tag-history player-card-meta member-tag-detail", "aria-label": `${league.name || "League"} history`, key: "history" },
        moves.slice(0, 6).map((move) => h("li", { key: move.id }, moveText(move))))
      : null,
  ]);
}

export function BagTagPanel({ token, compact = false }) {
  const [board, setBoard] = React.useState(null);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!token) return;
    setMessage("");
    try {
      setBoard(await send("/bag-tags/mine", token, "GET"));
    } catch (error) {
      setMessage(error.message || "Could not load bag tags.");
    }
  }, [token]);

  React.useEffect(() => {
    load();
  }, [load]);

  const leagues = board && Array.isArray(board.leagues) ? board.leagues : [];
  const hasClub = Boolean(board && board.series);
  if (!board && message) {
    return h("div", { className: "member-subactions", "data-bag-tag-state": "error" }, [
      h("p", { className: "dash-note", key: "msg", role: "alert" }, message),
      h("button", { className: "dashboard-action", key: "retry", onClick: () => { void load(); }, type: "button" }, "Try again"),
    ]);
  }
  if (!board || (!hasClub && !leagues.length)) {
    return h(React.Fragment, null, [
      board && !compact ? h("p", { className: "dash-note", key: "hint", "data-bag-tag-hint": "no-tag" }, NO_TAG_HINT) : null,
      h(BagTagLeagueOrder, { compact, key: "order" }),
    ]);
  }
  const mine = board.mine;
  const holders = Array.isArray(board.holders) ? board.holders : [];
  const challenges = Array.isArray(board.challenges) ? board.challenges : [];
  const skipIds = leagues.map((entry) => String(entry.league.id));
  const noTagAnywhere = !mine && !leagues.length;

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

  const clubSection = hasClub ? h("section", { className: "bag-tag-home" + (compact ? " member-home-tags" : ""), "data-react-bag-tags": "ready", key: "club" }, [
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
    noTagAnywhere && !compact ? h("p", { className: "player-card-meta member-tag-detail", "data-bag-tag-hint": "no-tag", key: "hint" }, NO_TAG_HINT) : null,
    !compact && (holders.length || mine) ? h(TagLadder, { holders, mine, key: "ladder" }) : null,
    h(ChallengeArea, {
      challenges,
      closed: [],
      holders,
      key: "area",
      leagueId: null,
      leagueName: "",
      mine,
      onChanged: load,
      part: compact && leagues.length ? "cards" : undefined,
      showForm: true,
      token,
    }),
    message ? h("p", { role: "status", className: "player-card-meta member-tag-detail", key: "message" }, message) : null,
  ]) : null;

  return h(React.Fragment, null, [
    clubSection,
    leagues.map((entry, index) => h(LeagueSection, { compact, entry, primary: !hasClub && index === 0, key: "league-" + entry.league.id, onChanged: load, token })),
    // On Home, the club form comes after the league rows so incoming league challenges stay in view.
    compact && hasClub && leagues.length
      ? h(ChallengeArea, {
        challenges,
        closed: [],
        holders,
        key: "club-form",
        leagueId: null,
        leagueName: "",
        mine,
        onChanged: load,
        part: "form",
        showForm: true,
        token,
      })
      : null,
    h(BagTagLeagueOrder, { compact, key: "imported", skipIds }),
  ]);
}
