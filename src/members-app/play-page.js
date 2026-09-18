import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { LiveScoringPanel } from "./activity-panels.js";
import { formatEventDay, formatToPar } from "./format.js";
import { liveScoreHref, liveWatchHref } from "../shared/live-watch.js";
import { recentPlayRounds, relClass } from "./play-page-model.js";

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

function RecentRoundCard({ item }) {
  const meta = [formatEventDay(item.when), item.layout].filter(Boolean).join(" · ");
  const score = item.toPar != null ? formatToPar(item.toPar) : item.total != null ? String(item.total) : "";
  return h("div", { className: "live-round-card" }, [
    h("div", { key: "body" }, [
      h("span", { className: "live-round-badge", key: "badge" }, "Finished"),
      h("div", { className: "live-round-title", key: "title" }, item.title),
      meta ? h("div", { className: "live-round-meta", key: "meta" }, meta) : null,
      score
        ? h("div", { className: "recent-round-score " + relClass(item.toPar), key: "score" }, [
          item.total != null ? h("span", { key: "total" }, String(item.total) + " ") : null,
          h("span", { key: "par" }, score),
        ])
        : null,
    ]),
    h("a", { className: "passkey-btn", href: item.href, key: "link" }, "Replay"),
  ]);
}

function RecentRoundsPanel({ token }) {
  const [state, setState] = React.useState({ status: token ? "loading" : "idle", items: [] });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", items: [] });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", items: [] });
    requestJson("/my-results", { token, signal: controller.signal })
      .then((data) => {
        setState({ status: "ready", items: recentPlayRounds(data?.casual) });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "ready", items: [] });
      });
    return () => controller.abort();
  }, [token]);

  return h("section", { className: "player-card", "data-react-play-recent": state.status }, [
    h("h3", { key: "title" }, "Recent rounds"),
    state.items.length
      ? h("div", { className: "live-round-list", key: "list" }, state.items.map((item) =>
        h(RecentRoundCard, { item, key: item.code })))
      : h("p", { className: "player-card-meta", key: "empty" },
        state.status === "loading" ? "Looking up finished cards..." : "Finish a card and it lands here."),
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
        h("p", { key: "meta" }, "Casual card. Share the code — friends don’t need a club login."),
      ]),
      h("span", { className: "player-keep-score-go", key: "go" }, "Start"),
    ]),
    h(LiveScoringPanel, { token, variant: "play", key: "live" }),
    h(RecentRoundsPanel, { token, key: "recent" }),
    h(PlayJoinCard, { key: "join" }),
  ]);
}
