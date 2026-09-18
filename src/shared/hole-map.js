import React from "react";

import { holeMapLabel, playerMarksOnMap, projectHoleMap, SATELLITE_CREDIT, scoreChipAnchor } from "./hole-map-model.js";
import { safeExternalUrl } from "./safe-url.js";
import { udiscDeepLink } from "./udisc-export.js";

const h = React.createElement;

function SatelliteLayer({ url }) {
  const [failed, setFailed] = React.useState(false);
  const href = safeExternalUrl(url);
  if (!href || failed) return null;
  return h("img", {
    alt: "",
    className: "hole-map-satellite",
    decoding: "async",
    draggable: false,
    onError: () => setFailed(true),
    src: href,
  });
}

function WindMark(props) {
  if (props.deg == null) return null;
  return h(
    "g",
    {
      className: "hole-map-wind",
      transform: `translate(${props.x} ${props.y}) rotate(${props.deg})`,
    },
    [
      h("polygon", { key: "arrow", points: "0,-11 6,8 0,4 -6,8", fill: "currentColor" }),
      h("title", { key: "title" }, "Wind direction"),
    ],
  );
}

function ScoreChips({ marks, width, height, compact }) {
  if (compact) return null;
  const chips = (marks || []).filter((mark) => mark && mark.label);
  if (!chips.length) return null;
  return h("div", { className: "hole-map-chips" }, chips.map((mark) => {
    const anchor = scoreChipAnchor(mark, width, height);
    return h("div", {
      className: "hole-map-score-chip " + (mark.relClass || "even") + " chip-" + anchor.x + " chip-" + anchor.y,
      key: mark.key,
      style: {
        left: ((mark.x / width) * 100) + "%",
        top: ((mark.y / height) * 100) + "%",
      },
    }, (mark.strokes != null ? mark.strokes + " " : "") + mark.label);
  }));
}

function TeePad(props) {
  const compact = Boolean(props.compact);
  const width = compact ? 12 : 16;
  const height = compact ? 18 : 22;
  const heading = Number.isFinite(props.headingDeg) ? props.headingDeg : 0;
  return h(
    "g",
    {
      className: "hole-map-tee-mark",
      transform: `translate(${props.x} ${props.y}) rotate(${180 - heading})`,
    },
    [
      h("title", { key: "title" }, props.label || "Tee"),
      h("rect", {
        className: "hole-map-tee-pad",
        height,
        key: "pad",
        rx: compact ? 1.6 : 2.2,
        width,
        x: -width / 2,
        y: -height / 2,
      }),
    ],
  );
}

function BasketMark(props) {
  const compact = Boolean(props.compact);
  const scale = compact ? 1.2 : 1.35;
  const chains = compact ? [-3.2, 0, 3.2] : [-4.2, -1.4, 1.4, 4.2];
  return h(
    "g",
    {
      className: "hole-map-basket-mark",
      transform: `translate(${props.x} ${props.y}) scale(${scale})`,
    },
    [
      h("title", { key: "title" }, props.label || "Basket"),
      h("ellipse", { className: "hole-map-basket-shadow", cx: 0, cy: 9.2, key: "shadow", rx: 7.4, ry: 2.4 }),
      h("rect", { className: "hole-map-basket-pole", height: 22, key: "pole", rx: 0.8, width: 2.6, x: -1.3, y: -16 }),
      h("ellipse", { className: "hole-map-basket-tray", cx: 0, cy: 6.2, key: "tray", rx: 7.6, ry: 2.5 }),
      h("ellipse", { className: "hole-map-basket-band", cx: 0, cy: -8.2, key: "band", rx: 6.4, ry: 2.15 }),
      ...chains.map((dx, index) => h("line", {
        className: "hole-map-basket-chain",
        key: "chain-" + index,
        x1: dx * 0.62,
        x2: dx,
        y1: -8.2,
        y2: 5.8,
      })),
    ],
  );
}

function PlayerMark(props) {
  const compact = Boolean(props.compact);
  return h(
    "g",
    {
      className: "hole-map-player",
      transform: `translate(${props.x} ${props.y})`,
    },
    [
      h("title", { key: "title" }, props.initials),
      h("circle", { className: "hole-map-player-dot", key: "dot", r: compact ? 8 : 11 }),
      h("text", { className: "hole-map-player-label", key: "label", y: compact ? 3.2 : 4 }, props.initials),
    ],
  );
}

export function HoleMap(props) {
  const hole = props.hole;
  const compact = Boolean(props.compact);
  const map = projectHoleMap(hole, {
    height: compact ? 180 : undefined,
    width: compact ? 320 : undefined,
    windFromDeg: compact ? null : props.windFromDeg,
  });
  if (!map) return null;
  const udiscHref = compact ? "" : udiscDeepLink(props.udiscCourseId);
  const label = holeMapLabel(map, hole && hole.hole);
  const players = playerMarksOnMap(map, props.players);
  return h("div", { className: compact ? "hole-map-card hole-map-compact" : "card hole-map-card" }, [
    h("div", { className: "hole-map-frame", key: "frame" }, [
      h(SatelliteLayer, { key: "satellite", url: map.satelliteUrl }),
      h(
        "svg",
        {
          "aria-label": label,
          className: "hole-map",
          key: "map",
          preserveAspectRatio: "xMidYMid meet",
          role: "img",
          viewBox: `0 0 ${map.width} ${map.height}`,
        },
        [
          h("title", { key: "title" }, label),
          h("text", { className: "hole-map-north", key: "north", x: 14, y: 22 }, "N"),
          h("line", {
            className: "hole-map-fairway-shadow",
            key: "fairway-shadow",
            x1: map.tee.x,
            x2: map.basket.x,
            y1: map.tee.y,
            y2: map.basket.y,
          }),
          h("line", {
            className: "hole-map-fairway",
            key: "fairway",
            x1: map.tee.x,
            x2: map.basket.x,
            y1: map.tee.y,
            y2: map.basket.y,
          }),
          h(TeePad, {
            compact,
            headingDeg: map.headingDeg,
            key: "tee",
            label: map.tee.label,
            x: map.tee.x,
            y: map.tee.y,
          }),
          h(BasketMark, {
            compact,
            key: "basket",
            label: map.basket.label,
            x: map.basket.x,
            y: map.basket.y,
          }),
          compact ? null : h(WindMark, { deg: map.windBlowToDeg, key: "wind", x: map.width - 24, y: 24 }),
          ...players.map((player) => h(PlayerMark, {
            compact,
            initials: player.initials,
            key: `player-${player.key}`,
            x: player.x,
            y: player.y,
          })),
        ],
      ),
      h(ScoreChips, { compact, height: map.height, key: "chips", marks: players, width: map.width }),
    ]),
    h("div", { className: "hole-map-caption", key: "caption" }, [
      h("span", { key: "tee" }, map.tee.label),
      h("span", { key: "dist" }, map.distanceFt ? `${map.distanceFt} ft` : "Map"),
      h("span", { key: "basket" }, map.basket.label),
    ]),
    h("div", { className: "hole-map-credit", key: "credit" }, SATELLITE_CREDIT),
    udiscHref
      ? h("a", {
        className: "hole-map-udisc",
        href: udiscHref,
        key: "udisc",
        rel: "noopener noreferrer",
        target: "_blank",
      }, "Open this course in UDisc")
      : null,
  ]);
}
