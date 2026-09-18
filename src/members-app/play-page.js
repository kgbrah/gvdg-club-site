import React from "react";

import { TOKEN_KEY, storageGet } from "./api.js";
import { LiveScoringPanel } from "./activity-panels.js";
import { liveScoreHref, liveWatchHref } from "../shared/live-watch.js";

const h = React.createElement;

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function PlayJoinCard() {
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const round = normalizeCode(code);

  function go(kind) {
    if (round.length < 4) {
      setError("Enter a 4+ character round code.");
      return;
    }
    setError("");
    window.location.href = kind === "watch"
      ? liveWatchHref({ roundCode: round })
      : liveScoreHref({ roundCode: round });
  }

  return h("section", { className: "player-card", "data-react-play-join": "ready" }, [
    h("h3", { key: "title" }, "Join a card"),
    h("p", { className: "player-card-meta", key: "copy" }, "Type the code from someone already scoring."),
    h("div", { className: "player-play-join", key: "form" }, [
      h("label", { className: "player-play-label", htmlFor: "playJoinCode", key: "label" }, "Round code"),
      h("input", {
        autoCapitalize: "characters",
        autoCorrect: "off",
        className: "player-play-code",
        id: "playJoinCode",
        key: "input",
        maxLength: 8,
        onChange: (event) => {
          setCode(event.target.value);
          if (error) setError("");
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") go("join");
        },
        placeholder: "e.g. K7M2QX",
        spellCheck: "false",
        value: code,
      }),
      error ? h("p", { className: "player-card-meta player-play-error", key: "error" }, error) : null,
      h("div", { className: "player-play-actions", key: "actions" }, [
        h("button", {
          className: "player-btn primary",
          key: "join",
          type: "button",
          onClick: () => go("join"),
        }, "Join"),
        h("button", {
          className: "player-btn",
          key: "watch",
          type: "button",
          onClick: () => go("watch"),
        }, "Watch"),
      ]),
    ]),
  ]);
}

export function MemberPlayPage() {
  const token = storageGet(TOKEN_KEY);
  if (!token) return null;
  return h("div", { className: "react-play-page player-play", "data-react-play-page": "ready" }, [
    h("a", {
      className: "player-keep-score",
      href: "score.html",
      key: "start",
    }, [
      h("div", { key: "copy" }, [
        h("h2", { key: "title" }, "Start a round"),
        h("p", { key: "meta" }, "Casual card. Share the code with your group."),
      ]),
      h("span", { className: "player-keep-score-go", key: "go" }, "Start"),
    ]),
    h(LiveScoringPanel, { token, variant: "play", key: "live" }),
    h(PlayJoinCard, { key: "join" }),
  ]);
}
