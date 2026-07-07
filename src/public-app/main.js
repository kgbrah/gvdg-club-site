import React from "react";
import { createRoot } from "react-dom/client";

import { ProShopApp } from "./pro-shop-app.js";
import { PublicPageChrome } from "./page-chrome.js";
import { RyderCupApp } from "./ryder-cup-app.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  import("react-scan").then(({ scan }) => scan({ enabled: true })).catch(() => {});
}

const h = React.createElement;
const pageChromeMount = document.getElementById("publicReactPageChrome");
const proShopMount = document.getElementById("proShopReactApp");
const ryderCupMount = document.getElementById("ryderCupReactApp");

if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(PublicPageChrome));
}

if (ryderCupMount) {
  createRoot(ryderCupMount).render(h(RyderCupApp));
}

if (proShopMount) {
  createRoot(proShopMount).render(h(ProShopApp));
}
