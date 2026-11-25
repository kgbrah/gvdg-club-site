import React from "react";
import { dashboardShowing } from "./dashboard-router.js";
import { ArrowRight, ChevronRight, MapPin } from "lucide-react";
import { MoreLink } from "./more-link.js";

import { TOKEN_KEY, request, requestJson, storageGet } from "./api.js";
import { LiveScoringPanel } from "./activity-panels.js";
import { formatEventDay, formatToPar } from "./format.js";
import { liveScoreHref, liveWatchHref } from "../shared/live-watch.js";
import { formatUdiscWhen, recentPlayRounds, relClass } from "./play-page-model.js";
import { myLayoutHandicaps } from "../shared/handicap.js";
import { trafficHoleLine, trafficSummary } from "../shared/course-traffic.js";
import { distanceMeters, formatDistance, point } from "../shared/course-geo.js";
import { mergeDiscoveredCourses } from "../score-app/course-pick.js";
import { memberConfirm } from "./member-dialogs.js";
import { historyLocked, MembershipNeeded } from "./membership-needed.js";
import { useMemberContext } from "./member-context.js";

const h = React.createElement;

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function CourseTrafficCard() {
  const [rows, setRows] = React.useState([]);
  const [status, setStatus] = React.useState("loading");
  React.useEffect(() => {
    let dead = false;
    function load() {
      requestJson("/course-traffic")
        .then((data) => {
          if (dead) return;
          setRows(Array.isArray(data && data.courses) ? data.courses : []);
          setStatus("ready");
        })
        .catch(() => {
          if (!dead) setStatus("error");
        });
    }
    load();
    const timer = window.setInterval(() => { if (dashboardShowing("play")) load(); }, 45000);
    return () => {
      dead = true;
      window.clearInterval(timer);
    };
  }, []);
  return h("section", { className: "player-card", "data-react-course-traffic": status, key: "traffic" }, [
    h("h3", { key: "title" }, "Course traffic"),
    h("p", { className: "player-card-meta", key: "copy" }, "Live groups, hole by hole, from cards scoring right now."),
    status === "loading"
      ? h("p", { className: "player-card-meta", role: "status", key: "loading" }, "Checking who's out…")
      : status === "error"
        ? h("p", { className: "player-card-meta", role: "alert", key: "error" }, "Course traffic couldn’t load. It will refresh automatically.")
      : rows.length
        ? h("div", { className: "live-round-list", key: "list" }, rows.map((row) => h("div", { className: "live-round-card", key: row.courseId || row.name }, [
          h("div", { key: "body" }, [
            h("span", { className: "live-round-badge", key: "badge" }, "Live"),
            h("div", { className: "live-round-title", key: "title" }, row.name),
            h("div", { className: "live-round-meta", key: "meta" }, trafficSummary(row)),
            trafficHoleLine(row) ? h("div", { className: "player-card-meta", key: "holes" }, trafficHoleLine(row)) : null,
          ]),
        ])))
        : h("p", { className: "player-card-meta", key: "empty" }, "No cards on a course."),
  ]);
}

function CourseSearch() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [result, setResult] = React.useState({ courses: null, error: false });
  const [retry, loadAgain] = React.useReducer((count) => count + 1, 0);
  const [loc, setLoc] = React.useState({ status: "idle", origin: null });
  const [nearby, setNearby] = React.useState({ status: "idle", courses: [], miles: 0 });
  const [opening, setOpening] = React.useState("");
  const [openError, setOpenError] = React.useState("");
  const nearbyAbortRef = React.useRef(null);

  React.useEffect(() => () => nearbyAbortRef.current?.abort(), []);

  React.useEffect(() => {
    if (!open || result.courses) return undefined;
    const controller = new AbortController();
    requestJson("/courses", { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult({ courses: Array.isArray(data?.courses) ? data.courses : [], error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ courses: null, error: true });
    });
    return () => controller.abort();
  }, [open, result.courses, retry]);

  React.useEffect(() => {
    if (!open || !loc.origin) {
      setNearby({ status: "idle", courses: [], miles: 0 });
      return undefined;
    }
    const controller = new AbortController();
    nearbyAbortRef.current?.abort();
    nearbyAbortRef.current = controller;
    setNearby({ status: "loading", courses: [], miles: 0 });
    const here = loc.origin;
    const milesSteps = [25, 50, 100];
    (async () => {
      try {
        let fetched = [];
        let usedMiles = 25;
        for (const radius of milesSteps) {
          const data = await requestJson(
            `/courses/nearby?lat=${encodeURIComponent(here.lat)}&lng=${encodeURIComponent(here.lng)}&miles=${radius}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          fetched = Array.isArray(data?.courses) ? data.courses : [];
          usedMiles = radius;
          const catalogHits = (result.courses || []).some((row) => distanceMeters(here, row) <= radius * 1609.344);
          if (fetched.length > 0 || catalogHits) break;
        }
        setNearby({ status: "ready", courses: fetched, miles: usedMiles });
      } catch (error) {
        if (!controller.signal.aborted && error?.name !== "AbortError") {
          setNearby({ status: "error", courses: [], miles: 0 });
        }
      }
    })();
    return () => controller.abort();
  }, [open, loc.origin]);

  function toggleLocation() {
    setOpenError("");
    if (loc.origin) {
      nearbyAbortRef.current?.abort();
      setLoc({ status: "idle", origin: null });
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLoc({ status: "unavailable", origin: null });
      return;
    }
    setLoc({ status: "locating", origin: null });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const origin = point({ lat: position.coords?.latitude, lng: position.coords?.longitude });
        setLoc(origin ? { status: "ready", origin } : { status: "unavailable", origin: null });
      },
      () => setLoc({ status: "unavailable", origin: null }),
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 10000 },
    );
  }

  async function openExternalCourse(row) {
    if (opening) return;
    setOpening(String(row.id));
    setOpenError("");
    try {
      const response = await request("/courses/discover", {
        method: "POST",
        token: storageGet(TOKEN_KEY),
        body: { source: row.source, source_id: row.source_id, region: row.region },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.course?.name) throw new Error("discover_failed");
      window.location.href = "score.html?course=" + encodeURIComponent(data.course.name);
    } catch {
      setOpening("");
      setOpenError("Could not open that course right now.");
    }
  }

  const combined = React.useMemo(
    () => mergeDiscoveredCourses(result.courses || [], nearby.courses),
    [result.courses, nearby.courses],
  );
  const term = query.trim().toLowerCase();
  const origin = loc.origin;
  const maxMeters = (nearby.miles || 50) * 1609.344;
  let matches = [];
  if (term) {
    matches = combined
      .filter((row) => [row.name, row.location].join(" ").toLowerCase().includes(term))
      .map((row) => ({ row, meters: origin ? distanceMeters(origin, row) : Infinity }))
      .sort((a, b) => a.meters - b.meters || String(a.row.name || "").localeCompare(String(b.row.name || "")))
      .slice(0, 8);
  } else if (origin) {
    matches = combined
      .map((row) => ({ row, meters: distanceMeters(origin, row) }))
      .filter(({ meters }) => Number.isFinite(meters) && (nearby.status !== "ready" || meters <= maxMeters))
      .sort((a, b) => a.meters - b.meters || String(a.row.name || "").localeCompare(String(b.row.name || "")))
      .slice(0, 8);
  }
  const showExternalNote = matches.some(({ row }) => row.external);

  return h("details", { className: "player-card member-course-search", onToggle: (event) => setOpen(event.currentTarget.open) }, [
    h("summary", { key: "summary" }, h(MapPin, { size: 18, "aria-hidden": true }), "Find a course"),
    h("label", { className: "player-play-join", key: "search" }, [
      "Course name or town", h("input", { className: "form-input", type: "search", key: "input", value: query, onChange: (event) => setQuery(event.target.value) }),
    ]),
    h("div", { className: "member-course-tools", key: "tools" }, [
      h("button", {
        className: "dashboard-action",
        type: "button",
        key: "locate",
        "aria-pressed": Boolean(origin),
        disabled: loc.status === "locating",
        onClick: toggleLocation,
      }, loc.status === "locating" ? "Finding location…" : origin ? "Clear location" : "Use my location"),
    ]),
    loc.status === "unavailable" ? h("p", { className: "dash-note", role: "status", key: "locErr" }, "Location unavailable.") : null,
    origin && nearby.status === "loading" ? h("p", { className: "dash-note", role: "status", key: "nearbyLoad" }, "Finding courses near your location…") : null,
    origin && nearby.status === "error" ? h("p", { className: "dash-note", role: "status", key: "nearbyErr" }, "Could not check courses outside the club catalog.") : null,
    openError ? h("p", { className: "dash-note", role: "alert", key: "openErr" }, openError) : null,
    matches.length ? h("ul", { className: "member-search-matches", key: "matches" }, matches.map(({ row, meters }) => {
      const sub = [row.location, Number.isFinite(meters) ? formatDistance(meters) : ""].filter(Boolean).join(" · ");
      return h("li", { key: row.id },
        row.external
          ? h("button", {
            className: "member-search-pick",
            type: "button",
            disabled: Boolean(opening),
            onClick: () => { void openExternalCourse(row); },
          }, [
            h("span", { key: "copy" }, h("strong", null, opening === String(row.id) ? `Opening ${row.name}…` : row.name), sub ? h("small", null, sub) : null),
            h(ChevronRight, { size: 17, "aria-hidden": true, key: "chevron" }),
          ])
          : h("a", { href: "score.html?course=" + encodeURIComponent(row.name) }, [
            h("span", { key: "copy" }, h("strong", null, row.name), sub ? h("small", null, sub) : null),
            h(ChevronRight, { size: 17, "aria-hidden": true, key: "chevron" }),
          ]),
      );
    })) : result.error ? h("div", { className: "member-subactions", key: "status" }, [
      h("p", { className: "dash-note", role: "alert", key: "error" }, "Courses couldn’t load."),
      h("button", { className: "dashboard-action", type: "button", key: "retry", onClick: () => {
        setResult({ courses: null, error: false });
        loadAgain();
      } }, "Try again"),
    ]) : (term || (origin && nearby.status === "ready"))
      ? h("p", { className: "dash-note", role: "status", key: "status" }, result.courses ? "No matching courses." : "Loading courses…")
      : null,
    showExternalNote ? h("p", { className: "player-card-meta", key: "attr" }, "Course data supplied by DiscGolfAPI.") : null,
  ]);
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

  return h("section", { className: "player-card member-join", "data-react-play-join": "ready" }, [
    h("h2", { key: "title" }, "Join or watch"),
    h("p", { className: "player-card-meta", key: "copy" }, "Enter the round code to join a card. For private rounds, use the shared watch link to watch."),
    h("div", { className: "player-play-join", key: "form" }, [
      h("label", { className: "player-play-label", htmlFor: "playJoinCode", key: "label" }, "Round code"),
      h("input", {
        autoCapitalize: "characters",
        autoCorrect: "off",
        className: "player-play-code",
        id: "playJoinCode",
        "aria-invalid": error ? "true" : undefined,
        "aria-describedby": error ? "playJoinError" : undefined,
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
      error ? h("p", { className: "player-card-meta player-play-error", id: "playJoinError", role: "alert", key: "error" }, error) : null,
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
        status === "loading" ? "Checking imported rounds…" : "Import a scorecard export and the scoring shows up here."),
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

export function UdiscHistory({ token }) {
  const context = useMemberContext();
  if (historyLocked(context)) return h(MembershipNeeded, { what: "UDisc history" });
  return h(UdiscHistoryBody, { token });
}

function UdiscHistoryBody({ token }) {
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
        if (err.name !== "AbortError") setState((prev) => ({ status: "error", rounds: prev.rounds, stats: prev.stats }));
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
      busy ? "Working…" : "Import CSV",
      h("input", {
        accept: ".csv,text/csv",
        disabled: busy,
        key: "file",
        type: "file",
        onChange: onFile,
      }),
    ]),
    error ? h("p", { className: "player-card-meta player-play-error", role: "alert", key: "error" }, error) : null,
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
      : h("p", { className: state.status === "error" ? "player-card-meta player-play-error" : "player-card-meta", key: "empty", role: state.status === "error" ? "alert" : undefined },
        state.status === "loading" ? "Checking imported rounds…" : state.status === "error" ? "Could not load UDisc history." : "No UDisc rounds imported yet."),
    ]),
  ]);
}

function PlayHistory(props) {
  const context = useMemberContext();
  if (historyLocked(context)) return h(MembershipNeeded, { what: "Your recent rounds" });
  return h(PlayHistoryBody, props);
}

function PlayHistoryBody({ token }) {
  const [state, setState] = React.useState({ status: token ? "loading" : "idle", items: [], handicaps: [] });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", items: [], handicaps: [] });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", items: [], handicaps: [] });
    requestJson("/my-results?all=1", { token, signal: controller.signal })
      .then((data) => {
        const casual = data?.casual;
        const combined = [...(Array.isArray(casual) ? casual : []), ...(Array.isArray(data?.results) ? data.results : [])];
        setState({ status: "ready", items: recentPlayRounds(casual), handicaps: myLayoutHandicaps(combined) });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "error", items: [], handicaps: [] });
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
        : h("p", { className: state.status === "error" ? "player-card-meta player-play-error" : "player-card-meta", key: "empty", role: state.status === "error" ? "alert" : undefined },
          state.status === "loading" ? "Checking finished rounds…" : state.status === "error" ? "Could not load club handicap." : "No handicap yet."),
    ]),
    h("section", { className: "player-card", "data-react-play-recent": state.status, key: "recent" }, [
      h("h3", { key: "title" }, "Recent rounds"),
      state.items.length
        ? h("div", { className: "live-round-list", key: "list" }, state.items.map((item) =>
          h(RecentRoundCard, { item, key: item.code })))
        : h("p", { className: state.status === "error" ? "player-card-meta player-play-error" : "player-card-meta", key: "empty", role: state.status === "error" ? "alert" : undefined },
          state.status === "loading" ? "Looking up finished cards…" : state.status === "error" ? "Could not load recent rounds." : "No finished rounds yet."),
    ]),
  ]);
}

export function MemberPlayPage() {
  const token = storageGet(TOKEN_KEY);
  return h("div", { className: "react-play-page player-play member-subpage member-play-surface", "data-react-play-page": token ? "ready" : "guest" }, [
    h("div", { className: "member-play-entry", key: "entry" }, [
      h("a", { className: "player-keep-score member-round-hero", href: "score.html?start=1", key: "start" }, [
        h("div", { className: "member-round-copy", key: "copy" }, [
          h("h2", { key: "title" }, "Start a round"),
          h("p", { key: "meta" }, "Create a casual scorecard and share its code."),
        ]),
        h("span", { className: "member-round-arrow", key: "go" }, h(ArrowRight, { size: 23, "aria-hidden": true })),
      ]),
      h(PlayJoinCard, { key: "join" }),
    ]),
    token ? h("nav", { className: "member-subactions member-play-tools", "aria-label": "Play tools", key: "practice-tools" }, [
      h(MoreLink, { tab: "practice", className: "dashboard-action", key: "practice" }),
      h(MoreLink, { tab: "my-bag", className: "dashboard-action", key: "bag" }),
      h(MoreLink, { tab: "course-discovery", className: "dashboard-action", key: "discovery" }),
    ]) : null,
    token ? h(LiveScoringPanel, { token, variant: "play", key: "live" }) : null,
    h(CourseSearch, { key: "courses" }),
    h(CourseTrafficCard, { key: "traffic" }),
    token ? h(PlayHistory, { token, key: "history" }) : null,
    token ? h(MoreLink, { tab: "imports", className: "dashboard-action", key: "udisc" }) : null,
  ]);
}
