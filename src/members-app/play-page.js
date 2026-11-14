import React from "react";

import { TOKEN_KEY, request, requestJson, storageGet } from "./api.js";
import { LiveScoringPanel } from "./activity-panels.js";
import { formatEventDay, formatToPar } from "./format.js";
import { liveScoreHref, liveWatchHref } from "../shared/live-watch.js";
import { formatUdiscWhen, recentPlayRounds, relClass } from "./play-page-model.js";
import { myLayoutHandicaps } from "../shared/handicap.js";
import { memberConfirm } from "./member-dialogs.js";

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
      item.rating != null ? h("div", { className: "round-rating", key: "rating", "aria-label": `Round rating ${item.rating}` }, String(item.rating)) : null,
    ]),
    h("a", { className: "passkey-btn", href: item.href, key: "link" }, "Replay"),
  ]);
}

function HandicapRow({ item }) {
  const where = [item.course, item.layout].filter(Boolean).join(" · ");
  const detail = item.rounds + (item.rounds === 1 ? " round" : " rounds") + (item.provisional ? " · provisional" : "");
  return h("div", { className: "handicap-row" }, [
    h("div", { key: "copy" }, [
      h("div", { className: "handicap-where", key: "where" }, where),
      h("div", { className: "player-card-meta", key: "detail" }, detail),
    ]),
    h("b", { className: relClass(item.start), key: "start" }, formatToPar(item.start)),
  ]);
}

function formatUdiscAvg(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return formatToPar(value);
}

function udiscMix(stats) {
  const bits = [
    [stats.aces, "ace"],
    [stats.eagles, "eagle"],
    [stats.birdies, "birdie"],
    [stats.pars, "par"],
    [stats.bogeys, "bogey"],
    [stats.doubles, "dbl+"],
  ];
  return bits.flatMap(([count, label]) => {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return [];
    const word = n === 1 || label === "dbl+" ? label : label + "s";
    return [n + " " + word];
  }).join(" · ");
}

function udiscHoleWhere(row) {
  return [row.courseName, row.layoutName, "Hole " + row.hole].filter(Boolean).join(" · ");
}

function UdiscHoleLines({ title, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  return h("div", { key: title }, [
    h("div", { className: "udisc-hole-label", key: "label" }, title),
    h("div", { className: "udisc-hole-list", key: "list" }, list.map((row) =>
      h("div", { className: "udisc-hole-row", key: udiscHoleWhere(row) }, [
        h("div", { key: "where" }, [
          h("div", { key: "name" }, udiscHoleWhere(row)),
          h("div", { className: "player-card-meta", key: "n" }, row.rounds + (row.rounds === 1 ? " round" : " rounds")),
        ]),
        h("b", { className: relClass(row.avg), key: "avg" }, formatUdiscAvg(row.avg)),
      ]))),
  ]);
}

function UdiscStatTile({ label, value, tone, note }) {
  return h("div", { className: "udisc-stat" }, [
    h("div", { className: "player-stat-k", key: "k" }, label),
    h("b", { className: tone || "", key: "v" }, value),
    note ? h("div", { className: "player-card-meta", key: "n" }, note) : null,
  ]);
}

function UdiscStatsCard({ status, stats }) {
  const ready = stats && Number(stats.rounds) > 0;
  const mix = ready ? udiscMix(stats) : "";
  const partial = ready && stats.partialRounds ? stats.partialRounds + " under 9 holes" : "";
  const avgNote = ready
    ? (stats.scoringRounds ? stats.scoringRounds + (stats.scoringRounds === 1 ? " full card" : " full cards") : "Need a 9-hole card")
    : "";
  return h("section", { className: "player-card", "data-react-udisc-stats": status }, [
    h("h3", { key: "title" }, "UDisc stats"),
    h("p", { className: "player-card-meta", key: "limit" }, "Imported UDisc scorecards only. That file has no UDisc id, so names are the scorecard label, not the account. No putting, fairway, or penalty stats, and no round rating. Cards under 9 holes stay out of the average. This does not change your club handicap."),
    ready
      ? h("div", { key: "body" }, [
        h("div", { className: "udisc-stat-grid", key: "grid" }, [
          h(UdiscStatTile, { key: "rounds", label: "Rounds", value: String(stats.rounds), note: partial }),
          h(UdiscStatTile, { key: "courses", label: "Courses", value: String(stats.courses) }),
          h(UdiscStatTile, {
            key: "avg",
            label: "Average",
            value: formatUdiscAvg(stats.scoringAverage),
            tone: relClass(stats.scoringAverage),
            note: avgNote,
          }),
          h(UdiscStatTile, {
            key: "best",
            label: "Best",
            value: formatUdiscAvg(stats.bestToPar),
            tone: relClass(stats.bestToPar),
            note: stats.bogeyFree ? stats.bogeyFree + " bogey-free" : "",
          }),
        ]),
        mix ? h("p", { className: "udisc-mix", key: "mix" }, mix) : null,
        h(UdiscHoleLines, { key: "hard", title: "Hardest holes", rows: stats.hardest }),
        h(UdiscHoleLines, { key: "easy", title: "Easiest holes", rows: stats.easiest }),
      ])
      : h("p", { className: "player-card-meta", key: "empty" },
        status === "loading" ? "Checking imported rounds..." : "Import a scorecard export and the scoring shows up here."),
  ]);
}

function udiscImportError(status, code) {
  if (code === "unrecognized_csv") return "That file doesn’t look like a UDisc rounds export. Use You → Rounds → Export to CSV.";
  if (code === "empty") return "No scored rounds were in that file for this player.";
  if (code === "unknown_player") return "Pick a player name from the file.";
  if (code === "too_many") return "That export has too many rounds. Split it and import again.";
  if (code === "request_too_large" || status === 413) return "That CSV is too big.";
  if (status === 429) return "Too many imports. Try again in a bit.";
  if (status === 401) return "Sign in again, then retry the import.";
  return "Couldn’t import that file.";
}

function UdiscRoundRow({ item, onRemove }) {
  const when = formatUdiscWhen(item.playedAt);
  const meta = [when, item.layoutName].filter(Boolean).join(" · ");
  const score = item.toPar != null ? formatToPar(item.toPar) : "";
  return h("div", { className: "udisc-history-row" }, [
    h("div", { key: "copy" }, [
      h("div", { className: "udisc-history-title", key: "title" }, item.courseName || "UDisc round"),
      meta ? h("div", { className: "player-card-meta", key: "meta" }, meta) : null,
    ]),
    h("div", { className: "udisc-history-side", key: "side" }, [
      item.total != null || score
        ? h("div", { className: "udisc-history-score " + relClass(item.toPar), key: "score" }, [
          item.total != null ? h("span", { key: "total" }, String(item.total)) : null,
          score ? h("span", { key: "par" }, score) : null,
        ])
        : null,
      h("button", {
        className: "player-btn",
        key: "remove",
        type: "button",
        onClick: () => onRemove(item.id),
      }, "Remove"),
    ]),
  ]);
}

function UdiscHistory({ token }) {
  const [state, setState] = React.useState({ status: "loading", rounds: [], stats: null });
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [players, setPlayers] = React.useState([]);
  const [pendingCsv, setPendingCsv] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    const controller = new AbortController();
    setState((prev) => ({ status: "loading", rounds: prev.rounds, stats: prev.stats }));
    requestJson("/me/udisc-history", { token, signal: controller.signal })
      .then((data) => {
        setState({
          status: "ready",
          rounds: Array.isArray(data?.rounds) ? data.rounds : [],
          stats: data?.stats && typeof data.stats === "object" ? data.stats : null,
        });
      })
      .catch((err) => {
        if (err.name !== "AbortError") setState((prev) => ({ status: "ready", rounds: prev.rounds, stats: prev.stats }));
      });
    return () => controller.abort();
  }, [token]);

  React.useEffect(() => load(), [load]);

  async function send(csv, playerName) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await request("/me/udisc-history", {
        token,
        method: "POST",
        body: playerName ? { csv, playerName } : { csv },
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.error === "pick_player") {
        setPendingCsv(csv);
        setPlayers(Array.isArray(data.players) ? data.players : []);
        setError("Which name is yours?");
        return;
      }
      if (!response.ok) {
        setError(udiscImportError(response.status, data.error));
        return;
      }
      setPlayers([]);
      setPendingCsv("");
      const saved = Number(data.saved) || 0;
      const who = data.playerName ? " for " + data.playerName : "";
      setMessage("Saved " + saved + (saved === 1 ? " round" : " rounds") + who + ".");
      load();
    } catch {
      setError("Couldn’t import that file.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1500000) {
      setError("That CSV is too big.");
      return;
    }
    const csv = await file.text();
    setPlayers([]);
    setPendingCsv("");
    await send(csv);
  }

  async function removeOne(id) {
    setBusy(true);
    setError("");
    try {
      const response = await request("/me/udisc-history/" + id, { token, method: "DELETE" });
      if (!response.ok) {
        setError("Couldn’t remove that round.");
        return;
      }
      setState((prev) => ({ status: "ready", rounds: prev.rounds.filter((row) => row.id !== id), stats: prev.stats }));
      load();
    } catch {
      setError("Couldn’t remove that round.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAll() {
    const yes = await memberConfirm({
      title: "Remove UDisc history?",
      message: "This deletes the imported rounds from your Play tab. It does not change UDisc.",
      confirmText: "Remove all",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    setError("");
    try {
      const response = await request("/me/udisc-history", { token, method: "DELETE" });
      if (!response.ok) {
        setError("Couldn’t remove the imported rounds.");
        return;
      }
      setState({ status: "ready", rounds: [], stats: null });
      setMessage("UDisc history removed.");
    } catch {
      setError("Couldn’t remove the imported rounds.");
    } finally {
      setBusy(false);
    }
  }

  return h(React.Fragment, null, [
    h(UdiscStatsCard, { key: "stats", stats: state.stats, status: state.status }),
    h("section", { className: "player-card", "data-react-udisc-history": state.status, key: "history" }, [
    h("h3", { key: "title" }, "UDisc history"),
    h("p", { className: "player-card-meta", key: "copy" }, "From UDisc, open You, then Rounds, then Export to CSV. Imported rounds stay here and do not change your club handicap."),
    h("label", { className: "player-btn primary udisc-import-btn", key: "import" }, [
      busy ? "Working..." : "Import CSV",
      h("input", {
        accept: ".csv,text/csv",
        disabled: busy,
        key: "file",
        type: "file",
        onChange: onFile,
      }),
    ]),
    error ? h("p", { className: "player-card-meta player-play-error", key: "error" }, error) : null,
    message ? h("p", { className: "player-card-meta udisc-history-note", key: "message" }, message) : null,
    players.length
      ? h("div", { className: "udisc-history-picks", key: "picks" }, players.map((name) =>
        h("button", {
          className: "player-btn",
          disabled: busy,
          key: name,
          type: "button",
          onClick: () => send(pendingCsv, name),
        }, name)))
      : null,
    state.rounds.length
      ? h("div", { className: "udisc-history-list", key: "list" }, [
        ...state.rounds.map((item) => h(UdiscRoundRow, { item, key: item.id, onRemove: removeOne })),
        h("button", {
          className: "player-btn",
          disabled: busy,
          key: "clear",
          type: "button",
          onClick: removeAll,
        }, "Remove all"),
      ])
      : h("p", { className: "player-card-meta", key: "empty" },
        state.status === "loading" ? "Checking imported rounds..." : "No UDisc rounds imported yet."),
    ]),
  ]);
}

function PlayHistory({ token }) {
  const [state, setState] = React.useState({ status: token ? "loading" : "idle", items: [], handicaps: [] });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", items: [], handicaps: [] });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", items: [], handicaps: [] });
    requestJson("/my-results", { token, signal: controller.signal })
      .then((data) => {
        const casual = data?.casual;
        setState({ status: "ready", items: recentPlayRounds(casual), handicaps: myLayoutHandicaps(casual) });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "ready", items: [], handicaps: [] });
      });
    return () => controller.abort();
  }, [token]);

  return h(React.Fragment, null, [
    h("section", { className: "player-card", "data-react-play-handicap": state.status, key: "handicap" }, [
      h("h3", { key: "title" }, "Club handicap"),
      h("p", { className: "player-card-meta", key: "copy" }, "Starting score so an average round on that layout lands near even. Last 1–5 finished stroke rounds there, past year. A thin record counts less until you have three."),
      state.handicaps.length
        ? h("div", { className: "handicap-list", key: "list" }, state.handicaps.map((item) =>
          h(HandicapRow, { item, key: item.layoutId })))
        : h("p", { className: "player-card-meta", key: "empty" },
          state.status === "loading" ? "Checking finished rounds..." : "Finish a stroke round and your start shows up here."),
    ]),
    h("section", { className: "player-card", "data-react-play-recent": state.status, key: "recent" }, [
      h("h3", { key: "title" }, "Recent rounds"),
      state.items.length
        ? h("div", { className: "live-round-list", key: "list" }, state.items.map((item) =>
          h(RecentRoundCard, { item, key: item.code })))
        : h("p", { className: "player-card-meta", key: "empty" },
          state.status === "loading" ? "Looking up finished cards..." : "Finish a card and it lands here."),
    ]),
  ]);
}

export function MemberPlayPage() {
  const token = storageGet(TOKEN_KEY);
  return h("div", { className: "react-play-page player-play", "data-react-play-page": token ? "ready" : "guest" }, [
    h("a", {
      className: "player-keep-score",
      href: "score.html",
      key: "start",
    }, [
      h("div", { key: "copy" }, [
        h("h2", { key: "title" }, "Start a round"),
        h("p", { key: "meta" }, "Casual card. No club login. Share the code with the card."),
      ]),
      h("span", { className: "player-keep-score-go", key: "go" }, "Start"),
    ]),
    token ? h(LiveScoringPanel, { token, variant: "play", key: "live" }) : null,
    token ? h(PlayHistory, { token, key: "history" }) : null,
    token ? h(UdiscHistory, { token, key: "udisc" }) : null,
    h(PlayJoinCard, { key: "join" }),
  ]);
}
