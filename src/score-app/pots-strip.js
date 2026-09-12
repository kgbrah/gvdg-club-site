import React from "react";

import { ctpLine } from "../shared/live-pots-model.js";

const h = React.createElement;

export function PotsStrip(props) {
  const pots = props.pots;
  if (!pots || !pots.visible) return null;
  const ctps = Array.isArray(pots.ctps) ? pots.ctps : [];
  return h("div", { className: "pots-strip", "data-react-live-pots": "ready" }, [
    h("div", { className: "pots-title", key: "title" }, pots.title || "Live pots"),
    pots.aceLine
      ? h("div", { className: "pots-ace", key: "ace" }, ["Ace pot · ", pots.aceLine])
      : null,
    ctps.length
      ? h("ul", { className: "pots-ctps", key: "ctps" }, ctps.map((ctp, index) => h(
        "li",
        { key: ctp.id || `${ctp.hole}-${index}` },
        "CTP · " + ctpLine(ctp),
      )))
      : null,
  ]);
}
