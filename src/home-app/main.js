import React from "react";
import { createRoot } from "react-dom/client";

import { HomeContactSection, HomeFooter, HomeMembershipSection } from "./community-sections.js";
import { CourseModal } from "./course-modal.js";
import { HomeCoursesApp } from "./courses-app.js";
import { AreaTournamentsFeed, HomeEventsFeed } from "./feed-panels.js";
import { HomeAboutSection, HomeHeroSection } from "./hero-about-app.js";
import { HomePageChrome } from "./page-chrome.js";
import { HomeBackToTop } from "./page-controls.js";
import { HomeScoringTeaser } from "./scoring-teaser.js";
import { HomeReturnedStrip } from "./returned-strip.js";
import { CrottsWidget } from "../shared/crotts-widget.js";
import { installOutsideLinkHandoff } from "../shared/outside-link.js";
import { renewMemberSession } from "../shared/member-session.js";
import { resolveApiBase } from "../shared/api-base.js";

// Keep a signed-in member signed in while they use the app (a fresh 30-day session once a day).
void renewMemberSession({ apiBase: resolveApiBase() });

// Sign-up links (PDGA join/renew, event registration, Disc Golf Scene, PayPal) leave the installed app and in-app
// browsers (Facebook, Instagram…) for the phone's own browser, where people are already signed in.
// Does nothing in a normal browser tab.
installOutsideLinkHandoff();

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

const pageChromeMount = document.getElementById("homeReactPageChromeApp");
if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(HomePageChrome));
}

const heroMount = document.getElementById("homeReactHeroApp");
if (heroMount) {
  createRoot(heroMount).render(h(HomeHeroSection));
}

const scoringTeaserMount = document.getElementById("homeReactScoringTeaserApp");
if (scoringTeaserMount) {
  createRoot(scoringTeaserMount).render(h(HomeScoringTeaser));
}

const aboutMount = document.getElementById("homeReactAboutApp");
if (aboutMount) {
  createRoot(aboutMount).render(h(HomeAboutSection));
}

const eventsMount = document.getElementById("homeReactEventsApp");
if (eventsMount) {
  createRoot(eventsMount).render(h(HomeEventsFeed));
}

const tournamentsMount = document.getElementById("homeReactTournamentsApp");
if (tournamentsMount) {
  createRoot(tournamentsMount).render(h(AreaTournamentsFeed));
}

const returnedMount = document.getElementById("homeReactReturnedApp");
if (returnedMount) {
  createRoot(returnedMount).render(h(HomeReturnedStrip));
}

const coursesMount = document.getElementById("homeReactCoursesApp");
if (coursesMount) {
  createRoot(coursesMount).render(h(HomeCoursesApp));
}

const membershipMount = document.getElementById("homeReactMembershipApp");
if (membershipMount) {
  createRoot(membershipMount).render(h(HomeMembershipSection));
}

const contactMount = document.getElementById("homeReactContactApp");
if (contactMount) {
  createRoot(contactMount).render(h(HomeContactSection));
}

const footerMount = document.getElementById("homeReactFooterApp");
if (footerMount) {
  createRoot(footerMount).render(h(HomeFooter));
}

const courseModalMount = document.getElementById("homeReactCourseModalApp");
if (courseModalMount) {
  createRoot(courseModalMount).render(h(CourseModal));
}

const backToTopMount = document.getElementById("homeReactBackToTopApp");
if (backToTopMount) {
  createRoot(backToTopMount).render(h(HomeBackToTop));
}

const crottsMount = document.getElementById("crottsReactApp");
if (crottsMount) {
  createRoot(crottsMount).render(h(CrottsWidget));
}
