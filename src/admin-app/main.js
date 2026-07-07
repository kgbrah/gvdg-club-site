import React from "react";
import { createRoot } from "react-dom/client";

import { AdminAuthGate } from "./auth-gate.js";
import { AdminFundraiserForm, AdminLeagueForm, AdminMeetingForm } from "./club-content-forms.js";
import { AdminFundraisersList, AdminLeaguesList, AdminMeetingsList } from "./club-content-lists.js";
import { AdminCourseForm } from "./course-form.js";
import { AdminCoursesList } from "./courses-list.js";
import { AdminDataArchiveDestinationForm } from "./data-archive-destination-form.js";
import { AdminDataArchiveExportControls } from "./data-archive-export-controls.js";
import { AdminDataArchiveDestinationsList, AdminDataArchiveExportResult } from "./data-archive-destinations-list.js";
import { AdminEventsList } from "./events-list.js";
import { AdminImportCandidatesList } from "./import-candidates-list.js";
import { AdminImportControls } from "./import-controls.js";
import { AdminMemberForm } from "./member-form.js";
import { AdminMessage } from "./message.js";
import { AdminMembersList, AdminMemberTempPin } from "./members-list.js";
import { AdminNavigation } from "./navigation.js";
import { AdminOrdersList } from "./orders-list.js";
import { AdminPageChrome } from "./page-chrome.js";
import { AdminProductForm } from "./product-form.js";
import { AdminProductsList } from "./products-list.js";
import { AdminRegistrationManualPlayerForm } from "./registration-manual-player-form.js";
import { AdminRegistrationRoster } from "./registration-roster.js";
import { AdminRegistrationAcePot, AdminRegistrationCreditsList, AdminRegistrationCtpsList } from "./registration-widgets.js";
import { AdminOrderControls, AdminProductInventoryControls } from "./shop-controls.js";
import { AdminWalletAdjustmentForm } from "./wallet-form.js";
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

const importControlsMount = document.getElementById("adminImportControlsReactApp");
if (importControlsMount) {
  createRoot(importControlsMount).render(h(AdminImportControls));
}

const importCandidatesMount = document.getElementById("adminImportCandidatesReactApp");
if (importCandidatesMount) {
  createRoot(importCandidatesMount).render(h(AdminImportCandidatesList));
}

const coursesListMount = document.getElementById("adminCoursesListReactApp");
if (coursesListMount) {
  createRoot(coursesListMount).render(h(AdminCoursesList));
}

const courseFormMount = document.getElementById("adminCourseFormReactApp");
if (courseFormMount) {
  createRoot(courseFormMount).render(h(AdminCourseForm));
}

const leagueFormMount = document.getElementById("adminLeagueFormReactApp");
if (leagueFormMount) {
  createRoot(leagueFormMount).render(h(AdminLeagueForm));
}

const leaguesListMount = document.getElementById("adminLeaguesListReactApp");
if (leaguesListMount) {
  createRoot(leaguesListMount).render(h(AdminLeaguesList));
}

const fundraiserFormMount = document.getElementById("adminFundraiserFormReactApp");
if (fundraiserFormMount) {
  createRoot(fundraiserFormMount).render(h(AdminFundraiserForm));
}

const fundraisersListMount = document.getElementById("adminFundraisersListReactApp");
if (fundraisersListMount) {
  createRoot(fundraisersListMount).render(h(AdminFundraisersList));
}

const meetingFormMount = document.getElementById("adminMeetingFormReactApp");
if (meetingFormMount) {
  createRoot(meetingFormMount).render(h(AdminMeetingForm));
}

const meetingsListMount = document.getElementById("adminMeetingsListReactApp");
if (meetingsListMount) {
  createRoot(meetingsListMount).render(h(AdminMeetingsList));
}

const membersListMount = document.getElementById("adminMembersListReactApp");
if (membersListMount) {
  createRoot(membersListMount).render(h(AdminMembersList));
}

const memberFormMount = document.getElementById("adminMemberFormReactApp");
if (memberFormMount) {
  createRoot(memberFormMount).render(h(AdminMemberForm));
}

const memberTempPinMount = document.getElementById("adminMemberTempPinReactApp");
if (memberTempPinMount) {
  createRoot(memberTempPinMount).render(h(AdminMemberTempPin));
}

const productsListMount = document.getElementById("adminProductsListReactApp");
if (productsListMount) {
  createRoot(productsListMount).render(h(AdminProductsList));
}

const productFormMount = document.getElementById("adminProductFormReactApp");
if (productFormMount) {
  createRoot(productFormMount).render(h(AdminProductForm));
}

const productInventoryControlsMount = document.getElementById("adminProductInventoryControlsReactApp");
if (productInventoryControlsMount) {
  createRoot(productInventoryControlsMount).render(h(AdminProductInventoryControls));
}

const orderControlsMount = document.getElementById("adminOrderControlsReactApp");
if (orderControlsMount) {
  createRoot(orderControlsMount).render(h(AdminOrderControls));
}

const ordersListMount = document.getElementById("adminOrdersListReactApp");
if (ordersListMount) {
  createRoot(ordersListMount).render(h(AdminOrdersList));
}

const walletRecentMount = document.getElementById("adminWalletRecentReactApp");
if (walletRecentMount) {
  createRoot(walletRecentMount).render(h(AdminWalletRecentList));
}

const walletFormMount = document.getElementById("adminWalletFormReactApp");
if (walletFormMount) {
  createRoot(walletFormMount).render(h(AdminWalletAdjustmentForm));
}

const dataArchiveDestinationFormMount = document.getElementById("adminDataArchiveDestinationFormReactApp");
if (dataArchiveDestinationFormMount) {
  createRoot(dataArchiveDestinationFormMount).render(h(AdminDataArchiveDestinationForm));
}

const dataArchiveDestinationsMount = document.getElementById("adminDataArchiveDestinationsReactApp");
if (dataArchiveDestinationsMount) {
  createRoot(dataArchiveDestinationsMount).render(h(AdminDataArchiveDestinationsList));
}

const dataArchiveExportControlsMount = document.getElementById("adminDataArchiveExportControlsReactApp");
if (dataArchiveExportControlsMount) {
  createRoot(dataArchiveExportControlsMount).render(h(AdminDataArchiveExportControls));
}

const dataArchiveExportResultMount = document.getElementById("adminDataArchiveExportResultReactApp");
if (dataArchiveExportResultMount) {
  createRoot(dataArchiveExportResultMount).render(h(AdminDataArchiveExportResult));
}

const registrationRosterMount = document.getElementById("adminRegistrationRosterReactApp");
if (registrationRosterMount) {
  createRoot(registrationRosterMount).render(h(AdminRegistrationRoster));
}

const registrationManualPlayerFormMount = document.getElementById("adminRegistrationManualPlayerFormReactApp");
if (registrationManualPlayerFormMount) {
  createRoot(registrationManualPlayerFormMount).render(h(AdminRegistrationManualPlayerForm));
}

const registrationCtpsMount = document.getElementById("adminRegistrationCtpsReactApp");
if (registrationCtpsMount) {
  createRoot(registrationCtpsMount).render(h(AdminRegistrationCtpsList));
}

const registrationCreditsMount = document.getElementById("adminRegistrationCreditsReactApp");
if (registrationCreditsMount) {
  createRoot(registrationCreditsMount).render(h(AdminRegistrationCreditsList));
}

const registrationAcePotMount = document.getElementById("adminRegistrationAcePotReactApp");
if (registrationAcePotMount) {
  createRoot(registrationAcePotMount).render(h(AdminRegistrationAcePot));
}

const crottsMount = document.getElementById("crottsReactApp");
if (crottsMount) {
  createRoot(crottsMount).render(h(CrottsWidget));
}
