import React from "react";
import { createRoot } from "react-dom/client";
import { CircleHelp, Moon, Sun, Trophy, UsersRound } from "lucide-react";

import { startScoreApp } from "./score-controller.js";
import { ScoreAuthFlow } from "./auth-flow.js";
import { ScorecardView, SoloScorecardPreview } from "./scorecard-view.js";
import { ScoreSetupFlow } from "./setup-flow.js";
import { StatusView } from "./status-view.js";
import { WatchView } from "./watch-view.js";
import { InstallCoachBanner } from "../shared/install-coach-ui.js";
import { CrottsWidget, requestCrottsHelp } from "../shared/crotts-widget.js";
import { usePlayerThemeSession } from "../shared/player-theme-chrome.js";
import { paintPlayerTheme } from "../shared/player-theme-session.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const h = React.createElement;
const INITIAL_SCORE_VIEW = { kind: "status", props: { mode: "loading" } };

function icon(Icon, size = 18) {
  return h(Icon, {
    key: "icon",
    size,
    strokeWidth: 2.4,
    "aria-hidden": "true",
    focusable: "false",
  });
}

function previewSoloRequested() {
  try {
    const params = new URLSearchParams(location.search);
    return params.get("preview") === "solo-stats";
  } catch {
    return false;
  }
}

function ScoreBody({ view }) {
  switch (view.kind) {
    case "auth":
      return h(ScoreAuthFlow, view.props);
    case "scorecard":
      return h(ScorecardView, view.props);
    case "setup":
      return h(ScoreSetupFlow, view.props);
    case "watch":
      return h(WatchView, view.props);
    case "status":
    default:
      return h(StatusView, view.props);
  }
}

function themeRoot() {
  return document.body;
}

function ScoreShell() {
  const previewSolo = previewSoloRequested();
  const [header, setHeader] = React.useState({
    showLeaderboard: false,
    subtitle: previewSolo ? "Covenant Church · Covey" : "Greenville Disc Golf Club",
    title: previewSolo ? "Round PREVIEW" : "Live Scoring",
  });
  const [bodyView, setBodyView] = React.useState(INITIAL_SCORE_VIEW);
  const { dark, toggle: onToggleTheme } = usePlayerThemeSession();
  const leaderboardHandlerRef = React.useRef(null);
  const bodyController = React.useMemo(() => ({
    render(kind, props) {
      setBodyView({ kind, props });
    },
  }), []);

  React.useEffect(() => {
    if (previewSolo) return undefined;
    startScoreApp({
      body: bodyController,
      shell: {
        setHeader(nextHeader) {
          setHeader((current) => ({ ...current, ...nextHeader }));
        },
        setLeaderboardHandler(handler) {
          leaderboardHandlerRef.current = handler;
        },
      },
    });
    return () => {
      leaderboardHandlerRef.current = null;
    };
  }, [bodyController, previewSolo]);

  React.useEffect(() => {
    return () => {
      paintPlayerTheme(null, themeRoot());
    };
  }, []);

  React.useEffect(() => {
    const glove = previewSolo || bodyView.kind === "scorecard";
    document.body.classList.toggle("score-glove", glove);
    return () => document.body.classList.remove("score-glove");
  }, [bodyView.kind, previewSolo]);

  return h("div", { class: "wrap" }, [
    h("header", { class: "topbar" }, [
      h("img", { src: "img/logo.png", alt: "GVDG", class: "logo", width: 32, height: 32 }),
      h("h1", { id: "barTitle" }, [
        header.title,
        h("small", { id: "barSub", key: "subtitle" }, header.subtitle),
      ]),
      h(
        "button",
        {
          class: "top-link",
          type: "button",
          "aria-label": "Help",
          title: "Help",
          onClick: () => requestCrottsHelp(),
        },
        [icon(CircleHelp), h("span", { class: "top-link-label", key: "label" }, "Help")],
      ),
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
      h(
        "button",
        {
          "aria-label": "Leaderboard",
          class: "iconbtn",
          hidden: !header.showLeaderboard,
          id: "lbBtn",
          title: "Leaderboard",
          type: "button",
          onClick: () => leaderboardHandlerRef.current?.(),
        },
        icon(Trophy),
      ),
      h(
        "button",
        {
          "aria-label": dark ? "Switch to light mode" : "Switch to dark mode",
          class: "iconbtn",
          id: "themeBtn",
          title: dark ? "Switch to light mode" : "Switch to dark mode",
          type: "button",
          onClick: onToggleTheme,
        },
        icon(dark ? Sun : Moon),
      ),
    ]),
    previewSolo || bodyView.kind === "watch" || bodyView.kind === "scorecard" ? null : h(InstallCoachBanner, { key: "install" }),
    h("main", { id: "app" }, previewSolo ? h(SoloScorecardPreview) : h(ScoreBody, { view: bodyView })),
    h(CrottsWidget, { key: "help" }),
  ]);
}

const root = document.getElementById("scoreRoot");
if (!root) {
  throw new Error("Missing scoreRoot mount element");
}

createRoot(root).render(h(ScoreShell));
