import React from "react";

import { holeMapLabel, projectHoleMap } from "../shared/hole-map-model.js";
import { udiscDeepLink } from "../shared/udisc-export.js";

const h = React.createElement;

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
    h(
      "svg",
      {
        "aria-label": label,
        className: "hole-map",
        height: map.height,
        key: "map",
        role: "img",
        viewBox: `0 0 ${map.width} ${map.height}`,
        width: "100%",
      },
      [
        h("title", { key: "title" }, label),
        h("text", { className: "hole-map-north", key: "north", x: 12, y: 18 }, "N"),
        h("line", {
          className: "hole-map-fairway",
          key: "fairway",
          x1: map.tee.x,
          x2: map.basket.x,
          y1: map.tee.y,
          y2: map.basket.y,
        }),
        h("circle", { className: "hole-map-tee", cx: map.tee.x, cy: map.tee.y, key: "tee", r: 7 }),
        h("circle", { className: "hole-map-basket", cx: map.basket.x, cy: map.basket.y, key: "basket", r: 8 }),
        h("circle", { className: "hole-map-basket-inner", cx: map.basket.x, cy: map.basket.y, key: "chains", r: 3 }),
        h(WindMark, { deg: map.windBlowToDeg, key: "wind", x: map.width - 22, y: 22 }),
      ],
    ),
    h("div", { className: "hole-map-caption", key: "caption" }, [
      h("span", { key: "tee" }, map.tee.label),
      h("span", { key: "dist" }, map.distanceFt ? `${map.distanceFt} ft` : "Map"),
      h("span", { key: "basket" }, map.basket.label),
    ]),
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
