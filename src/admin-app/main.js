import React from "react";
import { createRoot } from "react-dom/client";

import { AdminAuthGate } from "./auth-gate.js";
import { AdminMessage } from "./message.js";
import { AdminNavigation } from "./navigation.js";
import { AdminPageChrome } from "./page-chrome.js";
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

const crottsMount = document.getElementById("crottsReactApp");
if (crottsMount) {
  createRoot(crottsMount).render(h(CrottsWidget));
}
