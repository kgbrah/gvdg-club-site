import React from "react";
import { createRoot } from "react-dom/client";

import { MemberDashboardShell } from "./dashboard-shell.js";
import { MemberOverviewDashboard } from "./overview-dashboard.js";
import { MemberRegistrationPanel } from "./registration-panel.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;

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
