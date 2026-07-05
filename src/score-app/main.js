import React from "react";
import { createRoot } from "react-dom/client";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Trophy from "lucide-react/dist/esm/icons/trophy.mjs";
import UsersRound from "lucide-react/dist/esm/icons/users-round.mjs";

import { startScoreApp } from "./score-legacy.js";
import { createScoreSetupFlowRenderer } from "./setup-flow.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;
const setupFlow = createScoreSetupFlowRenderer();

function icon(Icon, size = 18) {
  return h(Icon, {
    key: "icon",
    size,
    strokeWidth: 2.4,
    "aria-hidden": "true",
    focusable: "false",
  });
}

function ScoreShell() {
  React.useEffect(() => {
    startScoreApp({ setupFlow });
    return () => setupFlow.clear();
  }, []);

  return h("div", { class: "wrap" }, [
    h("header", { class: "topbar" }, [
      h("img", { src: "img/logo.png", alt: "GVDG", class: "logo", width: 32, height: 32 }),
      h("h1", { id: "barTitle" }, [
        "Live Scoring",
        h("small", { id: "barSub", key: "subtitle" }, "Greenville Disc Golf Club"),
      ]),
      h(
        "a",
        {
          class: "top-link",
          href: "gvdg-members.html",
          "aria-label": "Return to members",
          title: "Members",
        },
        [icon(UsersRound), h("span", { class: "top-link-label", key: "label" }, "Members")],
      ),
      h("button", { class: "iconbtn", id: "lbBtn", title: "Leaderboard", "aria-label": "Leaderboard", hidden: true }, icon(Trophy)),
      h("button", { class: "iconbtn", id: "themeBtn", title: "Toggle theme", "aria-label": "Toggle theme" }, icon(Moon)),
    ]),
    h("main", { id: "app" }, h("div", { class: "spin" })),
  ]);
}

const root = document.getElementById("scoreRoot");
if (!root) {
  throw new Error("Missing scoreRoot mount element");
}

createRoot(root).render(h(ScoreShell));
