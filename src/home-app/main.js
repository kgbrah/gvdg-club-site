import React from "react";
import { createRoot } from "react-dom/client";

import { CourseModal } from "./course-modal.js";
import { AreaTournamentsFeed, HomeEventsFeed } from "./feed-panels.js";
import { HomePageChrome } from "./page-chrome.js";
import { HomeBackToTop } from "./page-controls.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

const pageChromeMount = document.getElementById("homeReactPageChromeApp");
if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(HomePageChrome));
}

const eventsMount = document.getElementById("homeReactEventsApp");
if (eventsMount) {
  createRoot(eventsMount).render(h(HomeEventsFeed));
}

const tournamentsMount = document.getElementById("homeReactTournamentsApp");
if (tournamentsMount) {
  createRoot(tournamentsMount).render(h(AreaTournamentsFeed));
}

const courseModalMount = document.getElementById("homeReactCourseModalApp");
if (courseModalMount) {
  createRoot(courseModalMount).render(h(CourseModal));
}

const backToTopMount = document.getElementById("homeReactBackToTopApp");
if (backToTopMount) {
  createRoot(backToTopMount).render(h(HomeBackToTop));
}
