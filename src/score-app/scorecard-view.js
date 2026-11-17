import React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ClipboardList, Eye, Link2, ListChecks, Lock, Ruler, Settings2, Share2, UserPlus, Watch, X } from "lucide-react";
import { useAccessibleDialog } from "../shared/a11y.js";
import { HoleMap } from "../shared/hole-map.js";
import { addThrow, currentRangeHud, GPS_WATCH_OPTIONS, gpsErrorPolicy, gpsHudPrompt, lastThrow, lastThrowHud, nextTeeHud, HOLE_MAP_COMPACT_SIZE, remainingFt, resolveMapFocus, undoThrow, withSelfLocation } from "../shared/hole-map-model.js";
import { preloadRoundMaps } from "../shared/satellite-preload.js";
import { formatPct, holePlayStats, holeStatChips, liveRoundStatsFromCard } from "../shared/play-stats.js";
import { PotsStrip } from "./pots-strip.js";
import { WeatherStrip } from "./weather-strip.js";
import { nextHoleScore, nextPuttingScore, puttingStationRows, relClass, relText, strokeLabel } from "./score-view-model.js";
import { RoundHighlights, ThrowFilm, useClipRecovery } from "./throw-film.js";
import { RoundTalk } from "./round-talk.js";
import { WristScore } from "./wrist-score.js";
import { RoundSharing, WatchSharingDetails } from "./round-sharing.js";
import { WatchPairing } from "./watch-pairing.js";
import { PhoneActivityPairing } from "../shared/phone-activity-view.js";
import { ShotLedgerPanel } from "./shot-ledger-view.js";
import { closeRangeLock, postRangeLock, rangeLockChanged, rangeLockNote, readRangeLockEnabled, writeRangeLockEnabled } from "../shared/range-lock.js";

const h = React.createElement;

function icon(Icon) {
  return h(Icon, {
    key: "icon",
    size: 16,
    strokeWidth: 2.4,
    "aria-hidden": "true",
    focusable: "false",
  });
}

function JoinRequestBanner(props) {
  const rows = Array.isArray(props.requests) ? props.requests.filter((request) => request && request.id) : [];
  if (!rows.length || typeof props.onApprove !== "function") return null;
  return h("div", { className: "card join-requests", "data-join-requests": "true", key: "join-requests" }, rows.map((request) => h("div", { className: "join-request", key: request.id }, [
    h("p", { key: "name" }, request.name + " wants to join this card."),
    h("button", { className: "btn", key: "yes", type: "button", onClick: () => props.onApprove(request.id) }, "Approve"),
    typeof props.onDecline === "function"
      ? h("button", { className: "btn secondary", key: "no", type: "button", onClick: () => props.onDecline(request.id) }, "Not now")
      : null,
  ])));
}

function HoleStatChips(props) {
  const chips = Array.isArray(props.chips) ? props.chips : [];
  if (!chips.length) return null;
  return h("div", { className: "hole-stat-chips", key: "stats" }, chips.map((chip) =>
    h("span", {
      className: "hole-stat-chip " + (chip.hit ? "hit" : "miss"),
      key: chip.id,
    }, chip.label),
  ));
}

export function visibleBottomOverlap(innerHeight, offsetTop, viewportHeight) {
  const inner = Number(innerHeight);
  const top = Number(offsetTop);
  const height = Number(viewportHeight);
  if (!Number.isFinite(inner) || !Number.isFinite(top) || !Number.isFinite(height)) return 0;
  return Math.max(0, Math.round(inner - top - height));
}

function useVisibleBottomInset() {
  React.useEffect(() => {
    const root = document.documentElement;
    function apply() {
      const viewport = window.visualViewport;
      const overlap = viewport
        ? visibleBottomOverlap(window.innerHeight, viewport.offsetTop, viewport.height)
        : 0;
      root.style.setProperty("--score-nav-bottom", overlap + "px");
    }
    apply();
    window.addEventListener("resize", apply);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", apply);
      window.visualViewport.addEventListener("scroll", apply);
    }
    return () => {
      root.style.removeProperty("--score-nav-bottom");
      window.removeEventListener("resize", apply);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", apply);
        window.visualViewport.removeEventListener("scroll", apply);
      }
    };
  }, []);
}

const SHORT_SCORE_DOCK = "(orientation: portrait) and (max-height: 560px)";

function useShortScoreDock() {
  const [short, setShort] = React.useState(() => window.matchMedia(SHORT_SCORE_DOCK).matches);
  React.useEffect(() => {
    const query = window.matchMedia(SHORT_SCORE_DOCK);
    function update() { setShort(query.matches); }
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return short;
}

function liveStatSample(mine) {
  if (!mine || !mine.att) return "—";
  return mine.hit + "/" + mine.att;
}

function LiveMixLegend(props) {
  const rows = Array.isArray(props.rows) ? props.rows : [];
  return h("div", {
    className: "live-stats-mix-legend" + (props.dashboard ? " score-outcomes" : ""),
    role: props.dashboard ? "region" : undefined,
    "aria-label": props.dashboard ? "Scoring outcomes" : undefined,
  }, rows.map((row) =>
    h("div", {
      className: "live-stats-mix-item" + (row.tone ? " tone-" + row.tone : ""),
      key: row.id,
    }, [
      h("span", { className: "live-stats-k", key: "k" }, props.dashboard ? row.label : row.short || row.label),
      h("b", { key: "v" }, String(row.mine.hit)),
    ]),
  ));
}

function ScoreAdvancedStats(props) {
  const [open, setOpen] = React.useState(false);
  const stats = props.stats;
  if (!stats) return null;
  const rows = Array.isArray(stats.throwStats) ? stats.throwStats : [];
  return h("div", { className: "score-advanced" + (open ? " open" : "") }, [
    h(LiveMixLegend, { key: "outcomes", dashboard: true, rows: stats.mix }),
    h("div", { className: "score-advanced-bar", key: "bar" }, [
      h("span", { key: "label" }, "Advanced stats"),
      h("button", {
        "aria-controls": "score-advanced-stats",
        "aria-expanded": open ? "true" : "false",
        "aria-label": open ? "Minimize advanced stats" : "Expand advanced stats",
        className: "score-advanced-toggle",
        key: "toggle",
        type: "button",
        onClick: () => setOpen((current) => !current),
      }, [
        h("span", { key: "label" }, open ? "Minimize" : "Expand"),
        icon(open ? ChevronUp : ChevronDown),
      ]),
    ]),
    open ? h("div", { className: "live-stats-grid score-advanced-grid", id: "score-advanced-stats", key: "grid" }, rows.map(LiveStatTile)) : null,
  ]);
}

function LiveStatTile(row) {
  return h("div", {
    className: "live-stat-tile" + (row.tone ? " tone-" + row.tone : ""),
    key: row.id,
  }, [
    h("span", { className: "live-stats-k", key: "k" }, row.short || row.label),
    h("b", { key: "v" }, row.mine.att ? formatPct(row.mine.pct) : "—"),
    h("small", { key: "s" }, liveStatSample(row.mine)),
  ]);
}

function LiveMixBar(props) {
  const parts = (Array.isArray(props.rows) ? props.rows : []).filter((row) => row && row.mine && row.mine.hit > 0);
  if (!parts.length) {
    return h("div", {
      "aria-hidden": "true",
      className: "live-stats-mix empty",
    });
  }
  const label = parts.map((row) => (row.short || row.label) + " " + row.mine.hit).join(", ");
  return h("div", {
    "aria-label": label,
    className: "live-stats-mix",
    role: "img",
  }, parts.map((row) =>
    h("span", {
      className: "live-stats-mix-seg tone-" + (row.tone || "par"),
      key: row.id,
      style: { flexGrow: Math.max(row.mine.hit, 1) },
      title: (row.short || row.label) + " " + row.mine.hit,
    }),
  ));
}

function PlayingRating(props) {
  if (props.rating == null) return null;
  const delta = props.delta;
  const tone = delta == null ? "" : delta > 0 ? " up" : delta < 0 ? " down" : "";
  const deltaText = delta == null ? null : delta > 0 ? "+" + delta : String(delta);
  return h("div", { className: "live-stats-rating" }, [
    h("span", { className: "live-stats-k", key: "k" }, "Playing"),
    h("b", { key: "v" }, String(props.rating)),
    deltaText != null ? h("span", { className: "live-stats-rating-delta" + tone, key: "d" }, deltaText) : null,
  ]);
}

function LivePuttingStations(props) {
  const stations = Array.isArray(props.stations) ? props.stations : [];
  if (!stations.length) return null;
  return h("div", { className: "live-stats-stations" }, stations.map((station) => {
    const made = station.made == null ? "—" : String(station.made);
    const attempts = station.attempts == null ? "—" : String(station.attempts);
    const score = station.stationScore == null ? "—" : String(station.stationScore) + " pts";
    return h("div", {
      className: "live-stats-mix-item live-stats-station",
      key: station.hole,
      title: station.label + " " + made + "/" + attempts + ", " + score,
    }, [
      h("span", { className: "live-stats-k", key: "k" }, station.label),
      h("b", { key: "v" }, made + "/" + attempts),
      h("small", { key: "s" }, score),
    ]);
  }));
}

function LiveRoundStats(props) {
  const putting = props.putting === true;
  const stations = putting ? puttingStationRows(props.holes, props.holeGrid) : [];
  const view = props.stats;
  const holeCount = Array.isArray(props.holes) && props.holes.length
    ? props.holes.length
    : (Array.isArray(props.holeGrid) ? props.holeGrid.length : 0);
  const thru = putting
    ? stations.filter((station) => station.made != null).length
    : view.totals.holes;
  const hasThrows = !putting && view.throwStats.some((row) => row.mine && row.mine.att);
  const eligible = view?.totals.shot_eligible_holes;
  const matched = view?.totals.shot_count_matched_holes;
  const recorded = view?.totals.shot_verified_holes;
  const incomplete = view?.totals.shot_incomplete_holes;
  const hint = putting
    ? null
    : eligible > 0 ? [`Recorded shots on ${recorded} of ${eligible} scored holes.`,
      matched > 0 ? `Marked-lie estimates on ${matched}.` : "", incomplete > 0 ? `${incomplete} incomplete.` : ""].filter(Boolean).join(" ")
    : thru
      ? (hasThrows ? null : "Mark lies for fairways, C1, and putting")
      : "Score holes and mark lies — mix, FIR, C1, and putting fill in live.";
  return h("section", {
    "aria-label": "Live round stats",
    "aria-live": "polite",
    className: "live-round-stats",
  }, [
    h("div", { className: "live-round-stats-head", key: "head" },
      h("div", { className: "live-round-stats-copy" }, [
        h("div", { className: "live-round-stats-title", key: "title" }, "Live stats"),
        h("div", { className: "live-round-stats-meta", key: "meta" },
          `${props.formatLabel || "Singles · Stroke"} · Thru ${thru}/${holeCount}`),
      ])),
    putting ? null : h(PlayingRating, { delta: props.playingDelta, key: "rating", rating: props.playingRating }),
    h("div", { className: "live-stats-body", key: "body" }, putting
      ? h(LivePuttingStations, { stations })
      : [
        h("div", { className: "live-stats-mix-wrap", key: "mix" }, [
          h(LiveMixBar, { key: "bar", rows: view.mix }),
          h(LiveMixLegend, { key: "legend", rows: view.mix }),
        ]),
        h("div", { className: "live-stats-grid", key: "grid" }, view.throwStats.map(LiveStatTile)),
        hint ? h("p", { className: "live-stats-hint", key: "hint" }, hint) : null,
      ]),
  ]);
}

function RoundToolActions(props) {
  const showManage = Boolean(props.show);
  const [copied, setCopied] = React.useState(false);
  function copyWatch() {
    if (typeof props.onWatchShare === "function") props.onWatchShare();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return h("div", { className: "score-glove-tools", key: "round-tools" }, [
    props.onShare && h(
      "button",
      {
        "aria-label": "Share scorecard",
        className: "score-glove-tool",
        key: "share",
        title: "Share scorecard",
        type: "button",
        onClick: props.onShare,
      },
      [icon(Share2), h("span", { key: "label" }, "Share")],
    ),
    props.onShareCode
      ? h("button", {
        "aria-label": "Invite to score",
        className: "score-glove-tool" + (copied ? " active" : ""),
        key: "invite",
        title: "Invite to score",
        type: "button",
        onClick: () => {
          props.onShareCode();
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        },
      }, [
        icon(Link2),
        h("span", { key: "label" }, copied ? "Shared" : "Invite"),
      ])
      : props.onWatchShare
      ? h("button", {
        "aria-label": "Copy watch link",
        className: "score-glove-tool" + (copied ? " active" : ""),
        key: "watch",
        title: "Copy watch link",
        type: "button",
        onClick: copyWatch,
      }, [
        icon(Link2),
        h("span", { key: "label" }, copied ? "Copied" : "Copy link"),
      ])
      : null,
    showManage
      ? h(
        "button",
        {
          "aria-label": "Add player",
          className: "score-glove-tool",
          key: "add",
          title: "Add player",
          type: "button",
          onClick: props.onAddPlayer,
        },
        [icon(UserPlus), h("span", { key: "label" }, "Add")],
      )
      : null,
    !props.putting && h(
      "button",
      {
        "aria-label": props.measureLabel || "Measure",
        "aria-pressed": props.measuring ? "true" : "false",
        className: "score-glove-tool" + (props.measuring ? " active" : ""),
        key: "measure",
        title: props.measureLabel || "Measure",
        type: "button",
        onClick: props.onMeasure,
      },
      [icon(Ruler), h("span", { key: "label" }, props.measureLabel || "Measure")],
    ),
    h(
      "button",
      {
        "aria-label": "Open wrist layout",
        "aria-pressed": props.wrist ? "true" : "false",
        className: "score-glove-tool" + (props.wrist ? " active" : ""),
        key: "wrist",
        title: "Wrist layout",
        type: "button",
        onClick: props.onWrist,
      },
      [icon(Watch), h("span", { key: "label" }, "Wrist layout")],
    ),
    h(
      "button",
      {
        "aria-label": props.rangeLockOn ? "Distance alerts on" : "Turn on distance alerts",
        "aria-pressed": props.rangeLockOn ? "true" : "false",
        className: "score-glove-tool" + (props.rangeLockOn ? " active" : ""),
        key: "lock",
        title: "Distance alerts",
        type: "button",
        onClick: props.onToggleLock,
      },
      [icon(Lock), h("span", { key: "label" }, props.rangeLockOn ? "Distance alerts on" : "Distance alerts")],
    ),
    showManage
      ? h("button", { className: "score-glove-tool", key: "manage", type: "button", onClick: props.onManagePlayers }, [
        icon(Settings2),
        h("span", { key: "label" }, "Manage"),
      ])
      : null,
  ]);
}

function RoundTools(props) {
  const [open, setOpen] = React.useState(false);
  const [shots, setShots] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [details, setDetails] = React.useState(false);
  const titleId = React.useId();
  const titleRef = React.useRef(null);
  const ledgerButton = React.useRef(null);
  const detailsButton = React.useRef(null);
  function close() { setShots(false); setSharing(false); setDetails(false); setOpen(false); }
  function openSharing() {
    if (props.roundSharingApi) { setSharing(true); setOpen(true); }
    else props.onWatchShare?.();
  }
  const dialog = useAccessibleDialog({ open, onClose: close, labelledBy: titleId, label: "Round tools" });
  const closeThen = (action) => (...args) => { close(); action?.(...args); };
  function openLedger() {
    setShots(true);
    void props.onRefreshShots?.();
    requestAnimationFrame(() => titleRef.current?.focus());
  }
  function backFromLedger() {
    setShots(false);
    requestAnimationFrame(() => ledgerButton.current?.focus());
  }
  function openDetails() {
    setDetails(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  }
  function backFromDetails() {
    setDetails(false);
    requestAnimationFrame(() => detailsButton.current?.focus());
  }
  return h(React.Fragment, null,
    h("div", { className: "score-glove-tools round-quick-tools" },
      h(ThrowFilm, { hole: props.hole, offline: props.offline, putting: props.putting, recovery: props.clipDrafts, rows: props.rows, offlineRows: props.clipRows }),
      (props.roundSharingApi || props.onWatchShare) && h("button", {
        type: "button", className: "score-glove-tool", "aria-label": "Share watch link",
        "aria-haspopup": props.roundSharingApi ? "dialog" : undefined, onClick: openSharing,
      }, icon(Eye), h("span", null, "Watch link")),
      !props.offline && h(RoundTalk, {
        inline: true,
        key: "talk",
        live: true,
        players: (Array.isArray(props.rows) ? props.rows : []).map((row) => row && row.label).filter(Boolean),
        viewer: "card",
        viewerName: ((Array.isArray(props.rows) ? props.rows : []).find((row) => row && row.isMe) || {}).label || "",
      }),
      h("button", { type: "button", className: "score-glove-tool", "aria-label": "Round tools", "aria-haspopup": "dialog", onClick: () => setOpen(true) },
        icon(Settings2), h("span", null, "Tools")),
    ),
    open && createPortal(h("div", { className: "overlay", "data-a11y-overlay": "true", role: "presentation", ref: dialog.overlayRef },
      h("section", {
        className: "sheet round-tools-sheet", role: "dialog", "aria-modal": dialog.isolated ? "true" : undefined,
        "aria-labelledby": titleId, tabIndex: -1, ref: dialog.panelRef,
      },
        h("div", { className: "grab" }),
        h("h2", { id: titleId, className: "section", ref: titleRef, tabIndex: -1 }, shots ? `Shot details · Hole ${props.hole.hole}` : sharing ? "Share watch link" : details ? "Round details" : "Round tools"),
        sharing ? h(RoundSharing, { api: props.roundSharingApi, onCopyWatch: props.onCopyWatch })
          : shots ? h(React.Fragment, null,
          h(ShotLedgerPanel, { key: `${props.scorerIndex}:${props.hole.hole}`, model: props.shotLedger, score: props.ledgerScore,
            onSave: props.onSaveShots, onDiscard: props.onDiscardRecovery, getFix: props.getShotFix, enableGps: props.enableGps,
            measured: props.shotMeasurement }),
          h("button", { type: "button", className: "btn secondary", onClick: backFromLedger }, "Back to round tools"))
          : details ? h("div", { className: "round-details" },
            props.roundDetails,
            h("button", { type: "button", className: "btn secondary", onClick: backFromDetails }, "Back to round tools"))
          : h(React.Fragment, null,
            props.roundSharingApi && h(WatchSharingDetails, { api: props.roundSharingApi, onCopyWatch: props.onCopyWatch }),
            h("div", { className: "round-tools-direct" },
              h("button", { type: "button", ref: detailsButton, className: "btn secondary", onClick: openDetails },
                icon(ListChecks), "Round details"),
              props.onFullScorecard && h("button", { type: "button", className: "btn secondary", onClick: closeThen(props.onFullScorecard) },
                icon(ClipboardList), "Full scorecard"),
              props.shotLedger && h("button", { type: "button", ref: ledgerButton, className: "btn secondary", onClick: openLedger },
                icon(ListChecks), "Shot details")),
            h(ScorecardOwner, props),
            (props.onMarkTee || props.onMarkPin) && h("div", { className: "round-tools-direct", role: "group", "aria-label": "Survey this hole" },
              props.onMarkTee && h("button", { type: "button", className: "btn secondary", onClick: closeThen(props.onMarkTee) }, "Mark tee"),
              props.onMarkPin && h("button", { type: "button", className: "btn secondary", onClick: closeThen(props.onMarkPin) }, "Mark pin")),
            props.teeOrderHint && h("details", { className: "round-tools-tee-order" },
              h("summary", null, "Tee order"), h("p", null, props.teeOrderHint)),
            h(RoundToolActions, {
              ...props,
              onMeasure: closeThen(props.onMeasure), onWrist: closeThen(props.onWrist),
              onAddPlayer: closeThen(props.onAddPlayer), onManagePlayers: closeThen(props.onManagePlayers),
            }),
            props.watchApi && h(WatchPairing, { api: props.watchApi, roundCode: props.roundCode, eventId: props.eventId }),
            props.phoneActivityApi && h(PhoneActivityPairing, { api: props.phoneActivityApi, ownerId: props.phoneOwnerId, roundCode: props.roundCode, eventId: props.eventId }),
            h("p", { className: "muted round-tools-note" }, props.offline
              ? "Scores, lies, shots, and clips are saved on this device. Finished rounds can upload to your personal archive."
              : "Saved scores, lies, and shots sync when connected. Watch pairing and sharing need internet. Distance alerts update while this screen stays active.")),
        h("button", { type: "button", className: "btn secondary sheet-close", onClick: close }, "Back to round"),
      )), document.body),
  );
}

function HoleHeader(props) {
  return h("nav", { className: "hole-head", "aria-label": "Hole navigation" }, [
    h(
      "button",
      {
        "aria-label": "Previous hole",
        className: "navbtn",
        disabled: props.atStart,
        key: "prev",
        type: "button",
        onClick: props.onPrevious,
      },
      icon(ChevronLeft),
    ),
    h("div", { key: "mid", className: "hole-head-mid" }, [
      h("h2", { className: "hnum", key: "number" }, props.putting ? (props.hole.distance_ft ? `${props.hole.distance_ft} ft` : `Station ${props.hole.hole}`) : `Hole ${props.hole.hole}`),
      h("div", { className: "hpar", key: "par" }, props.holeMeta),
      props.ctpBadge ? h("div", { className: "ctp-badge", key: "ctp" }, props.ctpBadge) : null,
      props.matchStatus ? h("div", { className: "pmeta", key: "match" }, props.matchStatus) : null,
      props.dormie ? h("div", { className: "dormie-badge", key: "dormie" }, "DORMIE - win or halve this hole to close it") : null,
    ]),
    h(
      "button",
      {
        "aria-label": "Next hole",
        className: "navbtn",
        disabled: props.atEnd,
        key: "next",
        type: "button",
        onClick: props.onNext,
      },
      icon(ChevronRight),
    ),
  ]);
}

function finiteCoord(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function holeHasMap(hole) {
  const tee = hole && hole.tee;
  const basket = hole && hole.target;
  return finiteCoord(tee && tee.lat) != null && finiteCoord(tee && tee.lng) != null
    && finiteCoord(basket && basket.lat) != null && finiteCoord(basket && basket.lng) != null;
}

function useDeviceFix() {
  const [fix, setFix] = React.useState(null);
  const [status, setStatus] = React.useState("idle");
  const watchId = React.useRef(null);
  const retryTimer = React.useRef(null);
  const fixRef = React.useRef(null);
  const shotFixRef = React.useRef(null);
  const alive = React.useRef(true);

  const enableGps = React.useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }
    if (retryTimer.current != null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (watchId.current != null) {
      try { navigator.geolocation.clearWatch(watchId.current); } catch {
        /* watch may already be gone */
      }
      watchId.current = null;
    }
    setStatus((current) => (current === "ready" || fixRef.current ? "ready" : "watching"));
    function onFix(pos) {
      const lat = pos.coords && pos.coords.latitude;
      const lng = pos.coords && pos.coords.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const next = { lat, lng };
      if (Number.isFinite(pos.coords && pos.coords.accuracy)) next.accuracyM = pos.coords.accuracy;
      if (Number.isSafeInteger(pos.timestamp)) next.observedAt = pos.timestamp;
      shotFixRef.current = next;
      const prev = fixRef.current;
      // Phone GPS jitters a few meters. Repainting on every tick reloads the
      // hole picture. Keep the last fix until the phone actually moves.
      if (prev && Math.abs(prev.lat - lat) < 0.00008 && Math.abs(prev.lng - lng) < 0.00008) return;
      fixRef.current = next;
      setFix(next);
      setStatus("ready");
    }
    try {
      navigator.geolocation.getCurrentPosition(onFix, () => {}, {
        enableHighAccuracy: true,
        maximumAge: GPS_WATCH_OPTIONS.maximumAge,
        timeout: 8000,
      });
    } catch {
      /* getCurrentPosition is a kickstart; watch owns retries */
    }
    watchId.current = navigator.geolocation.watchPosition(
      onFix,
      (err) => {
        const policy = gpsErrorPolicy(err && err.code, Boolean(fixRef.current));
        if (!policy.keepFix) {
          fixRef.current = null;
          shotFixRef.current = null;
          setFix(null);
        }
        setStatus(policy.status);
        if (!policy.restart || !alive.current) return;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (alive.current) enableGps();
        }, policy.retryMs);
      },
      GPS_WATCH_OPTIONS,
    );
  }, []);

  React.useEffect(() => {
    alive.current = true;
    enableGps();
    function onResume() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // A live watch already delivers the next fix. Restarting it on every
      // focus (Android picture-in-picture does this constantly) flashes the map.
      if (watchId.current != null) return;
      enableGps();
    }
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    let permission;
    if (navigator.permissions && typeof navigator.permissions.query === "function") {
      navigator.permissions.query({ name: "geolocation" }).then((status) => {
        permission = status;
        permission.onchange = () => {
          if (permission.state !== "denied") enableGps();
        };
      }).catch(() => {});
    }
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
      if (permission) permission.onchange = null;
      if (retryTimer.current != null) clearTimeout(retryTimer.current);
      if (watchId.current != null) {
        try { navigator.geolocation.clearWatch(watchId.current); } catch {
          /* watch may already be gone */
        }
        watchId.current = null;
      }
    };
  }, [enableGps]);
  return { enableGps, fix, status, getShotFix: () => shotFixRef.current };
}

function RangeHud(props) {
  if (!props.hud) return null;
  const circleClass = props.hud.circle === "C1" ? " in-c1" : props.hud.circle === "C2" ? " in-c2" : "";
  const hasReading = props.hud.mode !== "hole";
  const prompt = gpsHudPrompt(props.gpsStatus, props.hud && props.hud.mode);
  const clickable = Boolean(prompt && props.onEnableGps);
  const nextTee = props.nextTee;
  const lastThrowLine = props.lastThrow;
  return h(clickable ? "button" : "div", {
    "aria-label": clickable ? prompt : undefined,
    "aria-live": "polite",
    className: "hole-range-hud" + circleClass + (clickable ? " hole-range-hud-btn" : ""),
    key: "range",
    role: clickable ? undefined : "status",
    type: clickable ? "button" : undefined,
    onClick: clickable ? props.onEnableGps : undefined,
  }, [
    hasReading ? h("strong", { key: "ft" }, props.hud.ft + " ft") : null,
    hasReading ? h("span", { key: "cap" }, props.hud.caption) : null,
    nextTee
      ? h("em", { className: "hole-range-hud-next", key: "next" }, nextTee.ft + " ft next tee")
      : null,
    lastThrowLine
      ? h("em", { className: "hole-range-hud-throw", key: "throw" }, lastThrowLine.ft + " ft " + lastThrowLine.caption)
      : null,
    prompt ? h("em", { className: "hole-range-hud-gps", key: "gps" }, prompt) : null,
  ]);
}

function pointReady(point) {
  return finiteCoord(point && point.lat) != null && finiteCoord(point && point.lng) != null;
}

function HoleMedia(props) {
  const [signOpen, setSignOpen] = React.useState(false);
  const [size, setSize] = React.useState(null);
  const mapRef = React.useRef(null);
  const hasMap = holeHasMap(props.hole) || pointReady(props.hole?.tee) || pointReady(props.hole?.target);
  const hasSign = Boolean(props.teeSign);
  const signId = React.useId();
  const signDialog = useAccessibleDialog({ open: signOpen && hasSign, onClose: () => setSignOpen(false), labelledBy: signId });
  React.useLayoutEffect(() => {
    const frame = mapRef.current;
    if (!frame) return;
    function measure() {
      const { width, height } = frame.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      const scale = Math.min(1, 1024 / Math.max(width, height));
      const next = { width: Math.round(width * scale), height: Math.round(height * scale) };
      setSize((current) => current?.width === next.width && current.height === next.height ? current : next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [hasMap]);
  React.useEffect(() => {
    if (!size || props.offline || !navigator.onLine) return;
    preloadRoundMaps(props.holes, { activeIndex: props.activeHoleIndex, ahead: 1, size, fitViewport: true });
  }, [size, props.holes, props.activeHoleIndex, props.offline]);
  const canSurvey = typeof props.onMarkTee === "function" || typeof props.onMarkPin === "function";
  if (!hasMap && !hasSign && !canSurvey && !props.offline) return null;
  const signButton = hasSign && h("button", {
    "aria-haspopup": "dialog",
    className: "hole-media-chip",
    key: "sign",
    type: "button",
    onClick: () => setSignOpen(true),
  }, "Tee sign");

  return h("div", {
    className: "hole-media", key: "media",
  }, [
    hasMap
      ? h("div", { className: "hole-media-map-wrap", key: "map-wrap", ref: mapRef }, [
        size && h(HoleMap, {
          compact: true,
          size,
          fitted: true,
          controlAccessory: signButton,
          focus: props.mapFocus,
          hole: props.hole,
          layoutId: props.layoutId,
          schematic: props.offline,
          hud: h(RangeHud, {
            gpsStatus: props.gpsStatus,
            hud: props.rangeHud,
            lastThrow: props.lastThrow,
            nextTee: props.nextTee,
            onEnableGps: props.onEnableGps,
          }),
          key: "map-card",
          lie: props.lie,
          measureFrom: props.measureFrom,
          measureTo: props.measureTo,
          players: withSelfLocation(props.playerLocations, props.gpsFix, props.selfMark),
          throws: props.throws,
          windFromDeg: props.windFromDeg,
          scoreFlight: props.scoreFlight,
          onFocus: props.onMapFocus,
          onMapPoint: props.onMapPoint,
          onMarkLie: props.onMarkLie,
          onUndoThrow: props.onUndoThrow,
        }),
      ])
      : h("div", { className: "hole-media-empty", key: "empty",
        style: props.offline ? { height: "auto", minHeight: 0, padding: ".55rem", rowGap: ".35rem" } : undefined }, [
        h("span", { key: "copy" }, "No map for this hole yet"),
        props.offline ? h("span", { className: "hole-media-empty-hint", key: "hint" }, "You can still score this hole.")
          : canSurvey
          ? h("span", { className: "hole-media-empty-hint", key: "hint" }, "Use Round tools to mark the tee or pin.")
          : h("span", { className: "hole-media-empty-hint", key: "hint" }, "Sign in to drop the tee and basket."),
        props.offline && typeof props.onThrows === "function" && h("div", { className: "hole-map-lie-actions", key: "offline-lies" },
          h("button", { className: "btn secondary small", type: "button", onClick: props.onMarkLie }, "Mark lie"),
          props.throws.length > 0 && h("button", { className: "btn secondary small", type: "button", onClick: props.onUndoThrow }, "Undo mark")),
      ]),
    !hasMap && signButton,
    signOpen && hasSign ? createPortal(h("div", {
      className: "overlay", "data-a11y-overlay": "true", key: "tee-sign",
      role: "presentation", ref: signDialog.overlayRef,
    }, h("section", {
      className: "sheet score-tee-sign", ref: signDialog.panelRef, role: "dialog",
      "aria-modal": signDialog.isolated ? "true" : undefined, "aria-labelledby": signId, tabIndex: -1,
    },
      h("h2", { className: "section", id: signId }, `Tee sign · Hole ${props.teeSign.hole}`),
      h("img", { alt: props.teeSign.alt, src: props.teeSign.src, width: 640, height: 400,
        style: props.teeSign.highlightColor ? { outlineColor: props.teeSign.highlightColor } : undefined }),
      h("button", { className: "btn secondary sheet-close", type: "button", onClick: () => setSignOpen(false) }, "Close tee sign"),
    )), document.body) : null,
  ]);
}

function ScorecardOwner(props) {
  if (!props.choices || props.choices.length <= 1) return null;
  const compact = Boolean(props.compact);
  return h("div", { className: "scorecard-owner" + (compact ? " compact" : ""), key: "owner" }, [
    compact
      ? null
      : h("label", { htmlFor: "scorecardOwner", key: "label" }, "Scorecard"),
    h(
      "select",
      {
        "aria-label": "Scorecard",
        id: compact ? "scorecardOwnerTools" : "scorecardOwner",
        key: "select",
        value: String(props.scorerIndex),
        onChange: (event) => props.onScorerChange(Number(event.target.value)),
      },
      props.choices.map((choice) =>
        h("option", { key: choice.index, value: String(choice.index) }, choice.name),
      ),
    ),
  ]);
}

function padChoices(par, putting) {
  const holePar = typeof par === "number" ? par : 3;
  if (putting) {
    const max = holePar > 0 ? holePar : 5;
    const numbers = [];
    for (let value = 0; value <= max; value += 1) numbers.push(value);
    return {
      shortcuts: [
        { label: "None", value: 0 },
        { label: "All", value: max },
      ],
      numbers,
    };
  }
  return {
    shortcuts: [
      { label: "Birdie", value: Math.max(1, holePar - 1) },
      { label: "Par", value: holePar },
      { label: "Bogey", value: holePar + 1 },
    ],
    numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  };
}

function ScorePad(props) {
  const dialog = useAccessibleDialog({
    open: true,
    onClose: props.onClose,
    labelledBy: "score-pad-title",
    label: "Enter score",
  });
  const hole = props.hole;
  const row = props.row;
  const choices = padChoices(hole.par, props.putting);
  function pick(value) {
    props.onScore(row.source, hole.hole, value);
    props.onClose();
  }
  const station = hole.distance_ft ? hole.distance_ft + " ft" : "Station " + hole.hole;
  return createPortal(
    h(
      "div",
      {
        className: "overlay",
        "data-a11y-overlay": "true",
        role: "presentation",
        ref: dialog.overlayRef,
      },
      h("div", {
        className: "sheet score-pad-sheet",
        role: "dialog",
        "aria-modal": dialog.isolated ? "true" : undefined,
        "aria-labelledby": "score-pad-title",
        "aria-label": "Enter score",
        tabIndex: -1,
        ref: dialog.panelRef,
      }, [
        h("div", { className: "grab", key: "grab" }),
        h("h2", { className: "section", id: "score-pad-title", key: "title" }, props.putting ? row.label + " · " + station : row.label + " · Hole " + hole.hole),
        h("p", { className: "muted", key: "par" }, props.putting ? hole.par + " putts · count the makes" + (Number(hole.points) > 1 ? " · " + hole.points + " pts each" : "") : "Par " + hole.par),
        h("div", { className: "score-pad-shortcuts", key: "shortcuts" }, choices.shortcuts.map((item) =>
          h("button", {
            className: "btn" + (row.currentScore === item.value ? "" : " secondary"),
            key: item.label,
            type: "button",
            onClick: () => pick(item.value),
          }, item.label + " · " + item.value),
        )),
        h("div", { className: "score-pad-grid", key: "grid" }, choices.numbers.map((value) =>
          h("button", {
            className: "score-pad-key" + (row.currentScore === value ? " current" : ""),
            key: value,
            type: "button",
            onClick: () => pick(value),
          }, String(value)),
        )),
        h("button", {
          className: "btn secondary",
          key: "clear",
          type: "button",
          onClick: () => pick(null),
        }, props.putting ? "Clear station" : "Clear hole"),
        h("button", {
          className: "btn ghost sheet-close",
          key: "close",
          type: "button",
          onClick: props.onClose,
        }, "Back"),
      ]),
    ),
    document.body,
  );
}

const SURNAME_PARTICLES = new Set(["al", "bin", "da", "de", "del", "della", "den", "der", "di", "du", "la", "le", "ter", "van", "von"]);

export function scoreNameParts(label, source) {
  if (source?.type === "pair" || source?.playerIndexes?.length > 1) return null;
  if (typeof label !== "string") return null;
  const words = label.trim().split(/\s+/);
  if (words.length < 2) return null;

  let surname = words.length - 1;
  if (surname > 1 && /^(?:jr|sr|ii|iii|iv|v)\.?$/i.test(words[surname])) surname -= 1;
  while (surname > 1 && SURNAME_PARTICLES.has(words[surname - 1].toLowerCase())) surname -= 1;
  return { given: words.slice(0, surname).join(" "), surname: words.slice(surname).join(" ") };
}

function ScorePlayerName({ row }) {
  const parts = scoreNameParts(row.label, row.source);
  return h("div", { className: "pname", title: row.label }, parts ? [
    h("span", { className: "score-name-full", key: "full" }, row.label),
    h("span", { className: "score-name-compact", "aria-hidden": "true", key: "compact" }, [
      h("span", { className: "score-name-given", key: "given" }, parts.given),
      h("strong", { className: "score-name-surname", key: "surname" }, parts.surname),
    ]),
  ] : row.label);
}

function ScoreRow(props) {
  const row = props.row;
  const current = row.currentScore;
  const nextMinus = props.putting ? nextPuttingScore(current, props.hole.par, "minus") : nextHoleScore(current, props.hole.par, "minus");
  const nextPlus = props.putting ? nextPuttingScore(current, props.hole.par, "plus") : nextHoleScore(current, props.hole.par, "plus");
  const classes = ["prow"];
  if (row.conflictText) classes.push("conflict");
  if (row.honors) classes.push("honors");
  const teeLabel = row.honors
    ? `${row.label} has honors, throws first`
    : row.teePosition
      ? `${row.label} throws ${row.teePosition}`
      : null;
  return h("div", { className: classes.join(" "), key: row.key }, [
    row.teePosition
      ? h("div", { "aria-label": teeLabel, className: "tee-pos", key: "tee" }, String(row.teePosition))
      : null,
    h("div", { className: "pinfo", key: "info" }, [
      h(ScorePlayerName, { row, key: "name" }),
      row.meta ? h("div", { className: "pmeta", key: "meta" }, row.meta) : null,
      row.conflictText ? h("div", { className: "pmeta conflict-text", key: "conflict" }, row.conflictText) : null,
      row.conflictValues && row.conflictValues.length
        ? h("div", { className: "conflict-picks", key: "picks" }, row.conflictValues.map((value) =>
          h("button", {
            className: "btn small",
            disabled: Boolean(props.locked),
            key: value,
            type: "button",
            onClick: () => props.onScore(row.source, props.hole.hole, value),
          }, "Use " + value),
        ))
        : null,
    ]),
    h("div", { className: "stepper", key: "stepper" }, [
      h(
        "button",
        {
          "aria-label": nextMinus == null
            ? `Clear ${row.label} on hole ${props.hole.hole}`
            : current == null
              ? `Set ${row.label} on hole ${props.hole.hole} to ${nextMinus}`
              : `Decrease ${row.label} on hole ${props.hole.hole}`,
          className: "minus",
          disabled: Boolean(props.locked),
          type: "button",
          onClick: () => props.onScore(row.source, props.hole.hole, nextMinus, "minus"),
        },
        "-",
      ),
      h("button", {
        "aria-label": `Enter score for ${row.label} on hole ${props.hole.hole}`,
        className: "val",
        disabled: Boolean(props.locked),
        key: "value",
        type: "button",
        onClick: () => props.onOpenPad(row),
      }, [
        h("div", { className: "n", key: "score" }, current == null ? "-" : String(current)),
        row.relative ? h("div", { className: `rel ${row.relative.className}`, key: "relative" }, row.relative.text) : null,
      ]),
      h(
        "button",
        {
          "aria-label": `Increase ${row.label} on hole ${props.hole.hole}`,
          className: "plus",
          disabled: Boolean(props.locked),
          type: "button",
          onClick: () => props.onScore(row.source, props.hole.hole, nextPlus, "plus"),
        },
        "+",
      ),
    ]),
  ]);
}

function TotalsBar(props) {
  if (!props.totals || !props.totals.length) return null;
  return h(
    "div",
    { className: "totbar", key: "totals" },
    props.totals.map((item) =>
      h("div", { key: item.label }, [
        h("div", { className: "k", key: "label" }, item.label),
        h("div", { className: "v", key: "value" }, item.value),
      ]),
    ),
  );
}

function HoleGrid(props) {
  const holes = Array.isArray(props.holes) ? props.holes : [];
  const scroller = React.useRef(null);
  const current = holes.find((hole) => hole.current);
  React.useEffect(() => {
    const root = scroller.current;
    if (!root || !current) return;
    const button = root.querySelector(".cur");
    if (button && root.scrollWidth > root.clientWidth) {
      const offset = button.getBoundingClientRect().left - root.getBoundingClientRect().left;
      root.scrollLeft += offset - (root.clientWidth - button.offsetWidth) / 2;
    }
  }, [current && current.hole]);
  if (!holes.length) return null;
  return h("div", { className: "score-holestrip", key: "strip" }, h(
    "div",
    { className: "holegrid", key: "grid", ref: scroller },
    holes.map((hole) => {
      const rel = hole.relative;
      const classes = [
        hole.current ? "cur" : "",
        hole.done ? "done" : "",
        hole.conflict ? "conflict" : "",
        hole.ctp ? "ctp" : "",
        rel ? rel.className : "",
      ].filter(Boolean).join(" ");
      const station = hole.distanceFt ? `${hole.distanceFt} ft` : `Station ${hole.hole}`;
      const label = props.putting
        ? (hole.score != null ? `${station}, ${hole.score} makes` : station)
        : rel
        ? `Hole ${hole.hole}, ${rel.text} ${hole.score}`
        : hole.score != null
          ? `Hole ${hole.hole}, ${hole.score}`
          : `Hole ${hole.hole}`;
      return h(
        "button",
        {
          "aria-current": hole.current ? "true" : undefined,
          "aria-label": label,
          className: classes,
          key: hole.hole,
          type: "button",
          onClick: () => props.onJump && props.onJump(hole.index),
        },
        [
          h("span", { className: "holegrid-num", key: "num" }, props.putting && hole.distanceFt ? String(hole.distanceFt) : String(hole.hole)),
          hole.score != null
            ? h("b", { className: "holegrid-score", key: "score" }, String(hole.score))
            : h("span", { className: "holegrid-empty", key: "empty" }, "·"),
          rel ? h("span", { className: "holegrid-rel", key: "rel" }, rel.text) : null,
        ],
      );
    }),
  ));
}

function CtpClaim(props) {
  const claim = props.ctpClaim;
  if (!claim || !claim.ctps || !claim.ctps.length) return null;
  const canVote = typeof props.onCtpVote === "function";
  return h("div", { className: "card ctp-claim", key: "ctp-claim" }, claim.ctps.map((ctp) => {
    const nominees = Array.isArray(ctp.nominees) ? ctp.nominees : (claim.nominees || []);
    const status = ctp.agreed
      ? (ctp.nomineeName || "this card") + " is this card's CTP"
      : ctp.missingNames && ctp.missingNames.length
        ? "Waiting on " + ctp.missingNames.join(", ")
        : nominees.length
          ? "Mark who is closest"
          : "No one on this card is in this CTP";
    const leader = ctp.leaderName ? "Live leader: " + ctp.leaderName : "No live CTP yet";
    return h("div", { className: "ctp-claim-block", key: ctp.id || ctp.hole }, [
      h("div", { className: "ctp-claim-title", key: "title" }, "CTP hole " + ctp.hole + (ctp.division ? " · " + ctp.division : "")),
      h("div", { className: "ctp-claim-leader", key: "leader" }, leader),
      h("div", { className: "muted", key: "status" }, status + (ctp.needed ? " (" + ctp.voted + "/" + ctp.needed + ")" : "")),
      canVote && nominees.length
        ? h("div", { className: "ctp-claim-picks", key: "picks" }, nominees.map((nominee) =>
          h("button", {
            className: "btn small" + (ctp.myVote === nominee.index ? " ctp-picked" : " secondary"),
            disabled: ctp.myVote === nominee.index,
            key: nominee.index,
            type: "button",
            onClick: () => props.onCtpVote(ctp, nominee.index),
          }, nominee.label),
        ))
        : null,
    ]);
  }));
}

function ScorecardBox(props) {
  const rows = Array.isArray(props.rows) ? props.rows : [];
  return h("div", { className: "score-entry-card", key: "scorecard" }, [
    props.warning ? h("p", { className: "muted auth-error", key: "warning" }, props.warning) : null,
    rows.map((row) => h(ScoreRow, {
      hole: props.hole,
      key: row.key,
      locked: props.finish && props.finish.locked,
      putting: props.putting,
      row,
      onOpenPad: props.onOpenPad,
      onScore: props.onScore,
    })),
    h(TotalsBar, { totals: props.totals }),
  ]);
}

const FINISH_COPY = "Anyone on this card can confirm. Matching scores on each hole are enough.";

function FinishCard(props) {
  const finish = props.finish;
  if (!finish) return null;
  if (finish.locked) {
    return h("div", { className: "finalize-card ready", key: "finish" }, [
      h("p", { className: "finalize-head", key: "head" }, finish.status === "final" ? "Round finished — scores are locked" : "Card submitted — scores locked"),
      h("button", {
        className: "btn finish-round-btn",
        key: "share",
        type: "button",
        onClick: props.onShare,
      }, "Share card"),
    ]);
  }
  return null;
}

function FinishDockBar(props) {
  const finish = props.finish;
  if (!finish || finish.locked) return null;
  if (finish.canFinish && typeof props.onOpenFinish === "function") {
    return h("div", { className: "score-glove-finish", key: "finish-bar" }, h("button", {
      className: "btn finish-round-btn",
      type: "button",
      onClick: props.onOpenFinish,
    }, "Finish card"));
  }
  let blocker = finish.blocker;
  if (blocker && blocker.kind === "missing") {
    const skipped = Array.isArray(finish.skipped) && finish.skipped.length ? finish.skipped : [blocker];
    blocker = skipped.find((row) => row && !props.dismissed[row.hole]) || null;
  }
  if (!blocker) return null;
  const jump = h("button", {
    className: "btn secondary finish-round-btn",
    key: "jump",
    type: "button",
    onClick: () => props.onJump && props.onJump(blocker.index),
  }, blocker.text);
  if (blocker.kind !== "missing") {
    return h("div", { className: "score-glove-finish", key: "finish-bar" }, jump);
  }
  return h("div", { className: "score-glove-finish", key: "finish-bar" }, [
    jump,
    h("button", {
      "aria-label": "Dismiss",
      className: "score-glove-finish-dismiss",
      key: "dismiss",
      type: "button",
      onClick: () => props.onDismiss(blocker.hole),
    }, icon(X)),
  ]);
}

function ConfirmScoresSheet(props) {
  const finish = props.finish;
  const open = Boolean(finish && finish.confirmOpen && !finish.locked);
  const dialog = useAccessibleDialog({
    open,
    onClose: props.onCloseFinish,
    labelledBy: "score-confirm-title",
    label: "Confirm scores",
  });
  if (!open) return null;
  const putting = props.putting === true;
  const review = finish.review || { holes: [], rows: [], voters: [], waiting: [] };
  const grid = Array.isArray(props.holeGrid) ? props.holeGrid : [];
  const copy = props.offline ? "Review your card and save the finished round on this device." : putting
    ? "Anyone on this card can confirm. Matching makes on each station are enough."
    : FINISH_COPY;
  return createPortal(
    h(
      "div",
      {
        className: "overlay",
        key: "confirm-scores",
        "data-a11y-overlay": "true",
        role: "presentation",
        ref: dialog.overlayRef,
      },
      h("div", {
        className: "sheet confirm-scores-sheet",
        role: "dialog",
        "aria-modal": dialog.isolated ? "true" : undefined,
        "aria-labelledby": "score-confirm-title",
        "aria-label": "Confirm scores",
        tabIndex: -1,
        ref: dialog.panelRef,
      }, [
        h("div", { className: "grab", key: "grab" }),
        h("h2", { className: "section", id: "score-confirm-title", key: "title" }, "Confirm scores"),
        h("p", { className: "muted", key: "copy" }, copy),
        putting
          ? h("div", { className: "confirm-score-head", key: "head" }, [
            h("span", { key: "name" }, "Player"),
            h("span", { key: "makes" }, "Makes"),
            h("span", { key: "points" }, "Points"),
          ])
          : null,
        h("div", { className: "confirm-score-rows", key: "rows" }, review.rows.map((row) =>
          h("div", { className: "confirm-score-row", key: row.key }, putting
            ? [
              h("span", { className: "name", key: "name" }, row.label),
              h("span", { className: "tot", key: "makes" }, row.makesLabel || "—"),
              h("span", { className: "pts", key: "points" }, row.pointsLabel || "—"),
            ]
            : [
              h("span", { className: "name", key: "name" }, row.label),
              h("span", { className: "tot", key: "tot" }, String(row.total || "—")),
              h("span", { className: "tp " + relClass(row.toPar || 0), key: "par" }, relText(row.toPar || 0)),
            ]),
        )),
        grid.length
          ? h("div", { className: "confirm-holegrid holegrid" + (putting ? " is-putting" : ""), key: "grid" }, grid.map((hole) => {
            const rel = putting ? null : hole.relative;
            const classes = [
              hole.conflict ? "conflict" : "",
              rel ? rel.className : "",
            ].filter(Boolean).join(" ");
            const distance = Number(hole.distanceFt != null ? hole.distanceFt : hole.distance_ft);
            const hasDistance = Number.isFinite(distance) && distance > 0;
            const station = hasDistance ? String(distance) : String(hole.hole);
            const stationName = hasDistance ? distance + " ft" : "Station " + hole.hole;
            const attempts = Number(hole.par);
            const scoreText = hole.score == null
              ? null
              : (putting && Number.isFinite(attempts) && attempts > 0 ? hole.score + "/" + attempts : String(hole.score));
            return h("button", {
              "aria-label": putting
                ? (scoreText ? stationName + ", " + scoreText : stationName)
                : "Hole " + hole.hole,
              className: classes,
              key: hole.hole,
              type: "button",
              onClick: () => {
                if (props.onCloseFinish) props.onCloseFinish();
                if (props.onJump) props.onJump(hole.index);
              },
            }, [
              h("span", { className: "holegrid-num", key: "num" }, putting ? station : String(hole.hole)),
              scoreText
                ? h("b", { className: "holegrid-score", key: "score" }, scoreText)
                : h("span", { className: "holegrid-empty", key: "empty" }, "·"),
            ]);
          }))
          : null,
        h("button", {
          className: "btn finish-round-btn",
          key: "lock",
          disabled: props.finishing,
          type: "button",
          onClick: () => props.onAgree && props.onAgree(finish.voterIndex),
        }, props.offline ? "Save finished round" : "Looks good — lock card"),
        h("button", { className: "btn secondary sheet-close", key: "close", type: "button", onClick: props.onCloseFinish }, "Back"),
      ]),
    ),
    document.body,
  );
}

function hasRecoveryStatus(props) {
  return Boolean(props.recoveryItems?.length || props.recoveryStorageError || props.recoveryUnavailable);
}

function RecoveryStatus(props) {
  const items = props.recoveryItems || [];
  const active = hasRecoveryStatus(props);
  const [open, setOpen] = React.useState(false);
  const titleId = React.useId();
  const triggerRef = React.useRef(null);
  const dialog = useAccessibleDialog({
    open: open && active, onClose: () => setOpen(false), labelledBy: titleId,
    returnFocus: () => triggerRef.current || props.scoreRegionRef?.current,
  });
  React.useEffect(() => { if (!active) setOpen(false); }, [active]);
  const failed = items.filter((item) => item.state === "error" || item.state === "auth");
  const selectedHole = props.hole?.hole;
  const marks = items.filter((item) => item.kind === "throws" && item.body.scorerIndex === props.scorerIndex && item.body.hole === selectedHole);
  const mark = marks[marks.length - 1];
  if (!active) return null;

  const names = new Map((props.choices || []).map((row) => [row.index, row.name]));
  const failureLabel = failed.length + (failed.length === 1 ? " change needs attention" : " changes need attention");
  const content = [
    h("p", { className: "muted", key: "status", role: "status" }, [
      props.recoveryStorageError ? "This phone’s card storage is unavailable. " : "",
      props.recoveryUnavailable ? "Open this card online to enable saved edits. " : "",
      items.length ? items.length + (items.length === 1 ? " change saved on this phone, awaiting sync. " : " changes saved on this phone, awaiting sync. ") : "",
      mark ? (mark.state === "pending" ? "Lie changes pending." : "Lie changes need attention.") : "",
    ].filter(Boolean).join(" ")),
    failed.length ? h("details", { key: "errors", open: props.compact || undefined }, [
      h("summary", { key: "summary" }, failureLabel),
      h("ul", { key: "list" }, failed.map((item) => h("li", { key: item.id }, [
        (item.kind === "throws" ? "Lies" : item.kind === "shots" ? "Shot details" : "Score") + " on " + (props.putting ? "station " : "hole ") + item.body.hole
          + " · " + (names.get(item.body.scorerIndex) || "Card player") + ". "
          + (item.state === "auth" ? "Check that you’re signed in to this card."
            : item.error === "recovery_edit_conflict" ? "This was edited on another device. Review the current value before re-entering."
            : "The round could not accept this change."),
        h("button", { className: "btn secondary", key: "discard", type: "button", onClick: () => props.onDiscardRecovery(item.id) }, "Discard change"),
      ]))),
    ]) : null,
    items.length ? h("button", { className: "btn secondary", key: "retry", type: "button", onClick: props.onRetryRecovery }, "Retry sync") : null,
  ];
  if (!props.compact) return h("section", { "aria-label": "Card sync" }, content);
  const label = props.recoveryStorageError ? "Card storage unavailable"
    : props.recoveryUnavailable ? "Open online to enable saved edits"
    : failed.length ? failureLabel
    : items.length + (items.length === 1 ? " change awaiting sync" : " changes awaiting sync");
  return h("section", { className: "card-sync-summary", "aria-label": "Card sync" },
    h("button", { className: "card-sync-trigger", type: "button", "aria-haspopup": "dialog", "aria-label": label, ref: triggerRef, onClick: () => setOpen(true) },
      h("span", { role: "status" }, label), icon(ChevronRight)),
    open && createPortal(h("div", {
      className: "overlay", "data-a11y-overlay": "true", role: "presentation", ref: dialog.overlayRef,
    }, h("section", {
      className: "sheet score-sync-sheet", role: "dialog", "aria-modal": dialog.isolated ? "true" : undefined,
      "aria-labelledby": titleId, tabIndex: -1, ref: dialog.panelRef,
    },
      h("h2", { id: titleId, className: "section" }, "Card sync"),
      props.turnHint,
      ...content,
      h("button", { className: "btn secondary sheet-close", type: "button", onClick: () => setOpen(false) }, "Back to round"),
    )), document.body),
  );
}

export function ScorecardView(props) {
  useVisibleBottomInset();
  const shortDock = useShortScoreDock();
  const [dismissedFinishHoles, setDismissedFinishHoles] = React.useState({});
  const clipDrafts = useClipRecovery(props.clipRecovery);
  const scoreRegionRef = React.useRef(null);
  const [padRow, setPadRow] = React.useState(null);
  const [measure, setMeasure] = React.useState(null);
  const holeNumber = props.hole && props.hole.hole;
  const throws = props.throwsByHole?.[holeNumber] || [];
  const [pinnedFocus, setPinnedFocus] = React.useState(null);
  const [scoreFlight, setScoreFlight] = React.useState(0);
  const gps = useDeviceFix();
  const [wrist, setWrist] = React.useState(false);
  const [rangeLockOn, setRangeLockOn] = React.useState(() => readRangeLockEnabled(typeof localStorage === "undefined" ? null : localStorage));
  const rangePosted = React.useRef(null);
  const lie = lastThrow(throws);
  const hud = currentRangeHud(props.hole, gps.fix, measure, lie);
  const remaining = hud && hud.mode === "remaining" ? hud.ft : null;
  const mapFocus = resolveMapFocus(pinnedFocus, remaining);
  const measuring = Boolean(measure);
  const measureTo = measure && (measure.b || gps.fix);
  const holes = Array.isArray(props.holes) ? props.holes : [];
  const activeHoleIndex = Math.max(0, holes.findIndex((row) => row && props.hole && row.hole === props.hole.hole));
  React.useEffect(() => {
    if (props.offline) return;
    preloadRoundMaps(holes, {
      activeIndex: activeHoleIndex,
      ahead: 2,
      all: true,
      size: HOLE_MAP_COMPACT_SIZE,
      zooms: true,
    });
  }, [holes, activeHoleIndex, mapFocus, props.offline]);
  const showNextTee = Boolean(hud && (hud.circle === "C1" || hud.circle === "C2") && hud.mode === "remaining");
  const nextTee = showNextTee ? nextTeeHud(gps.fix, props.nextHole) : null;
  const lastThrowLine = lastThrowHud(throws, props.hole && props.hole.tee);
  const rangeNote = rangeLockNote({
    hud,
    hole: holeNumber,
    par: props.hole && props.hole.par,
    courseName: props.courseName,
  });
  const rangeNoteKey = rangeNote ? rangeNote.title + "|" + rangeNote.body : "";
  React.useEffect(() => {
    if (!rangeLockOn) {
      void closeRangeLock();
      return undefined;
    }
    if (!rangeNote) {
      void closeRangeLock();
      return undefined;
    }
    if (!rangeLockChanged(rangePosted.current, rangeNote)) return undefined;
    rangePosted.current = rangeNote;
    void postRangeLock(rangeNote).catch(() => {});
    return undefined;
  }, [rangeLockOn, rangeNoteKey]);
  React.useEffect(() => () => { void closeRangeLock(); }, []);
  async function onToggleLock() {
    if (rangeLockOn) {
      writeRangeLockEnabled(typeof localStorage === "undefined" ? null : localStorage, false);
      setRangeLockOn(false);
      rangePosted.current = null;
      void closeRangeLock();
      return;
    }
    let granted = typeof Notification !== "undefined" && Notification.permission === "granted";
    if (!granted && typeof Notification !== "undefined" && typeof Notification.requestPermission === "function") {
      try {
        granted = (await Notification.requestPermission()) === "granted";
      } catch {
        granted = false;
      }
    }
    if (!granted) return;
    writeRangeLockEnabled(typeof localStorage === "undefined" ? null : localStorage, true);
    rangePosted.current = null;
    setRangeLockOn(true);
  }
  React.useEffect(() => {
    setMeasure(null);
    setPinnedFocus(null);
    setPadRow(null);
  }, [holeNumber, props.scorerIndex, props.clipRecovery?.scopeKey]);

  function persistThrows(edit) {
    if (typeof props.onThrows === "function") props.onThrows(holeNumber, edit, props.scorerIndex);
  }

  function onMeasure() {
    if (measure && measure.b) {
      setMeasure(null);
      return;
    }
    if (measure && measure.a) {
      if (gps.fix) {
        setMeasure({ a: measure.a, b: gps.fix });
        return;
      }
      setMeasure({ a: measure.a, awaitingTap: true });
      return;
    }
    if (gps.fix) {
      setMeasure({ a: gps.fix });
      return;
    }
    setMeasure({ awaitingTap: true });
  }
  function onMapPoint(point) {
    if (measure) {
      if (!measure.a) {
        setMeasure({ a: point });
        return;
      }
      if (!measure.b) {
        setMeasure({ a: measure.a, b: point });
        return;
      }
      setMeasure(null);
      return;
    }
    persistThrows((rows) => addThrow(rows, point, 0));
  }
  function onMapFocus(id) {
    setPinnedFocus((current) => (current === id ? null : id));
  }
  function onMarkLie() {
    if (gps.fix) {
      persistThrows((rows) => addThrow(rows, gps.fix, 0));
      return;
    }
    gps.enableGps();
  }
  function onUndoThrow() {
    persistThrows(undoThrow);
  }
  function onMapMark(kind) {
    if (!gps.fix) {
      gps.enableGps();
      return;
    }
    if (Number.isFinite(gps.fix.accuracyM) && gps.fix.accuracyM > 25) {
      if (typeof props.onMapMark === "function") props.onMapMark(kind, holeNumber, gps.fix, "gps_inaccurate");
      return;
    }
    if (typeof props.onMapMark === "function") {
      props.onMapMark(kind, holeNumber, gps.fix);
    }
  }
  function onScore(source, hole, strokes, step) {
    if (strokes != null) setScoreFlight((value) => value + 1);
    if (typeof props.onScore === "function") props.onScore(source, hole, strokes, props.scorerIndex, step);
  }
  const measureLabel = measure && measure.b ? "Clear" : measure && measure.a ? "Mark" : "Measure";
  const statsHole = props.shotStats?.holes.find((hole) => hole.hole === holeNumber) || props.hole;
  const statsRows = props.shotStats?.throws[holeNumber] ?? throws;
  const solo = props.solo === true || (Array.isArray(props.rows) && props.rows.length === 1);
  const playerBand = Math.min(Math.max(Array.isArray(props.rows) ? props.rows.length : 1, 1), 4);
  const holeHeader = h(HoleHeader, { ...props, key: "active-hole" });
  const onMarkPin = typeof props.onMapMark === "function" ? () => onMapMark("target") : null;
  const onMarkTee = typeof props.onMapMark === "function" ? () => onMapMark("tee") : null;
  const turn = props.yourTurn ? h("p", { className: "your-turn-hint", key: "turn" }, props.yourTurn) : null;
  const status = [
    props.offlineStatus,
    hasRecoveryStatus(props)
      ? h(RecoveryStatus, { ...props, key: "recovery", compact: true, turnHint: turn, scoreRegionRef })
      : turn,
    h(JoinRequestBanner, { key: "joins", onApprove: props.onApproveJoin, onDecline: props.onDeclineJoin, requests: props.joinRequests }),
  ];
  const weather = h(WeatherStrip, { compact: true, key: "weather", scorecard: true, title: "Round weather", weather: props.weather });
  const map = props.putting ? null : h(HoleMedia, {
    ...props, activeHoleIndex, key: "hole-media", gpsFix: gps.fix, gpsStatus: gps.status, lastThrow: lastThrowLine, lie, mapFocus,
    measureFrom: measure && measure.a, measureTo, nextTee, rangeHud: hud, scoreFlight, throws,
    onEnableGps: gps.enableGps, onMapFocus, onMapPoint, onMarkLie,
    onMarkPin, onMarkTee,
    onUndoThrow,
  });
  const statsHoles = props.shotStats?.holes ?? props.holes;
  const stats = props.putting ? null : liveRoundStatsFromCard({
    holeGrid: props.holeGrid, holes: statsHoles, throwsByHole: props.shotStats?.throws ?? props.throwsByHole,
  });
  const roundDetails = [
    h(LiveRoundStats, {
      key: "live-stats", formatLabel: props.formatLabel, holeGrid: props.holeGrid, holes: statsHoles, stats,
      playingDelta: props.playingDelta, playingRating: props.playingRating, putting: props.putting,
    }),
    !props.offline && h(RoundHighlights, { canStar: true, generation: props.clipGeneration, holes: props.holeGrid, key: "clips", putting: props.putting === true }),
    props.putting ? null : h(HoleStatChips, { key: "hole-stats", chips: holeStatChips(holePlayStats(statsHole, statsRows, ((props.holeGrid || []).find((hole) => hole.current) || {}).score)) }),
    props.showPots ? h(PotsStrip, { key: "pots", pots: props.pots }) : null,
    props.potsAceHint ? h("p", { className: "pots-ace-hint", key: "ace-hint" }, props.potsAceHint) : null,
  ];
  const tools = h(RoundTools, {
    ...props, onMarkPin, onMarkTee, key: "round-tools", clipDrafts, measureLabel, measuring, rangeLockOn, getShotFix: gps.getShotFix,
    enableGps: gps.enableGps, shotMeasurement: measure?.b ? remainingFt(measure.a, measure.b) : null, wrist, roundDetails,
    onMeasure, onToggleLock, onWrist: () => setWrist(true),
  });
  const finishDock = h(FinishDockBar, {
    key: "finish-dock",
    finish: props.finish,
    dismissed: dismissedFinishHoles,
    onOpenFinish: props.onOpenFinish,
    onJump: (index) => {
      if (shortDock && scoreRegionRef.current) {
        scoreRegionRef.current.scrollTop = 0;
        scoreRegionRef.current.focus({ preventScroll: true });
      }
      props.onJumpHole?.(index);
    },
    onDismiss: (hole) => setDismissedFinishHoles((previous) => ({ ...previous, [hole]: true })),
  });
  const dock = h("div", { className: "score-glove-dock", key: "dock" }, [
    tools,
    h("div", {
      className: "score-glove-scores", key: "scores", ref: scoreRegionRef,
      role: "region", "aria-label": "Player scores", tabIndex: 0,
    }, [
      h(ScorecardBox, { ...props, key: "scorecard", onOpenPad: setPadRow, onScore }),
      h(CtpClaim, { key: "ctp", ctpClaim: props.ctpClaim, onCtpVote: props.onCtpVote }),
      h(FinishCard, { key: "finish", finish: props.finish, onOpenFinish: props.onOpenFinish, onShare: props.onShare }),
      shortDock ? finishDock : null,
    ]),
    shortDock ? null : finishDock,
    holeHeader,
  ]);
  const layoutClass = "score-glove-layout" + (solo ? " solo" : "") + " players-" + playerBand;
  return h(React.Fragment, null, [
    wrist ? props.offlineStatus : null,
    wrist ? h(RecoveryStatus, { ...props, key: "wrist-recovery" }) : null,
    wrist ? h(WristScore, {
      atEnd: props.atEnd,
      atStart: props.atStart,
      courseName: props.courseName,
      hole: props.hole,
      holeMeta: props.holeMeta,
      hud,
      key: "wrist",
      locked: Boolean(props.finish && props.finish.locked),
      putting: props.putting,
      rangeLockOn,
      rows: props.rows,
      onEnableGps: gps.enableGps,
      onExit: () => setWrist(false),
      onNext: props.onNext,
      onOpenPad: setPadRow,
      onPrevious: props.onPrevious,
      onScore,
      onToggleLock,
    }) : h("div", { className: layoutClass + " score-bottom-layout", key: "glove" }, [
      h("div", { className: "score-bottom-course", key: "course" }, [
        weather,
        h("div", { className: "score-glove-stage", key: "stage" }, [
          h("div", { className: "score-stage-status", key: "status" }, status),
          map,
          stats && h(ScoreAdvancedStats, { key: "advanced", stats }),
          h(HoleGrid, { key: "holes", holes: props.holeGrid, onJump: props.onJumpHole, putting: props.putting }),
        ]),
      ]),
      dock,
    ]),
    h(ConfirmScoresSheet, {
      key: "confirm",
      offline: props.offline,
      finish: props.finish,
      finishing: props.finishing,
      holeGrid: props.holeGrid,
      onAgree: props.onAgreeFinish,
      onCloseFinish: props.onCloseFinish,
      onJump: props.onJumpHole,
      putting: props.putting,
    }),
    padRow
      ? h(ScorePad, {
        hole: props.hole,
        key: "pad",
        putting: props.putting,
        row: padRow,
        onClose: () => setPadRow(null),
        onScore,
      })
      : null,
  ]);
}

function previewHoles() {
  const origin = { lat: 35.55785, lng: -77.360886 };
  const holes = [];
  for (let i = 0; i < 18; i += 1) {
    const hole = i + 1;
    const par = hole % 6 === 0 ? 4 : 3;
    const tee = {
      lat: origin.lat + i * 0.00016,
      lng: origin.lng + (i % 4) * 0.00011,
    };
    const north = par === 4 ? 0.00095 : 0.00074;
    holes.push({
      distance_ft: par === 4 ? 340 : 270,
      hole,
      par,
      target: { lat: tee.lat + north, lng: tee.lng + 0.00018 },
      tee,
    });
  }
  return holes;
}

const PREVIEW_WEATHER = {
  current: {
    condition: "Clear",
    conditionCode: 0,
    temperatureF: 92,
    windDirectionDeg: 292,
    windSpeedMph: 8,
  },
};

export function SoloScorecardPreview() {
  const holes = React.useMemo(previewHoles, []);
  const [holeIdx, setHoleIdx] = React.useState(0);
  const [scores, setScores] = React.useState({});
  const hole = holes[holeIdx] || holes[0];
  const holeGrid = holes.map((row, index) => {
    const score = Object.prototype.hasOwnProperty.call(scores, row.hole) ? scores[row.hole] : null;
    return {
      conflict: false,
      ctp: false,
      current: index === holeIdx,
      done: score != null,
      hole: row.hole,
      index,
      par: row.par,
      relative: score == null ? null : strokeLabel(score, row.par),
      score,
    };
  });
  let thru = 0;
  let total = 0;
  let toPar = 0;
  holeGrid.forEach((row) => {
    if (typeof row.score !== "number") return;
    thru += 1;
    total += row.score;
    toPar += row.score - row.par;
  });
  const currentScore = Object.prototype.hasOwnProperty.call(scores, hole.hole) ? scores[hole.hole] : null;
  const delta = currentScore == null ? null : currentScore - hole.par;
  const rows = [{
    conflictText: "",
    currentScore,
    honors: false,
    key: 0,
    label: "Kevin Gray",
    meta: "",
    relative: delta == null ? null : { className: relClass(delta), text: relText(delta) },
    source: { playerIndexes: [0] },
    teePosition: 1,
  }];

  React.useEffect(() => {
    document.body.classList.add("score-glove");
    return () => document.body.classList.remove("score-glove");
  }, []);

  return h(ScorecardView, {
    atEnd: holeIdx >= holes.length - 1,
    atStart: holeIdx <= 0,
    formatLabel: "Singles · Stroke",
    hole,
    holeGrid,
    holeMeta: "Par " + hole.par + " · " + hole.distance_ft + " ft",
    holes,
    nextHole: holes[holeIdx + 1] || null,
    onJumpHole: setHoleIdx,
    onNext: () => setHoleIdx((index) => Math.min(holes.length - 1, index + 1)),
    onPrevious: () => setHoleIdx((index) => Math.max(0, index - 1)),
    onScore: function (_row, holeNumber, value) {
      setScores((current) => {
        const next = Object.assign({}, current);
        if (value == null) delete next[holeNumber];
        else next[holeNumber] = value;
        return next;
      });
    },
    onShare: function () {},
    roundCode: "PREVIEW",
    rows,
    show: false,
    showWeather: true,
    solo: true,
    totals: [
      { label: "Thru", value: thru + "/" + holes.length },
      { label: "Total", value: total ? String(total) : "-" },
      { label: "To par", value: thru ? relText(toPar) : "E" },
    ],
    weather: PREVIEW_WEATHER,
    windFromDeg: PREVIEW_WEATHER.current.windDirectionDeg,
  });
}
