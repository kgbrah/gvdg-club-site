import React from "react";
import { createRoot } from "react-dom/client";

import { PublicPageChrome } from "./page-chrome.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  import("react-scan").then(({ scan }) => scan({ enabled: true })).catch(() => {});
}

const h = React.createElement;
const pageChromeMount = document.getElementById("publicReactPageChrome");

if (pageChromeMount) {
  createRoot(pageChromeMount).render(h(PublicPageChrome));
}
