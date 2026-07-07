import React from "react";
import { createRoot } from "react-dom/client";

import { ProShopApp } from "./pro-shop-app.js";
import { PublicPageChrome } from "./page-chrome.js";
import { RyderCupApp } from "./ryder-cup-app.js";
import { EventsPreviousResultsApp } from "./events-previous-results-app.js";
import { EventsFundraisersApp, EventsMeetingsApp } from "./events-club-content-app.js";
import { EventsClubFeedApp, EventsLiveNowApp, EventsScheduleFeedApp, EventsUpcomingApp } from "./events-hub-app.js";
import { EventsLeagueDetailApp, EventsLeaguesApp } from "./events-leagues-app.js";
import { EventsRegistrationApp } from "./events-registration-app.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  import("react-scan").then(({ scan }) => scan({ enabled: true })).catch(() => {});
}

const h = React.createElement;
const pageChromeMount = document.getElementById("publicReactPageChrome");
const proShopMount = document.getElementById("proShopReactApp");
const ryderCupMount = document.getElementById("ryderCupReactApp");
const eventsLiveNowMount = document.getElementById("liveNowSection");
const eventsScheduleFeedMount = document.getElementById("calendarEvents");
const eventsUpcomingMount = document.getElementById("hub");
const eventsClubFeedMount = document.getElementById("clubEventsSection");
const eventsRegistrationMount = document.getElementById("registerSection");
const eventsPreviousResultsMount = document.getElementById("previousResultsSection");
const eventsLeaguesMount = document.getElementById("leaguesSection");
const eventsLeagueDetailMount = document.getElementById("leagueDetailSection");
const eventsFundraisersMount = document.getElementById("fundraisersSection");
const eventsMeetingsMount = document.getElementById("meetingsSection");

if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(PublicPageChrome));
}

if (ryderCupMount) {
  createRoot(ryderCupMount).render(h(RyderCupApp));
}

if (eventsLiveNowMount) {
  createRoot(eventsLiveNowMount).render(h(EventsLiveNowApp));
}

if (eventsScheduleFeedMount) {
  createRoot(eventsScheduleFeedMount).render(h(EventsScheduleFeedApp));
}

if (eventsUpcomingMount) {
  createRoot(eventsUpcomingMount).render(h(EventsUpcomingApp));
}

if (eventsClubFeedMount) {
  createRoot(eventsClubFeedMount).render(h(EventsClubFeedApp));
}

if (eventsRegistrationMount) {
  createRoot(eventsRegistrationMount).render(h(EventsRegistrationApp));
}

if (eventsPreviousResultsMount) {
  createRoot(eventsPreviousResultsMount).render(h(EventsPreviousResultsApp));
}

if (eventsLeaguesMount) {
  createRoot(eventsLeaguesMount).render(h(EventsLeaguesApp));
}

if (eventsLeagueDetailMount) {
  createRoot(eventsLeagueDetailMount).render(h(EventsLeagueDetailApp));
}

if (eventsFundraisersMount) {
  createRoot(eventsFundraisersMount).render(h(EventsFundraisersApp));
}

if (eventsMeetingsMount) {
  createRoot(eventsMeetingsMount).render(h(EventsMeetingsApp));
}

if (proShopMount) {
  createRoot(proShopMount).render(h(ProShopApp));
}
