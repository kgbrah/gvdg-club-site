import React from "react";

import { eventScheduleFacts } from "./events-model.js";

const h = React.createElement;

export function EventScheduleFacts({ event }) {
  const facts = eventScheduleFacts(event);
  if (!facts.length) return null;
  return h("dl", { className: "event-schedule" }, facts.map((fact) => h("div", {
    className: "event-schedule-row",
    key: fact.key,
  }, [
    h("dt", { key: "label" }, fact.label),
    h("dd", { key: "value" }, fact.value),
  ])));
}
