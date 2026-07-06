import React from "react";
import { createRoot } from "react-dom/client";

import { AreaTournamentsFeed, HomeEventsFeed } from "./feed-panels.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

const eventsMount = document.getElementById("homeReactEventsApp");
if (eventsMount) {
  createRoot(eventsMount).render(h(HomeEventsFeed));
}

const tournamentsMount = document.getElementById("homeReactTournamentsApp");
if (tournamentsMount) {
  createRoot(tournamentsMount).render(h(AreaTournamentsFeed));
}
