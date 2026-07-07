import React from "react";
import { createRoot } from "react-dom/client";

import { AdminAuthGate } from "./auth-gate.js";
import { AdminFundraisersList, AdminLeaguesList, AdminMeetingsList } from "./club-content-lists.js";
import { AdminCoursesList } from "./courses-list.js";
import { AdminDataArchiveDestinationsList } from "./data-archive-destinations-list.js";
import { AdminEventsList } from "./events-list.js";
import { AdminMessage } from "./message.js";
import { AdminMembersList } from "./members-list.js";
import { AdminNavigation } from "./navigation.js";
import { AdminOrdersList } from "./orders-list.js";
import { AdminPageChrome } from "./page-chrome.js";
import { AdminProductsList } from "./products-list.js";
import { AdminWalletRecentList } from "./wallet-recent-list.js";
import { CrottsWidget } from "../shared/crotts-widget.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

const pageChromeMount = document.getElementById("adminReactPageChromeApp");
if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(AdminPageChrome));
}

const authGateMount = document.getElementById("adminAuthGateReactApp");
if (authGateMount) {
  createRoot(authGateMount).render(h(AdminAuthGate));
}

const navigationMount = document.getElementById("adminNavigationReactApp");
if (navigationMount) {
  createRoot(navigationMount).render(h(AdminNavigation));
}

const messageMount = document.getElementById("adminMessageReactApp");
if (messageMount) {
  createRoot(messageMount).render(h(AdminMessage));
}

const eventsListMount = document.getElementById("adminEventsListReactApp");
if (eventsListMount) {
  createRoot(eventsListMount).render(h(AdminEventsList));
}

const coursesListMount = document.getElementById("adminCoursesListReactApp");
if (coursesListMount) {
  createRoot(coursesListMount).render(h(AdminCoursesList));
}

const leaguesListMount = document.getElementById("adminLeaguesListReactApp");
if (leaguesListMount) {
  createRoot(leaguesListMount).render(h(AdminLeaguesList));
}

const fundraisersListMount = document.getElementById("adminFundraisersListReactApp");
if (fundraisersListMount) {
  createRoot(fundraisersListMount).render(h(AdminFundraisersList));
}

const meetingsListMount = document.getElementById("adminMeetingsListReactApp");
if (meetingsListMount) {
  createRoot(meetingsListMount).render(h(AdminMeetingsList));
}

const membersListMount = document.getElementById("adminMembersListReactApp");
if (membersListMount) {
  createRoot(membersListMount).render(h(AdminMembersList));
}

const productsListMount = document.getElementById("adminProductsListReactApp");
if (productsListMount) {
  createRoot(productsListMount).render(h(AdminProductsList));
}

const ordersListMount = document.getElementById("adminOrdersListReactApp");
if (ordersListMount) {
  createRoot(ordersListMount).render(h(AdminOrdersList));
}

const walletRecentMount = document.getElementById("adminWalletRecentReactApp");
if (walletRecentMount) {
  createRoot(walletRecentMount).render(h(AdminWalletRecentList));
}

const dataArchiveDestinationsMount = document.getElementById("adminDataArchiveDestinationsReactApp");
if (dataArchiveDestinationsMount) {
  createRoot(dataArchiveDestinationsMount).render(h(AdminDataArchiveDestinationsList));
}

const crottsMount = document.getElementById("crottsReactApp");
if (crottsMount) {
  createRoot(crottsMount).render(h(CrottsWidget));
}
