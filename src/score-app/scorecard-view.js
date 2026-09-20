import React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Eye, Ruler, Settings2, Share2, UserPlus, X } from "lucide-react";
import { useAccessibleDialog } from "../shared/a11y.js";
import { HoleMap } from "../shared/hole-map.js";
import { addThrow, currentRangeHud, GPS_WATCH_OPTIONS, gpsErrorPolicy, gpsHudPrompt, lastThrow, lastThrowHud, nextTeeHud, HOLE_MAP_COMPACT_SIZE, readAllThrows, readThrows, resolveMapFocus, undoThrow, withSelfLocation, writeThrows } from "../shared/hole-map-model.js";
import { preloadRoundMaps } from "../shared/satellite-preload.js";
import { formatPct, holePlayStats, holeStatChips, liveRoundStatsFromCard } from "../shared/play-stats.js";
import { PotsStrip } from "./pots-strip.js";
import { WeatherStrip } from "./weather-strip.js";
import { nextHoleScore, relClass, relText, strokeLabel } from "./score-view-model.js";

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

const LIVE_STATS_PEEK_IDS = ["fir", "c1r", "c2r", "birdie"];

function liveStatSample(mine) {
  if (!mine || !mine.att) return "—";
  return mine.hit + "/" + mine.att;
}

function LiveStatTile(row, compact) {
  return h("div", {
    className: "live-stat-tile" + (row.tone ? " tone-" + row.tone : "") + (compact ? " peek" : ""),
    key: row.id,
  }, [
    h("span", { className: "live-stats-k", key: "k" }, row.short || row.label),
    h("b", { key: "v" }, row.mine.att ? formatPct(row.mine.pct) : "—"),
    compact ? null : h("small", { key: "s" }, liveStatSample(row.mine)),
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

function LiveRoundStats(props) {
  const solo = props.solo === true;
  const [open, setOpen] = React.useState(false);
  const expanded = solo || open;
  const storage = typeof sessionStorage === "undefined" ? null : sessionStorage;
  const throwsByHole = readAllThrows(storage, props.roundCode, props.holes);
  if (props.currentHole != null) throwsByHole[props.currentHole] = Array.isArray(props.throws) ? props.throws : [];
  const view = liveRoundStatsFromCard({
    holeGrid: props.holeGrid,
    holes: props.holes,
    throwsByHole,
  });
  const holeCount = Array.isArray(props.holes) && props.holes.length
    ? props.holes.length
    : (Array.isArray(props.holeGrid) ? props.holeGrid.length : 0);
  const thru = view.totals.holes;
  const hasThrows = view.throwStats.some((row) => row.mine && row.mine.att);
  const hint = thru
    ? (hasThrows ? null : "Mark lies for fairways, C1, and putting")
    : "Score holes and mark lies — mix, FIR, C1, and putting fill in live.";
  const peek = LIVE_STATS_PEEK_IDS.map((id) => view.throwStats.find((row) => row.id === id)).filter(Boolean);
  const headChildren = [
    h("div", { className: "live-round-stats-copy", key: "copy" }, [
      h("div", { className: "live-round-stats-title", key: "title" }, "Live stats"),
      h("div", { className: "live-round-stats-meta", key: "meta" }, [
        props.formatLabel || "Singles · Stroke",
        " · Thru ",
        String(thru),
        "/",
        String(holeCount),
      ]),
    ]),
    solo ? null : h("span", { className: "live-round-stats-toggle", key: "toggle" }, [
      h("span", { key: "label" }, expanded ? "Minimize" : "Expand"),
      icon(expanded ? ChevronUp : ChevronDown),
    ]),
  ];
  const head = solo
    ? h("div", { className: "live-round-stats-head", key: "head" }, headChildren)
    : h("button", {
      "aria-controls": "live-round-stats-body",
      "aria-expanded": expanded ? "true" : "false",
      "aria-label": expanded ? "Minimize live stats" : "Expand live stats",
      className: "live-round-stats-head",
      key: "head",
      type: "button",
      onClick: () => setOpen((value) => !value),
    }, headChildren);
  return h("section", {
    "aria-label": "Live round stats",
    "aria-live": "polite",
    className: "live-round-stats" + (solo ? "" : " compact") + (expanded ? " open" : ""),
    key: "live-stats",
  }, [
    head,
    h("div", { className: "live-stats-peek", key: "peek" }, peek.map((row) => LiveStatTile(row, true))),
    h("div", { className: "live-stats-body", id: "live-round-stats-body", key: "body" }, [
      h("div", { className: "live-stats-mix-wrap", key: "mix" }, [
        h(LiveMixBar, { key: "bar", rows: view.mix }),
        h("div", { className: "live-stats-mix-legend", key: "legend" }, view.mix.map((row) =>
          h("div", {
            className: "live-stats-mix-item" + (row.tone ? " tone-" + row.tone : ""),
            key: row.id,
          }, [
            h("span", { className: "live-stats-k", key: "k" }, row.short || row.label),
            h("b", { key: "v" }, String(row.mine.hit)),
          ]),
        )),
      ]),
      h("div", { className: "live-stats-grid", key: "grid" }, view.throwStats.map((row) => LiveStatTile(row, false))),
      hint ? h("p", { className: "live-stats-hint", key: "hint" }, hint) : null,
    ]),
  ]);
}

function RoundTools(props) {
  const showManage = Boolean(props.show);
  return h("div", { className: "score-glove-tools", key: "round-tools" }, [
    h(
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
    props.onWatchShare
      ? h("button", { className: "score-glove-tool", key: "watch", type: "button", onClick: props.onWatchShare }, [
        icon(Eye),
        h("span", { key: "label" }, "Watch"),
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
    h(
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
    showManage
      ? h("button", { className: "score-glove-tool", key: "manage", type: "button", onClick: props.onManagePlayers }, [
        icon(Settings2),
        h("span", { key: "label" }, "Manage"),
      ])
      : null,
    h(ScorecardOwner, { ...props, compact: true, key: "owner" }),
  ]);
}

function HoleHeader(props) {
  return h("div", { className: "hole-head", key: "head" }, [
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
      h("div", { className: "hnum", key: "number" }, `Hole ${props.hole.hole}`),
      h("div", { className: "hpar", key: "par" }, props.holeMeta),
      props.ctpBadge ? h("div", { className: "ctp-badge", key: "ctp" }, props.ctpBadge) : null,
      props.matchStatus ? h("div", { className: "pmeta", key: "match" }, props.matchStatus) : null,
      props.teeOrderHint ? h("div", { className: "tee-order-hint", key: "tee" }, props.teeOrderHint) : null,
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

function holeHasMap(hole) {
  return Boolean(hole && hole.tee && hole.target);
}

function useDeviceFix() {
  const [fix, setFix] = React.useState(null);
  const [status, setStatus] = React.useState("idle");
  const watchId = React.useRef(null);
  const retryTimer = React.useRef(null);
  const fixRef = React.useRef(null);
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
  return { enableGps, fix, status };
}

function RangeHud(props) {
  if (!props.hud) return null;
  const circleClass = props.hud.circle === "C1" ? " in-c1" : props.hud.circle === "C2" ? " in-c2" : "";
  const holeFt = props.hud.mode !== "hole" && Number.isFinite(props.hud.holeFt) ? props.hud.holeFt : null;
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
    h("strong", { key: "ft" }, props.hud.ft + " ft"),
    h("span", { key: "cap" }, props.hud.caption),
    holeFt != null
      ? h("em", { className: "hole-range-hud-len", key: "len" }, holeFt + " ft hole")
      : null,
    nextTee
      ? h("em", { className: "hole-range-hud-next", key: "next" }, nextTee.ft + " ft next tee")
      : null,
    lastThrowLine
      ? h("em", { className: "hole-range-hud-throw", key: "throw" }, lastThrowLine.ft + " ft " + lastThrowLine.caption)
      : null,
    prompt ? h("em", { className: "hole-range-hud-gps", key: "gps" }, prompt) : null,
  ]);
}

function HoleMedia(props) {
  const [signOpen, setSignOpen] = React.useState(false);
  const hasMap = holeHasMap(props.hole);
  const hasSign = Boolean(props.teeSign);
  const canSurvey = typeof props.onMarkTee === "function" || typeof props.onMarkPin === "function";
  if (!hasMap && !hasSign && !canSurvey) return null;
  const style = props.teeSign && props.teeSign.highlightColor
    ? { boxShadow: `0 0 0 3px ${props.teeSign.highlightColor}` }
    : undefined;
  const surveyBtns = canSurvey
    ? h("div", { className: "hole-map-lie-actions hole-map-survey-empty", key: "survey" }, [
      typeof props.onMarkTee === "function"
        ? h("button", {
          className: "hole-map-survey-btn" + (props.surveyed && props.surveyed.tee ? " active" : ""),
          key: "tee",
          type: "button",
          onClick: props.onMarkTee,
        }, props.surveyed && props.surveyed.tee ? "Tee saved" : "Mark tee")
        : null,
      typeof props.onMarkPin === "function"
        ? h("button", {
          className: "hole-map-survey-btn" + (props.surveyed && props.surveyed.target ? " active" : ""),
          key: "pin",
          type: "button",
          onClick: props.onMarkPin,
        }, props.surveyed && props.surveyed.target ? "Pin saved" : "Mark pin")
        : null,
    ])
    : null;
  return h("div", { className: "hole-media", key: "media" }, [
    hasMap
      ? h("div", { className: "hole-media-map-wrap", key: "map-wrap" }, [
        h(HoleMap, {
          compact: true,
          focus: props.mapFocus,
          hole: props.hole,
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
          surveyed: props.surveyed,
          throws: props.throws,
          windFromDeg: props.windFromDeg,
          scoreFlight: props.scoreFlight,
          onFocus: props.onMapFocus,
          onMapPoint: props.onMapPoint,
          onMarkLie: props.onMarkLie,
          onMarkPin: props.onMarkPin,
          onMarkTee: props.onMarkTee,
          onUndoThrow: props.onUndoThrow,
        }),
      ])
      : h("div", { className: "hole-media-empty", key: "empty" }, [
        h("span", { key: "copy" }, "No map for this hole yet"),
        canSurvey
          ? h("span", { className: "hole-media-empty-hint", key: "hint" }, "Stand on the tee or at the basket and mark it")
          : null,
        surveyBtns,
      ]),
    hasSign
      ? h("button", {
        "aria-expanded": signOpen ? "true" : "false",
        className: "hole-media-chip" + (signOpen ? " open" : ""),
        key: "sign",
        type: "button",
        onClick: () => setSignOpen((open) => !open),
      }, signOpen ? "Hide tee sign" : "Tee sign")
      : null,
    signOpen && hasSign
      ? h("div", { className: "card tee-sign-card", key: "tee-sign", style }, [
        h("img", {
          alt: props.teeSign.alt,
          height: 400,
          key: "image",
          loading: "lazy",
          src: props.teeSign.src,
          width: 640,
        }),
        h("div", { className: "tee-sign-caption", key: "caption" }, [
          h("span", { key: "label" }, "Tee sign"),
          h("span", { key: "hole" }, `Hole ${props.teeSign.hole}`),
        ]),
      ])
      : null,
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
        h("option", { key: choice.index, value: String(choice.index) }, choice.name + (choice.isMe ? " (you)" : "")),
      ),
    ),
  ]);
}

function padChoices(par) {
  const holePar = typeof par === "number" ? par : 3;
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
  const choices = padChoices(hole.par);
  function pick(value) {
    props.onScore(row.source, hole.hole, value);
    props.onClose();
  }
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
        h("h2", { className: "section", id: "score-pad-title", key: "title" }, row.label + " · Hole " + hole.hole),
        h("p", { className: "muted", key: "par" }, "Par " + hole.par),
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
        }, "Clear hole"),
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

function chipName(label) {
  const name = String(label || "").replace(/\s*\(you\)\s*$/i, "").trim();
  return name.split(/\s+/)[0] || name || "Player";
}

function ScorePlayerRail(props) {
  const rows = Array.isArray(props.rows) ? props.rows : [];
  if (rows.length < 2) return null;
  const hole = props.hole && props.hole.hole;
  return h("div", {
    "aria-label": "Players on this card",
    className: "score-player-rail",
    key: "rail",
    role: "group",
  }, rows.map((row) => {
    const active = row.key === props.activeKey;
    const rel = row.relative && row.relative.className;
    const scoreLabel = row.currentScore == null ? "no score" : String(row.currentScore);
    return h("button", {
      "aria-current": active ? "true" : undefined,
      "aria-label": (active ? "Scoring " : "Score ") + row.label + (hole ? " on hole " + hole : "") + ", " + scoreLabel,
      "aria-pressed": active ? "true" : "false",
      className: "score-player-chip" + (active ? " active" : "") + (rel ? " " + rel : ""),
      key: row.key,
      type: "button",
      onClick: () => props.onFocus(row.key),
    }, [
      h("span", { className: "score-player-chip-name", key: "name" }, chipName(row.label) + (row.isMe ? " · you" : "")),
      h("b", { key: "score" }, row.currentScore == null ? "—" : String(row.currentScore)),
    ]);
  }));
}

function ScoreRow(props) {
  const row = props.row;
  const current = row.currentScore;
  const nextMinus = nextHoleScore(current, props.hole.par, "minus");
  const nextPlus = nextHoleScore(current, props.hole.par, "plus");
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
      h("div", { className: "pname", key: "name" }, row.label),
      row.meta ? h("div", { className: "pmeta", key: "meta" }, row.meta) : null,
      row.conflictText ? h("div", { className: "pmeta conflict-text", key: "conflict" }, row.conflictText) : null,
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
          onClick: () => props.onScore(row.source, props.hole.hole, nextMinus),
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
          onClick: () => props.onScore(row.source, props.hole.hole, nextPlus),
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
  if (!holes.length) return null;
  return h(
    "div",
    { className: "holegrid", key: "grid" },
    holes.map((hole) => {
      const rel = hole.relative;
      const classes = [
        hole.current ? "cur" : "",
        hole.done ? "done" : "",
        hole.conflict ? "conflict" : "",
        hole.ctp ? "ctp" : "",
        rel ? rel.className : "",
      ].filter(Boolean).join(" ");
      const label = rel
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
          h("span", { className: "holegrid-num", key: "num" }, String(hole.hole)),
          hole.score != null
            ? h("b", { className: "holegrid-score", key: "score" }, String(hole.score))
            : h("span", { className: "holegrid-empty", key: "empty" }, "·"),
          rel ? h("span", { className: "holegrid-rel", key: "rel" }, rel.text) : null,
        ],
      );
    }),
  );
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
  const collapse = rows.length > 1;
  const fallbackKey = ((rows.find((row) => row.isMe) || rows[0] || {}).key);
  const [focusKey, setFocusKey] = React.useState(fallbackKey);
  const activeKey = collapse && rows.some((row) => row.key === focusKey) ? focusKey : fallbackKey;
  const active = rows.find((row) => row.key === activeKey) || rows[0];
  return h("div", { className: "score-entry-card" + (collapse ? " collapsed-others" : ""), key: "scorecard" }, [
    props.warning ? h("p", { className: "muted auth-error", key: "warning" }, props.warning) : null,
    h(ScorePlayerRail, {
      activeKey,
      hole: props.hole,
      key: "rail",
      rows,
      onFocus: setFocusKey,
    }),
    active
      ? h(ScoreRow, {
        hole: props.hole,
        key: active.key,
        locked: props.finish && props.finish.locked,
        row: active,
        onOpenPad: props.onOpenPad,
        onScore: props.onScore,
      })
      : null,
    h(TotalsBar, { totals: props.totals }),
  ]);
}

const FINISH_COPY = "Anyone on this card can confirm. Matching scores on each hole are enough.";

function FinishCard(props) {
  const finish = props.finish;
  if (!finish) return null;
  if (finish.locked) {
    return h("div", { className: "finalize-card ready", key: "finish" },
      h("p", { className: "finalize-head" }, finish.status === "final" ? "Round finished — scores are locked" : "Card submitted — scores locked"),
    );
  }
  return null;
}

function FinishDockBar(props) {
  const finish = props.finish;
  const [dismissed, setDismissed] = React.useState({});
  if (!finish || finish.locked) return null;
  if (finish.canFinish) {
    return h("div", { className: "score-glove-finish", key: "finish-bar" }, h("button", {
      className: "btn finish-round-btn",
      type: "button",
      onClick: props.onOpenFinish,
    }, "Finish card"));
  }
  let blocker = finish.blocker;
  if (blocker && blocker.kind === "missing") {
    const skipped = Array.isArray(finish.skipped) && finish.skipped.length ? finish.skipped : [blocker];
    blocker = skipped.find((row) => row && !dismissed[row.hole]) || null;
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
      onClick: () => setDismissed((prev) => ({ ...prev, [blocker.hole]: true })),
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
  const review = finish.review || { holes: [], rows: [], voters: [], waiting: [] };
  const grid = Array.isArray(props.holeGrid) ? props.holeGrid : [];
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
        h("p", { className: "muted", key: "copy" }, FINISH_COPY),
        h("div", { className: "confirm-score-rows", key: "rows" }, review.rows.map((row) =>
          h("div", { className: "confirm-score-row", key: row.key }, [
            h("span", { className: "name", key: "name" }, row.label),
            h("span", { className: "tot", key: "tot" }, String(row.total || "—")),
            h("span", { className: "tp " + relClass(row.toPar || 0), key: "par" }, relText(row.toPar || 0)),
          ]),
        )),
        grid.length
          ? h("div", { className: "confirm-holegrid holegrid", key: "grid" }, grid.map((hole) => {
            const rel = hole.relative;
            const classes = [
              hole.conflict ? "conflict" : "",
              rel ? rel.className : "",
            ].filter(Boolean).join(" ");
            return h("button", {
              className: classes,
              key: hole.hole,
              type: "button",
              onClick: () => {
                if (props.onCloseFinish) props.onCloseFinish();
                if (props.onJump) props.onJump(hole.index);
              },
            }, [
              h("span", { className: "holegrid-num", key: "num" }, String(hole.hole)),
              hole.score != null
                ? h("b", { className: "holegrid-score", key: "score" }, String(hole.score))
                : h("span", { className: "holegrid-empty", key: "empty" }, "·"),
            ]);
          }))
          : null,
        h("button", {
          className: "btn finish-round-btn",
          key: "lock",
          type: "button",
          onClick: () => props.onAgree && props.onAgree(finish.voterIndex),
        }, "Looks good — lock card"),
        h("button", { className: "btn secondary sheet-close", key: "close", type: "button", onClick: props.onCloseFinish }, "Back"),
      ]),
    ),
    document.body,
  );
}

export function ScorecardView(props) {
  const [padRow, setPadRow] = React.useState(null);
  const [measure, setMeasure] = React.useState(null);
  const [throws, setThrows] = React.useState([]);
  const [surveyed, setSurveyed] = React.useState({});
  const [pinnedFocus, setPinnedFocus] = React.useState(null);
  const [scoreFlight, setScoreFlight] = React.useState(0);
  const gps = useDeviceFix();
  const lie = lastThrow(throws);
  const hud = currentRangeHud(props.hole, gps.fix, measure, lie);
  const remaining = hud && hud.mode === "remaining" ? hud.ft : null;
  const mapFocus = resolveMapFocus(pinnedFocus, remaining);
  const measuring = Boolean(measure);
  const measureTo = measure && (measure.b || gps.fix);
  const holes = Array.isArray(props.holes) ? props.holes : [];
  const activeHoleIndex = Math.max(0, holes.findIndex((row) => row && props.hole && row.hole === props.hole.hole));
  React.useEffect(() => {
    preloadRoundMaps(holes, {
      activeIndex: activeHoleIndex,
      ahead: 2,
      all: true,
      size: HOLE_MAP_COMPACT_SIZE,
      zooms: true,
    });
  }, [holes, activeHoleIndex, mapFocus]);
  const showNextTee = Boolean(hud && (hud.circle === "C1" || hud.circle === "C2") && hud.mode === "remaining");
  const nextTee = showNextTee ? nextTeeHud(gps.fix, props.nextHole) : null;
  const lastThrowLine = lastThrowHud(throws, props.hole && props.hole.tee);
  const holeNumber = props.hole && props.hole.hole;
  const storage = typeof sessionStorage === "undefined" ? null : sessionStorage;

  React.useEffect(() => {
    setMeasure(null);
    setPinnedFocus(null);
    setSurveyed({});
    setThrows(readThrows(storage, props.roundCode, holeNumber));
  }, [holeNumber, props.roundCode]);

  function persistThrows(next) {
    setThrows(next);
    writeThrows(storage, props.roundCode, holeNumber, next);
    if (typeof props.onThrows === "function") props.onThrows(holeNumber, next);
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
    persistThrows(addThrow(throws, point));
  }
  function onMapFocus(id) {
    setPinnedFocus((current) => (current === id ? null : id));
  }
  function onMarkLie() {
    if (gps.fix) {
      persistThrows(addThrow(throws, gps.fix));
      return;
    }
    gps.enableGps();
  }
  function onUndoThrow() {
    persistThrows(undoThrow(throws));
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
      setSurveyed((current) => ({ ...current, [kind === "tee" ? "tee" : "target"]: true }));
    }
  }
  function onScore(source, hole, strokes) {
    if (strokes != null) setScoreFlight((value) => value + 1);
    if (typeof props.onScore === "function") props.onScore(source, hole, strokes);
  }
  const measureLabel = measure && measure.b ? "Clear" : measure && measure.a ? "Mark" : "Measure";
  const solo = props.solo === true || (Array.isArray(props.rows) && props.rows.length === 1);
  const playerBand = Math.min(Math.max(Array.isArray(props.rows) ? props.rows.length : 1, 1), 4);
  return h(React.Fragment, null, [
    h("div", {
      className: "score-glove-layout" + (solo ? " solo" : "") + " players-" + playerBand,
      key: "glove",
    }, [
      h("div", { className: "score-glove-stage", key: "stage" }, [
        props.showWeather ? h(WeatherStrip, { compact: true, key: "weather", title: "Round weather", weather: props.weather }) : null,
        props.yourTurn ? h("p", { className: "your-turn-hint", key: "turn" }, props.yourTurn) : null,
        h(HoleMedia, {
          ...props,
          gpsFix: gps.fix,
          gpsStatus: gps.status,
          lastThrow: lastThrowLine,
          lie,
          mapFocus,
          measureFrom: measure && measure.a,
          measureTo,
          nextTee,
          rangeHud: hud,
          scoreFlight,
          surveyed,
          throws,
          onEnableGps: gps.enableGps,
          onMapFocus,
          onMapPoint,
          onMarkLie,
          onMarkPin: typeof props.onMapMark === "function" ? () => onMapMark("target") : null,
          onMarkTee: typeof props.onMapMark === "function" ? () => onMapMark("tee") : null,
          onUndoThrow,
        }),
        h(LiveRoundStats, {
          currentHole: holeNumber,
          formatLabel: props.formatLabel,
          holeGrid: props.holeGrid,
          holes: props.holes,
          roundCode: props.roundCode,
          solo,
          throws,
        }),
        h(RoundTools, {
          ...props,
          measureLabel,
          measuring,
          onMeasure,
        }),
        h(HoleGrid, { holes: props.holeGrid, onJump: props.onJumpHole }),
        h(HoleStatChips, { chips: holeStatChips(holePlayStats(props.hole, throws, ((props.holeGrid || []).find((hole) => hole.current) || {}).score)) }),
        props.showPots ? h(PotsStrip, { key: "pots", pots: props.pots }) : null,
        props.potsAceHint ? h("p", { className: "pots-ace-hint", key: "ace-hint" }, props.potsAceHint) : null,
      ]),
      h("div", { className: "score-glove-dock", key: "dock" }, [
        h("div", { className: "score-glove-scores", key: "scores" }, [
          h(ScorecardBox, { ...props, onOpenPad: setPadRow, onScore }),
          h(CtpClaim, { ctpClaim: props.ctpClaim, onCtpVote: props.onCtpVote }),
          h(FinishCard, { finish: props.finish, onOpenFinish: props.onOpenFinish }),
        ]),
        h(FinishDockBar, { finish: props.finish, onJump: props.onJumpHole, onOpenFinish: props.onOpenFinish }),
        h(HoleHeader, props),
      ]),
    ]),
    h(ConfirmScoresSheet, {
      finish: props.finish,
      holeGrid: props.holeGrid,
      onAgree: props.onAgreeFinish,
      onCloseFinish: props.onCloseFinish,
      onJump: props.onJumpHole,
    }),
    padRow
      ? h(ScorePad, {
        hole: props.hole,
        key: "pad",
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
    label: "Kevin Gray (you)",
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
