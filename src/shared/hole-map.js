import React from "react";

import { holeMapLabel, latLngFromMapPoint, playerMarksOnMap, projectHoleMap, projectMapPoint, SATELLITE_CREDIT, scoreChipAnchor } from "./hole-map-model.js";
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

function MapFocusChips(props) {
  if (typeof props.onFocus !== "function") return null;
  return h("div", { "aria-label": "Map zoom", className: "hole-map-focus", role: "group" }, [
    { id: "hole", label: "Hole" },
    { id: "c2", label: "C2" },
    { id: "c1", label: "C1" },
  ].map((item) => h("button", {
    "aria-pressed": props.focus === item.id ? "true" : "false",
    className: "hole-map-focus-btn" + (props.focus === item.id ? " active" : ""),
    key: item.id,
    type: "button",
    onClick: (event) => {
      event.stopPropagation();
      props.onFocus(item.id);
    },
  }, item.label)));
}

function MapLieChip(props) {
  if (typeof props.onMarkLie !== "function") return null;
  return h("button", {
    "aria-pressed": props.lie ? "true" : "false",
    className: "hole-map-lie-btn" + (props.lie ? " active" : ""),
    type: "button",
    onClick: (event) => {
      event.stopPropagation();
      props.onMarkLie();
    },
  }, props.lie ? "Clear lie" : "Mark lie");
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
  const width = compact ? 11 : 14;
  const length = compact ? 20 : 26;
  const rotation = Number.isFinite(props.rotationDeg) ? props.rotationDeg : 0;
  const front = compact ? 2 : 2.6;
  const padY = -length * 0.72;
  return h(
    "g",
    {
      className: "hole-map-tee-mark",
      transform: `translate(${props.x} ${props.y}) rotate(${rotation})`,
    },
    [
      h("title", { key: "title" }, props.label || "Tee"),
      h("rect", {
        className: "hole-map-tee-pad",
        height: length,
        key: "pad",
        rx: compact ? 1.4 : 2,
        width,
        x: -width / 2,
        y: padY,
      }),
      h("rect", {
        className: "hole-map-tee-pad-front",
        height: front,
        key: "front",
        rx: compact ? 0.6 : 0.8,
        width: width - 2,
        x: -(width - 2) / 2,
        y: padY + length - front,
      }),
    ],
  );
}


function BasketMark(props) {
  const compact = Boolean(props.compact);
  const scale = compact ? 0.6375 : 0.75;
  const outer = compact
    ? [-6.2, -4.7, -3.1, -1.55, 0, 1.55, 3.1, 4.7, 6.2]
    : [-7, -5.6, -4.2, -2.8, -1.4, 0, 1.4, 2.8, 4.2, 5.6, 7];
  const inner = compact ? [-3.8, -1.3, 1.3, 3.8] : [-4.8, -2.9, -1, 1, 2.9, 4.8];
  const cage = compact ? [-5.4, -2.7, 0, 2.7, 5.4] : [-6.4, -3.8, -1.3, 1.3, 3.8, 6.4];
  return h(
    "g",
    {
      className: "hole-map-basket-mark",
      transform: `translate(${props.x} ${props.y}) scale(${scale})`,
    },
    [
      h("title", { key: "title" }, props.label || "Basket"),
      h("ellipse", { className: "hole-map-basket-shadow", cx: 1.2, cy: 11.8, key: "shadow", rx: 7.6, ry: 2.4 }),
      h("ellipse", { className: "hole-map-basket-base", cx: 0, cy: 10.8, key: "base", rx: 4.2, ry: 1.25 }),
      h("rect", { className: "hole-map-basket-pole", height: 25, key: "pole", rx: 0.6, width: 1.6, x: -0.8, y: -14.4 }),
      h("path", {
        className: "hole-map-basket-chain-body",
        d: "M-5.6 -10.8 L-6.4 2.8 L6.4 2.8 L5.6 -10.8 Z",
        key: "chain-body",
      }),
      ...inner.map((dx, index) => h("line", {
        className: "hole-map-basket-chain hole-map-basket-chain-inner",
        key: "inner-" + index,
        x1: dx * 0.82,
        x2: dx * 0.2,
        y1: -10.7,
        y2: 2.4,
      })),
      ...outer.map((dx, index) => h("line", {
        className: "hole-map-basket-chain",
        key: "outer-" + index,
        x1: dx * 0.9,
        x2: dx,
        y1: -10.85,
        y2: 2.95,
      })),
      h("ellipse", { className: "hole-map-basket-tray-fill", cx: 0, cy: 6.2, key: "tray-floor", rx: 7.2, ry: 2.35 }),
      ...cage.map((dx, index) => h("line", {
        className: "hole-map-basket-cage",
        key: "cage-" + index,
        x1: dx * 0.94,
        x2: dx,
        y1: 3,
        y2: 7,
      })),
      h("ellipse", {
        className: "hole-map-basket-tray",
        cx: 0,
        cy: 3,
        key: "tray-rim",
        rx: 7.1,
        ry: 2.3,
      }),
      h("ellipse", {
        className: "hole-map-basket-band",
        cx: 0,
        cy: -10.9,
        key: "band",
        rx: 6.4,
        ry: 2.05,
      }),
      h("rect", { className: "hole-map-basket-pole", height: 3.2, key: "pin", width: 0.65, x: -0.32, y: -17.8 }),
      h("polygon", { className: "hole-map-basket-flag", key: "flag", points: "0.32,-17.6 5.4,-16.1 0.32,-14.5" }),
    ],
  );
}


function LieMark(props) {
  const r = props.compact ? 5 : 6;
  return h(
    "g",
    {
      className: "hole-map-lie",
      transform: `translate(${props.x} ${props.y})`,
    },
    [
      h("title", { key: "title" }, props.label || "Measure"),
      h("circle", { className: "hole-map-lie-dot", key: "dot", r }),
    ],
  );
}

function mapPointFromEvent(event, map) {
  const svg = event.currentTarget;
  if (!svg || typeof svg.createSVGPoint !== "function") return null;
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const ctm = svg.getScreenCTM && svg.getScreenCTM();
  if (!ctm) return null;
  const local = pt.matrixTransform(ctm.inverse());
  return latLngFromMapPoint(map, local.x, local.y);
}

function CircleRing(props) {
  if (!props.ring) return null;
  return h("ellipse", {
    className: props.className,
    cx: props.ring.cx,
    cy: props.ring.cy,
    rx: props.ring.rx,
    ry: props.ring.ry,
  });
}

function PlayerMark(props) {
  const compact = Boolean(props.compact);
  return h(
    "g",
    {
      className: "hole-map-player" + (props.relClass === "self" ? " self" : ""),
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
    focus: props.focus,
    height: compact ? 180 : undefined,
    width: compact ? 320 : undefined,
    windFromDeg: props.windFromDeg,
  });
  if (!map) return null;
  const udiscHref = compact ? "" : udiscDeepLink(props.udiscCourseId);
  const label = holeMapLabel(map, hole && hole.hole);
  const players = playerMarksOnMap(map, props.players);
  const measureFrom = projectMapPoint(map, props.measureFrom && props.measureFrom.lat, props.measureFrom && props.measureFrom.lng);
  const measureTo = projectMapPoint(map, props.measureTo && props.measureTo.lat, props.measureTo && props.measureTo.lng);
  const lie = projectMapPoint(map, props.lie && props.lie.lat, props.lie && props.lie.lng);
  function onMapPointer(event) {
    if (typeof props.onMapPoint !== "function") return;
    event.preventDefault();
    const point = mapPointFromEvent(event, map);
    if (point) props.onMapPoint(point);
  }
  return h("div", { className: compact ? "hole-map-card hole-map-compact" : "card hole-map-card" }, [
    h("div", { className: "hole-map-frame", key: "frame" }, [
      h(SatelliteLayer, { key: map.satelliteUrl || "satellite", url: map.satelliteUrl }),
      h(
        "svg",
        {
          "aria-label": label,
          className: "hole-map" + (props.onMapPoint ? " hole-map-measure" : ""),
          key: "map",
          preserveAspectRatio: "xMidYMid meet",
          role: "img",
          viewBox: `0 0 ${map.width} ${map.height}`,
          onPointerDown: props.onMapPoint ? onMapPointer : undefined,
        },
        [
          h("title", { key: "title" }, label),
          h("text", { className: "hole-map-north", key: "north", x: 14, y: 22 }, "N"),
          h(CircleRing, { className: "hole-map-c2", key: "c2", ring: map.circle2 }),
          h(CircleRing, { className: "hole-map-c1", key: "c1", ring: map.circle1 }),
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
          measureFrom && measureTo
            ? h("line", {
              className: "hole-map-measure-line",
              key: "measure-line",
              x1: measureFrom.x,
              x2: measureTo.x,
              y1: measureFrom.y,
              y2: measureTo.y,
            })
            : null,
          h(TeePad, {
            compact,
            key: "tee",
            label: map.tee.label,
            rotationDeg: map.teeRotationDeg,
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
          map.windBlowToDeg == null ? null : h(WindMark, { deg: map.windBlowToDeg, key: "wind", x: map.width - 24, y: 24 }),
          ...players.map((player) => h(PlayerMark, {
            compact,
            initials: player.initials,
            key: `player-${player.key}`,
            relClass: player.relClass,
            x: player.x,
            y: player.y,
          })),
          !measureFrom && lie
            ? h(LieMark, { compact, key: "lie", label: "Lie", x: lie.x, y: lie.y })
            : null,
          measureFrom
            ? h(LieMark, { compact, key: "lie-a", label: "Start", x: measureFrom.x, y: measureFrom.y })
            : null,
          measureTo
            ? h(LieMark, { compact, key: "lie-b", label: "Landing", x: measureTo.x, y: measureTo.y })
            : null,
        ],
      ),
      h(ScoreChips, { compact, height: map.height, key: "chips", marks: players, width: map.width }),
      h(MapFocusChips, { focus: map.focus, key: "focus", onFocus: props.onFocus }),
      h(MapLieChip, { key: "lie-chip", lie: props.lie, onMarkLie: props.onMarkLie }),
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
