import React from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Eye, Ruler, Settings2, Share2, UserPlus, X } from "lucide-react";
import { useAccessibleDialog } from "../shared/a11y.js";
import { HoleMap } from "../shared/hole-map.js";
import { currentRangeHud, gpsHudPrompt, withSelfLocation } from "../shared/hole-map-model.js";
import { PotsStrip } from "./pots-strip.js";
import { WeatherStrip } from "./weather-strip.js";
import { nextHoleScore, relClass, relText } from "./score-view-model.js";

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

  const enableGps = React.useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }
    if (watchId.current != null) {
      try { navigator.geolocation.clearWatch(watchId.current); } catch {
        /* watch may already be gone */
      }
      watchId.current = null;
    }
    setStatus("watching");
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords && pos.coords.latitude;
        const lng = pos.coords && pos.coords.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        setFix({ lat, lng });
        setStatus("ready");
      },
      (err) => {
        setFix(null);
        setStatus(err && err.code === 1 ? "denied" : "idle");
      },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 12000 },
    );
  }, []);

  React.useEffect(() => {
    enableGps();
    return () => {
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
  const prompt = gpsHudPrompt(props.gpsStatus);
  const clickable = Boolean(prompt && props.onEnableGps);
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
    prompt ? h("em", { className: "hole-range-hud-gps", key: "gps" }, prompt) : null,
  ]);
}

function HoleMedia(props) {
  const [signOpen, setSignOpen] = React.useState(false);
  const hasMap = holeHasMap(props.hole);
  const hasSign = Boolean(props.teeSign);
  if (!hasMap && !hasSign) return null;
  const style = props.teeSign && props.teeSign.highlightColor
    ? { boxShadow: `0 0 0 3px ${props.teeSign.highlightColor}` }
    : undefined;
  return h("div", { className: "hole-media", key: "media" }, [
    hasMap
      ? h("div", { className: "hole-media-map-wrap", key: "map-wrap" }, [
        h(HoleMap, {
          compact: true,
          hole: props.hole,
          key: "map-card",
          measureFrom: props.measureFrom,
          measureTo: props.measureTo,
          players: withSelfLocation(props.playerLocations, props.gpsFix),
          windFromDeg: props.windFromDeg,
          onMapPoint: props.onMapPoint,
        }),
        h(RangeHud, { gpsStatus: props.gpsStatus, hud: props.rangeHud, onEnableGps: props.onEnableGps }),
      ])
      : h("div", { className: "hole-media-empty", key: "empty" }, "No map for this hole yet"),
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
  return h("div", { className: "scorecard-owner", key: "owner" }, [
    h("label", { htmlFor: "scorecardOwner", key: "label" }, "Scorecard"),
    h(
      "select",
      {
        id: "scorecardOwner",
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
  return h("div", { className: "score-entry-card", key: "scorecard" }, [
    h(ScorecardOwner, props),
    props.warning ? h("p", { className: "muted auth-error", key: "warning" }, props.warning) : null,
    props.rows.map((row) => h(ScoreRow, {
      key: row.key,
      row,
      hole: props.hole,
      locked: props.finish && props.finish.locked,
      onScore: props.onScore,
      onOpenPad: props.onOpenPad,
    })),
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
  const gps = useDeviceFix();
  const hud = currentRangeHud(props.hole, gps.fix, measure);
  const measuring = Boolean(measure);
  const measureTo = measure && (measure.b || gps.fix);
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
    if (!measure) return;
    if (!measure.a) {
      setMeasure({ a: point });
      return;
    }
    if (!measure.b) {
      setMeasure({ a: measure.a, b: point });
      return;
    }
    setMeasure(null);
  }
  const measureLabel = measure && measure.b ? "Clear" : measure && measure.a ? "Mark" : "Measure";
  return h(React.Fragment, null, [
    h("div", { className: "score-glove-layout", key: "glove" }, [
      h("div", { className: "score-glove-stage", key: "stage" }, [
        props.showWeather ? h(WeatherStrip, { compact: true, key: "weather", title: "Round weather", weather: props.weather }) : null,
        props.yourTurn ? h("p", { className: "your-turn-hint", key: "turn" }, props.yourTurn) : null,
        h(HoleMedia, {
          ...props,
          gpsFix: gps.fix,
          gpsStatus: gps.status,
          measureFrom: measure && measure.a,
          measureTo,
          rangeHud: hud,
          onEnableGps: gps.enableGps,
          onMapPoint: measuring ? onMapPoint : undefined,
        }),
        h(RoundTools, {
          ...props,
          measureLabel,
          measuring,
          onMeasure,
        }),
        h(HoleGrid, { holes: props.holeGrid, onJump: props.onJumpHole }),
        props.showPots ? h(PotsStrip, { key: "pots", pots: props.pots }) : null,
        props.potsAceHint ? h("p", { className: "pots-ace-hint", key: "ace-hint" }, props.potsAceHint) : null,
      ]),
      h("div", { className: "score-glove-dock", key: "dock" }, [
        h("div", { className: "score-glove-scores", key: "scores" }, [
          h(ScorecardBox, { ...props, onOpenPad: setPadRow }),
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
        onScore: props.onScore,
      })
      : null,
  ]);
}
