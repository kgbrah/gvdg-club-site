import React from "react";
import { createRoot } from "react-dom/client";

import { AdminOrdersBadge } from "./orders-badge.js";
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

const ordersBadgeMount = document.getElementById("ordersBadgeReactApp");
if (ordersBadgeMount) {
  createRoot(ordersBadgeMount).render(h(AdminOrdersBadge));
}

const crottsMount = document.getElementById("crottsReactApp");
if (crottsMount) {
  createRoot(crottsMount).render(h(CrottsWidget));
}
