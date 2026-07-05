import { h, render } from "preact";

import { startScoreApp } from "./score-legacy.js";

function ScoreShell() {
  return h("div", { class: "wrap" }, [
    h("header", { class: "topbar" }, [
      h("img", { src: "img/logo.png", alt: "GVDG", class: "logo" }),
      h("h1", { id: "barTitle" }, [
        "Live Scoring",
        h("small", { id: "barSub" }, "Greenville Disc Golf Club"),
      ]),
      h(
        "a",
        {
          class: "top-link",
          href: "gvdg-members.html",
          "aria-label": "Return to members",
        },
        "Members",
      ),
      h("button", { class: "iconbtn", id: "lbBtn", title: "Leaderboard", hidden: true }, "🏆"),
      h("button", { class: "iconbtn", id: "themeBtn", title: "Toggle theme" }, "🌙"),
    ]),
    h("main", { id: "app" }, h("div", { class: "spin" })),
  ]);
}

const root = document.getElementById("scoreRoot");
if (!root) {
  throw new Error("Missing scoreRoot mount element");
}

render(h(ScoreShell), root);
startScoreApp();
