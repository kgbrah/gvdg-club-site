import React from "react";

import { flightArc, flightPoint, holeMapLabel, latLngFromMapPoint, playerMarksOnMap, playerPhotoSrc, projectHoleMap, projectMapPoint, SATELLITE_CREDIT, scoreChipAnchor, throwSegments } from "./hole-map-model.js";
import { discColorPattern } from "./disc-color.js";
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
  if (typeof props.onMarkLie !== "function" && typeof props.onMarkTee !== "function" && typeof props.onMarkPin !== "function") {
    return null;
  }
  const count = Array.isArray(props.throws) ? props.throws.length : 0;
  const marked = props.surveyed || {};
  return h("div", { className: "hole-map-lie-actions" }, [
    typeof props.onMarkTee === "function"
      ? h("button", {
        "aria-pressed": marked.tee ? "true" : "false",
        className: "hole-map-survey-btn" + (marked.tee ? " active" : ""),
        key: "tee",
        type: "button",
        onClick: (event) => {
          event.stopPropagation();
          props.onMarkTee();
        },
      }, marked.tee ? "Tee saved" : "Mark tee")
      : null,
    typeof props.onMarkPin === "function"
      ? h("button", {
        "aria-pressed": marked.target ? "true" : "false",
        className: "hole-map-survey-btn" + (marked.target ? " active" : ""),
        key: "pin",
        type: "button",
        onClick: (event) => {
          event.stopPropagation();
          props.onMarkPin();
        },
      }, marked.target ? "Pin saved" : "Mark pin")
      : null,
    typeof props.onMarkLie === "function"
      ? h("button", {
        "aria-pressed": count > 0 ? "true" : "false",
        className: "hole-map-lie-btn" + (count ? " active" : ""),
        key: "mark",
        type: "button",
        onClick: (event) => {
          event.stopPropagation();
          props.onMarkLie();
        },
      }, count ? "Lie " + (count + 1) : "Mark lie")
      : null,
    count && typeof props.onUndoThrow === "function"
      ? h("button", {
        className: "hole-map-lie-undo",
        key: "undo",
        type: "button",
        onClick: (event) => {
          event.stopPropagation();
          props.onUndoThrow();
        },
      }, "Undo")
      : null,
  ]);
}

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function easeFlight(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

const MULTICOLOR_STOPS = [
  "var(--disc-orange)",
  "var(--disc-gold)",
  "var(--disc-teal)",
  "var(--disc-blue)",
  "var(--disc-purple)",
  "var(--disc-pink)",
];

function pieSlice(index, count, radius) {
  const start = (index / count) * Math.PI * 2 - Math.PI / 2;
  const end = ((index + 1) / count) * Math.PI * 2 - Math.PI / 2;
  const x0 = Math.cos(start) * radius;
  const y0 = Math.sin(start) * radius;
  const x1 = Math.cos(end) * radius;
  const y1 = Math.sin(end) * radius;
  return `M 0 0 L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

function liveDiscPattern(explicit) {
  if (explicit) return discColorPattern(explicit);
  try {
    return discColorPattern(document.documentElement?.getAttribute?.("data-disc-color"));
  } catch {
    return "solid";
  }
}

function DiscPlastic({ plate, pattern }) {
  if (pattern === "multicolor") {
    return MULTICOLOR_STOPS.map((fill, index) => h("path", {
      d: pieSlice(index, MULTICOLOR_STOPS.length, plate),
      fill,
      key: "slice-" + index,
    }));
  }
  if (pattern === "tiedye") {
    return [
      h("ellipse", { fill: "var(--disc-teal)", key: "base", rx: plate, ry: plate }),
      h("ellipse", { cx: -plate * 0.28, cy: -plate * 0.16, fill: "var(--disc-pink)", key: "dye-1", rx: plate * 0.58, ry: plate * 0.4, transform: "rotate(-26)" }),
      h("ellipse", { cx: plate * 0.3, cy: -plate * 0.14, fill: "var(--disc-gold)", key: "dye-2", rx: plate * 0.5, ry: plate * 0.34, transform: "rotate(34)" }),
      h("ellipse", { cx: plate * 0.1, cy: plate * 0.3, fill: "var(--disc-purple)", key: "dye-3", rx: plate * 0.52, ry: plate * 0.36, transform: "rotate(-16)" }),
      h("ellipse", { cx: -plate * 0.2, cy: plate * 0.22, fill: "var(--disc-orange)", key: "dye-4", rx: plate * 0.4, ry: plate * 0.28, transform: "rotate(24)" }),
      h("ellipse", { cx: plate * 0.04, cy: -plate * 0.34, fill: "var(--disc-blue)", key: "dye-5", rx: plate * 0.26, ry: plate * 0.2, transform: "rotate(48)" }),
    ];
  }
  return h("ellipse", { className: "hole-map-disc-plate", key: "plate", rx: plate, ry: plate });
}

function FlyingDisc(props) {
  const flight = props.flight;
  const [progress, setProgress] = React.useState(0);
  React.useEffect(() => {
    if (!flight) return undefined;
    let start = 0;
    let raf = 0;
    const tick = (ts) => {
      if (!start) start = ts;
      const next = Math.min(1, (ts - start) / Math.max(Number(flight.ms) || 1600, 1));
      setProgress(next);
      if (next < 1) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (typeof props.onDone === "function") props.onDone();
    };
    setProgress(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flight && flight.id]);
  if (!flight) return null;
  const pt = flightPoint(flight, easeFlight(progress));
  if (!pt) return null;
  const compact = Boolean(props.compact);
  const plate = compact ? 5.3 : 6.1;
  const putt = flight.kind === "putt";
  const pattern = liveDiscPattern(props.discColor);
  const scale = putt && progress > 0.72 ? Math.max(0.28, 1 - (progress - 0.72) / 0.28 * 0.72) : 1;
  const opacity = putt && progress > 0.86
    ? Math.max(0, 1 - (progress - 0.86) / 0.14)
    : (progress < 0.05 ? progress / 0.05 : 1);
  return h("g", {
    "aria-hidden": "true",
    className: "hole-map-disc-flight" + (putt ? " putt" : "") + (pattern !== "solid" ? " " + pattern : ""),
    key: flight.id,
    opacity,
    transform: `translate(${pt.x.toFixed(2)} ${pt.y.toFixed(2)}) rotate(${(progress * (putt ? 220 : 180)).toFixed(1)}) scale(${scale.toFixed(3)})`,
  }, [
    h("defs", { key: "defs" }, h("clipPath", { id: "gvdg-disc-plate-clip" }, h("ellipse", { rx: plate, ry: plate }))),
    h("ellipse", {
      className: "hole-map-disc-shadow",
      cx: 0.5,
      cy: compact ? 3.1 : 3.6,
      key: "shadow",
      rx: plate * 0.92,
      ry: compact ? 1.5 : 1.8,
    }),
    h("g", { className: "hole-map-disc-plastic", clipPath: "url(#gvdg-disc-plate-clip)", key: "plastic" },
      h(DiscPlastic, { pattern, plate })),
    h("ellipse", { className: "hole-map-disc-rim", key: "rim", rx: plate, ry: plate }),
    h("ellipse", { className: "hole-map-disc-inner", key: "inner", rx: plate * 0.62, ry: plate * 0.62 }),
    h("ellipse", { className: "hole-map-disc-dome", key: "dome", rx: plate * 0.22, ry: plate * 0.22 }),
  ]);
}

function ThrowMark(props) {
  const r = props.compact ? 7 : 8;
  return h(
    "g",
    {
      className: "hole-map-throw" + (props.muted ? " is-muted" : ""),
      transform: `translate(${props.x} ${props.y})`,
    },
    [
      h("title", { key: "title" }, props.label || ("Throw " + props.n)),
      h("circle", { className: "hole-map-throw-dot", key: "dot", r }),
      h("text", { className: "hole-map-throw-label", key: "label", y: props.compact ? 3 : 3.5 }, String(props.n)),
    ],
  );
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
  const r = compact ? 8 : 11;
  const photo = playerPhotoSrc(props.photo);
  const [failed, setFailed] = React.useState(false);
  const clipId = "hole-map-player-clip-" + String(props.markKey || "x");
  const showPhoto = Boolean(photo) && !failed;
  return h(
    "g",
    {
      className: "hole-map-player" + (props.relClass === "self" ? " self" : "") + (props.stale ? " is-stale" : "") + (showPhoto ? " has-photo" : ""),
      transform: `translate(${props.x} ${props.y})`,
    },
    [
      h("title", { key: "title" }, props.initials),
      showPhoto
        ? h("g", { key: "photo" }, [
          h("defs", { key: "defs" }, h("clipPath", { id: clipId }, h("circle", { r }))),
          h("circle", { className: "hole-map-player-ring", key: "ring", r: r + 1.15 }),
          h("image", {
            className: "hole-map-player-photo",
            clipPath: "url(#" + clipId + ")",
            height: r * 2,
            href: photo,
            key: "img",
            onError: () => setFailed(true),
            preserveAspectRatio: "xMidYMid slice",
            width: r * 2,
            x: -r,
            y: -r,
          }),
        ])
        : h("circle", { className: "hole-map-player-dot", key: "dot", r }),
      showPhoto
        ? null
        : h("text", { className: "hole-map-player-label", key: "label", y: compact ? 3.2 : 4 }, props.initials),
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
  const [flight, setFlight] = React.useState(null);
  const throwCountRef = React.useRef(null);
  const scoreFlightRef = React.useRef(Number(props.scoreFlight) || 0);
  const holeKey = hole && hole.hole;
  const throws = Array.isArray(props.throws) ? props.throws : (props.lie ? [props.lie] : []);
  const throwCount = throws.length;
  const lastThrowKey = throwCount
    ? String(throws[throwCount - 1].lat) + "," + String(throws[throwCount - 1].lng)
    : "";
  const teePt = map && map.tee;
  const basketPt = map && map.basket;
  const throwsKey = props.throwsKey == null ? "" : String(props.throwsKey);
  React.useEffect(() => {
    setFlight(null);
    throwCountRef.current = null;
  }, [holeKey, throwsKey]);
  React.useEffect(() => {
    if (!map || !teePt) return;
    const marks = throws.map((row, index) => {
      const pt = projectMapPoint(map, row && row.lat, row && row.lng);
      if (!pt) return null;
      return { ...pt, n: row.n || index + 1 };
    }).filter(Boolean);
    if (prefersReducedMotion()) {
      throwCountRef.current = marks.length;
      return;
    }
    if (throwCountRef.current == null) {
      throwCountRef.current = marks.length;
      return;
    }
    const prev = throwCountRef.current;
    throwCountRef.current = marks.length;
    if (marks.length !== prev + 1) return;
    const to = marks[marks.length - 1];
    const arc = flightArc(marks[marks.length - 2] || teePt, to, "lie");
    if (!arc) return;
    setFlight({ ...arc, hideN: to.n, id: "lie-" + to.n + "-" + marks.length });
  }, [throwCount, lastThrowKey, holeKey, throws, map, teePt]);
  React.useEffect(() => {
    const token = Number(props.scoreFlight) || 0;
    if (token === scoreFlightRef.current) return;
    scoreFlightRef.current = token;
    if (!token || prefersReducedMotion() || !map || !teePt || !basketPt) return;
    const last = throws.length
      ? projectMapPoint(map, throws[throws.length - 1].lat, throws[throws.length - 1].lng)
      : null;
    const arc = flightArc(last || teePt, basketPt, "putt");
    if (!arc) return;
    setFlight({ ...arc, id: "putt-" + token });
  }, [props.scoreFlight]);
  if (!map) return null;
  const udiscHref = compact ? "" : udiscDeepLink(props.udiscCourseId);
  const label = holeMapLabel(map, hole && hole.hole);
  const players = playerMarksOnMap(map, props.players);
  const throwGroups = Array.isArray(props.throwGroups) && props.throwGroups.length
    ? props.throwGroups
    : [{ key: "self", throws, active: true }];
  const groupGeometry = throwGroups.map((group) => {
    const rows = Array.isArray(group.throws) ? group.throws : [];
    const segs = throwSegments(rows, hole && hole.tee).map((seg) => {
      const a = projectMapPoint(map, seg.a && seg.a.lat, seg.a && seg.a.lng);
      const b = projectMapPoint(map, seg.b && seg.b.lat, seg.b && seg.b.lng);
      if (!a || !b) return null;
      return { ...seg, a, b };
    }).filter(Boolean);
    const marks = rows.map((row, index) => {
      const pt = projectMapPoint(map, row && row.lat, row && row.lng);
      if (!pt) return null;
      return { ...pt, n: row.n || index + 1 };
    }).filter(Boolean);
    return { ...group, segs, marks };
  });
  const measureFrom = projectMapPoint(map, props.measureFrom && props.measureFrom.lat, props.measureFrom && props.measureFrom.lng);
  const measureTo = projectMapPoint(map, props.measureTo && props.measureTo.lat, props.measureTo && props.measureTo.lng);
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
          ...groupGeometry.flatMap((group) => group.segs.map((seg) => h("line", {
            className: "hole-map-throw-line" + (group.active === false ? " is-muted" : ""),
            key: "throw-line-" + group.key + "-" + seg.n,
            x1: seg.a.x,
            x2: seg.b.x,
            y1: seg.a.y,
            y2: seg.b.y,
          }))),
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
            markKey: player.key,
            photo: player.photo,
            relClass: player.relClass,
            stale: player.stale,
            x: player.x,
            y: player.y,
          })),
          ...groupGeometry.flatMap((group) => group.marks.map((mark) => (
            group.active !== false && flight && flight.hideN === mark.n
              ? null
              : h(ThrowMark, {
                compact,
                key: "throw-" + group.key + "-" + mark.n,
                muted: group.active === false,
                n: mark.n,
                x: mark.x,
                y: mark.y,
              })
          ))),
          h(FlyingDisc, {
            compact,
            discColor: props.discColor,
            flight,
            key: flight ? flight.id : "disc-idle",
            onDone: () => setFlight(null),
          }),
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
      h(MapLieChip, {
        key: "lie-chip",
        surveyed: props.surveyed,
        throws,
        onMarkLie: props.onMarkLie,
        onMarkPin: props.onMarkPin,
        onMarkTee: props.onMarkTee,
        onUndoThrow: props.onUndoThrow,
      }),
      props.hud || null,
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
