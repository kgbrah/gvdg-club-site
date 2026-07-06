import React from "react";
import { createRoot } from "react-dom/client";

import { MemberAuthGate } from "./auth-gate.js";
import { MemberBoardPanel } from "./board-panel.js";
import { MemberClubPanel } from "./club-panel.js";
import { MemberDashboardShell } from "./dashboard-shell.js";
import { installDashboardRouter } from "./dashboard-router.js";
import { MemberDialogs } from "./member-dialogs.js";
import { installMemberAuthController } from "./member-auth-controller.js";
import { MemberOverviewDashboard } from "./overview-dashboard.js";
import { MemberPageChrome } from "./page-chrome.js";
import { MemberRegistrationPanel } from "./registration-panel.js";
import { MemberTeeSignsPanel } from "./tee-signs-panel.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

const dialogMount = document.createElement("div");
document.body.appendChild(dialogMount);
createRoot(dialogMount).render(h(MemberDialogs));

installMemberAuthController();
installDashboardRouter();

const pageChromeMount = document.getElementById("membersReactPageChrome");
if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(MemberPageChrome));
}

const authMount = document.getElementById("membersReactAuthGate");
if (authMount) {
  createRoot(authMount).render(h(MemberAuthGate));
}

const shellMount = document.getElementById("membersReactDashboardShell");
if (shellMount) {
  createRoot(shellMount).render(h(MemberDashboardShell));
  document.getElementById("members")?.classList.add("members-react-shell-ready");
}

const overviewMount = document.getElementById("membersReactOverviewPanel");
if (overviewMount) {
  createRoot(overviewMount).render(h(MemberOverviewDashboard));
  document.getElementById("members")?.classList.add("members-react-overview-ready", "members-react-ratings-ready");
}

const registrationMount = document.getElementById("membersReactRegistrationPanel");
if (registrationMount) {
  createRoot(registrationMount).render(h(MemberRegistrationPanel));
  document.getElementById("members")?.classList.add("members-react-registration-ready");
}

const boardMount = document.getElementById("membersReactBoardPanel");
if (boardMount) {
  createRoot(boardMount).render(h(MemberBoardPanel));
  document.getElementById("members")?.classList.add("members-react-board-ready");
}

const teeSignsMount = document.getElementById("membersReactTeeSignsPanel");
if (teeSignsMount) {
  createRoot(teeSignsMount).render(h(MemberTeeSignsPanel));
  document.getElementById("members")?.classList.add("members-react-tee-signs-ready");
}

const clubMount = document.getElementById("membersReactClubPanel");
if (clubMount) {
  createRoot(clubMount).render(h(MemberClubPanel));
  document.getElementById("members")?.classList.add("members-react-club-ready");
}
