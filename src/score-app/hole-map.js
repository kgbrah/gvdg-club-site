import React from "react";

import { holeMapLabel, projectHoleMap, SATELLITE_CREDIT } from "../shared/hole-map-model.js";
import { safeExternalUrl } from "../shared/safe-url.js";
import { udiscDeepLink } from "../shared/udisc-export.js";

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

export function HoleMap(props) {
  const hole = props.hole;
  const map = projectHoleMap(hole, {
    windFromDeg: props.windFromDeg,
  });
  if (!map) return null;
  const udiscHref = udiscDeepLink(props.udiscCourseId);
  const label = holeMapLabel(map, hole && hole.hole);
  return h("div", { className: "card hole-map-card" }, [
    h("div", { className: "hole-map-frame", key: "frame" }, [
      h(SatelliteLayer, { key: "satellite", url: map.satelliteUrl }),
      h(
        "svg",
        {
          "aria-label": label,
          className: "hole-map",
          key: "map",
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
          h("circle", { className: "hole-map-tee", cx: map.tee.x, cy: map.tee.y, key: "tee", r: 8 }),
          h("circle", { className: "hole-map-basket", cx: map.basket.x, cy: map.basket.y, key: "basket", r: 9 }),
          h("circle", { className: "hole-map-basket-inner", cx: map.basket.x, cy: map.basket.y, key: "chains", r: 3.5 }),
          h(WindMark, { deg: map.windBlowToDeg, key: "wind", x: map.width - 24, y: 24 }),
        ],
      ),
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
