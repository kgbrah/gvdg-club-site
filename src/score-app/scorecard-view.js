import React from "react";
import { ChevronLeft, ChevronRight, Eye, Settings2, Share2, UserPlus } from "lucide-react";
import { HoleMap } from "../shared/hole-map.js";
import { PotsStrip } from "./pots-strip.js";
import { WeatherStrip } from "./weather-strip.js";

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
  if (!props.show) return null;
  return h("div", { className: "card round-tools", key: "round-tools" }, [
    h("div", { className: "round-code", key: "code" }, [
      h("span", { className: "muted", key: "label" }, "Code "),
      h("strong", { key: "value" }, props.roundCode),
    ]),
    h("div", { className: "round-actions", key: "actions" }, [
      h("button", { className: "btn small secondary", key: "share", type: "button", onClick: props.onShare }, [
        icon(Share2),
        "Share",
      ]),
      props.onWatchShare
        ? h("button", { className: "btn small secondary", key: "watch", type: "button", onClick: props.onWatchShare }, [
          icon(Eye),
          "Watch",
        ])
        : null,
      h(
        "button",
        {
          "aria-label": "Add player",
          className: "btn small secondary",
          key: "add",
          title: "Add player",
          type: "button",
          onClick: props.onAddPlayer,
        },
        [icon(UserPlus), "Add"],
      ),
      h("button", { className: "btn small secondary", key: "manage", type: "button", onClick: props.onManagePlayers }, [
        icon(Settings2),
        "Manage",
      ]),
    ]),
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
    h("div", { key: "mid", style: { flex: "1", textAlign: "center" } }, [
      h("div", { className: "hnum", key: "number" }, `Hole ${props.hole.hole}`),
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

function TeeSignCard(props) {
  if (!props.teeSign) return null;
  const style = props.teeSign.highlightColor ? { boxShadow: `0 0 0 3px ${props.teeSign.highlightColor}` } : undefined;
  return h("div", { className: "card tee-sign-card", key: "tee-sign", style }, [
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

function ScoreRow(props) {
  const row = props.row;
  const current = row.currentScore;
  const baseMinus = current == null ? props.hole.par : current;
  const basePlus = current == null ? props.hole.par - 1 : current;
  return h("div", { className: "prow" + (row.conflictText ? " conflict" : ""), key: row.key }, [
    h("div", { className: "pinfo", key: "info" }, [
      h("div", { className: "pname", key: "name" }, row.label),
      row.meta ? h("div", { className: "pmeta", key: "meta" }, row.meta) : null,
      row.conflictText ? h("div", { className: "pmeta conflict-text", key: "conflict" }, row.conflictText) : null,
    ]),
    h("div", { className: "stepper", key: "stepper" }, [
      h(
        "button",
        {
          "aria-label": `Decrease ${row.label} on hole ${props.hole.hole}`,
          className: "minus",
          type: "button",
          onClick: () => props.onScore(row.source, props.hole.hole, Math.max(1, baseMinus - 1)),
        },
        "-",
      ),
      h("div", { className: "val", key: "value" }, [
        h("div", { className: "n", key: "score" }, current == null ? "-" : String(current)),
        row.relative ? h("div", { className: `rel ${row.relative.className}`, key: "relative" }, row.relative.text) : null,
      ]),
      h(
        "button",
        {
          "aria-label": `Increase ${row.label} on hole ${props.hole.hole}`,
          className: "plus",
          type: "button",
          onClick: () => props.onScore(row.source, props.hole.hole, Math.min(30, basePlus + 1)),
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
  return h("div", { className: "card", key: "scorecard" }, [
    h(ScorecardOwner, props),
    props.warning ? h("p", { className: "muted auth-error", key: "warning" }, props.warning) : null,
    props.rows.map((row) => h(ScoreRow, { key: row.key, row, hole: props.hole, onScore: props.onScore })),
    h(TotalsBar, { totals: props.totals }),
  ]);
}

function HoleGrid(props) {
  return h(
    "div",
    { className: "holegrid", key: "grid" },
    props.holes.map((hole) =>
      h(
        "button",
        {
          "aria-label": `Hole ${hole.hole}`,
          className: [hole.current ? "cur" : "", hole.done ? "done" : "", hole.conflict ? "conflict" : "", hole.ctp ? "ctp" : ""].filter(Boolean).join(" "),
          key: hole.hole,
          type: "button",
          onClick: () => props.onJump(hole.index),
        },
        String(hole.hole),
      ),
    ),
  );
}

export function ScorecardView(props) {
  return h(React.Fragment, null, [
    props.showWeather ? h(WeatherStrip, { key: "weather", title: "Round weather", weather: props.weather }) : null,
    props.showPots ? h(PotsStrip, { key: "pots", pots: props.pots }) : null,
    props.potsAceHint ? h("p", { className: "pots-ace-hint", key: "ace-hint" }, props.potsAceHint) : null,
    h(RoundTools, props),
    h(HoleHeader, props),
    props.yourTurn ? h("p", { className: "your-turn-hint", key: "turn" }, props.yourTurn) : null,
    h(HoleMap, { hole: props.hole, players: props.playerLocations, udiscCourseId: props.udiscCourseId, windFromDeg: props.windFromDeg }),
    h(TeeSignCard, { teeSign: props.teeSign }),
    h(CtpClaim, { ctpClaim: props.ctpClaim, onCtpVote: props.onCtpVote }),
    h(ScorecardBox, props),
    h(HoleGrid, { holes: props.holeGrid, onJump: props.onJumpHole }),
  ]);
}
