// PDGA Developer Program attribution (https://www.pdga.com/dev): every screen that shows PDGA data carries
// "Player, event, and course data provided by PDGA." with a link to pdga.com, and PDGA player, event and course
// names link to their pdga.com pages. Exceptions need the PDGA Developer Program's approval.
import React from "react";

const h = React.createElement;

export const PDGA_HOME = "https://www.pdga.com";

export function pdgaPlayerHref(pdgaNumber) {
  const number = String(pdgaNumber ?? "").replace(/\D/g, "");
  return number ? `${PDGA_HOME}/player/${number}` : "";
}

export function pdgaEventHref(eventId) {
  const id = String(eventId ?? "").replace(/\D/g, "");
  return id ? `${PDGA_HOME}/tour/event/${id}` : "";
}

/**
 * A PDGA name linked to its pdga.com page (opens in a new tab); plain text when there is no page to link. The name
 * keeps its own element (`as`, with `className`) so its layout (wrapping, trimming long names) stays as it was.
 */
export function PdgaLink({ href, className = "", as = "span", children }) {
  const name = href ? h("a", { className: "pdga-link", href, target: "_blank", rel: "noopener noreferrer" }, children) : children;
  return className || !href ? h(as, { className: className || undefined }, name) : name;
}

export function PdgaCredit({ className = "" }) {
  return h("p", { className: ("pdga-credit " + className).trim(), "data-pdga-credit": "" }, [
    "Player, event, and course data provided by ",
    h("a", { href: PDGA_HOME, target: "_blank", rel: "noopener noreferrer", key: "pdga" }, "PDGA"),
    ".",
  ]);
}
