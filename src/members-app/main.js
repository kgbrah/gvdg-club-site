import React from "react";
import { createRoot } from "react-dom/client";

import { MemberAuthGate } from "./auth-gate.js";
import { MemberDashboardApp } from "./dashboard-app.js";
import { installDashboardRouter } from "./dashboard-router.js";
import { MemberDialogs } from "./member-dialogs.js";
import { installMemberAuthController } from "./member-auth-controller.js";
import { MemberPageChrome } from "./page-chrome.js";
import { CrottsWidget } from "../shared/crotts-widget.js";
import { lazyPanel } from "./lazy-panel.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;
// A shared public profile link is the only first view that needs the community screen.
const PublicCommunityProfile = lazyPanel(() => import("./community-panel.js"), "PublicCommunityProfile");

const dialogMount = document.getElementById("membersReactDialogsApp");
if (dialogMount) {
  createRoot(dialogMount).render(h(MemberDialogs));
}

const profileKey = new URLSearchParams(window.location.search).get("profile");
if (!profileKey) {
  installMemberAuthController();
  installDashboardRouter();
} else {
  document.body.dataset.memberShell = "auth";
}

const pageChromeMount = document.getElementById("membersReactPageChrome");
if (pageChromeMount) {
  createRoot(pageChromeMount).render(profileKey ? h(MemberPageChrome, { showInstall: false }) : h(MemberPageChrome));
}

const authMount = document.getElementById("membersReactAuthGate");
if (authMount) {
  createRoot(authMount).render(profileKey ? h(PublicCommunityProfile, { profileKey }) : h(MemberAuthGate));
}

const dashboardMount = document.getElementById("membersReactDashboardApp");
if (dashboardMount && !profileKey) {
  createRoot(dashboardMount).render(h(MemberDashboardApp));
}

const crottsMount = document.getElementById("crottsReactApp");
if (crottsMount) {
  createRoot(crottsMount).render(h(CrottsWidget));
}
