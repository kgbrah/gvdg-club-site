import React from "react";
import { createRoot } from "react-dom/client";
import { CircleHelp, Moon, Sun, Trophy, UsersRound } from "lucide-react";

import { startScoreApp } from "./score-controller.js";
import { ScoreAuthFlow, ApplyForClubLogin } from "./auth-flow.js";
import { ScorecardView, SoloScorecardPreview } from "./scorecard-view.js";
import { OfflineRoundView, offlineScoreRoute } from "./offline-round-view.js";
import { ScoreSetupFlow } from "./setup-flow.js";
import { StatusView } from "./status-view.js";
import { WatchView } from "./watch-view.js";
import { InstallCoachBanner } from "../shared/install-coach-ui.js";
import { CrottsWidget, requestCrottsHelp } from "../shared/crotts-widget.js";
import { usePlayerThemeSession } from "../shared/player-theme-chrome.js";
import { paintPlayerTheme, SCORE_AUTH_EVENT } from "../shared/player-theme-session.js";
import { readMemberToken } from "../shared/member-session.js";
import { CLUB_LOGO_MARK, CLUB_LOGO_MARK_SRCSET } from "../shared/club-logo.js";
import { useDiscColorSession } from "../shared/disc-color.js";
import { fieldTestOn, startFieldTest } from "../shared/field-test-gate.js";

if (import.meta.env.DEV && import.meta.env.VITE_DISABLE_REACT_DEVTOOLS !== "1") {
  void import("react-grab");
  void import("react-scan");
}

// Field test mode loads its recorder only when a volunteer has turned it on for this phone.
if (fieldTestOn()) void startFieldTest("score");

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

function useClubMember() {
  const [signedIn, setSignedIn] = React.useState(() => Boolean(readMemberToken()));
  React.useEffect(() => {
    const refresh = () => setSignedIn(Boolean(readMemberToken()));
    window.addEventListener(SCORE_AUTH_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(SCORE_AUTH_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return signedIn;
}

function ScoreShell() {
  const previewSolo = previewSoloRequested();
  const [offline] = React.useState(() => offlineScoreRoute(location.search));
  const [offlineScoring, setOfflineScoring] = React.useState(false);
  const [header, setHeader] = React.useState({
    showLeaderboard: false,
    subtitle: previewSolo ? "Covenant Church · Covey" : "Greenville Disc Golf Club",
    title: previewSolo ? "Round PREVIEW" : offline ? "Offline Scoring" : "Live Scoring",
  });
  const [bodyView, setBodyView] = React.useState(INITIAL_SCORE_VIEW);
  const { dark, toggle: onToggleTheme } = usePlayerThemeSession();
  const signedIn = useClubMember();
  useDiscColorSession();
  const leaderboardHandlerRef = React.useRef(null);
  const bodyController = React.useMemo(() => ({
    render(kind, props) {
      setBodyView({ kind, props });
    },
  }), []);

  React.useEffect(() => {
    if (previewSolo || offline) return undefined;
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
  }, [bodyController, previewSolo, offline]);

  React.useEffect(() => {
    return () => {
      paintPlayerTheme(null, themeRoot());
    };
  }, []);

  const glove = previewSolo || offlineScoring || bodyView.kind === "scorecard";
  const applyOnScreen = !offline && (bodyView.kind === "auth" || (bodyView.kind === "setup" && (bodyView.props?.view || "home") === "home"));
  const loading = !offline && !previewSolo && bodyView.kind === "status" && bodyView.props?.mode === "loading";
  const showApplyBar = !signedIn && !glove && !applyOnScreen && !loading;

  React.useEffect(() => {
    document.body.classList.toggle("score-glove", glove);
    return () => document.body.classList.remove("score-glove");
  }, [glove]);

  return h("div", { className: "wrap" }, [
    h("header", { key: "header", className: "topbar" }, [
      h("img", { key: "logo", src: CLUB_LOGO_MARK, srcSet: CLUB_LOGO_MARK_SRCSET, alt: "GVDG", className: "logo", width: 32, height: 32 }),
      h("h1", { key: "title", id: "barTitle" }, [
        header.title,
        h("small", { id: "barSub", key: "subtitle" }, header.subtitle),
      ]),
      h(
        "button",
        {
          className: "top-link",
          type: "button",
          key: "help",
          "aria-label": "Help",
          "aria-haspopup": "dialog",
          title: "Help",
          onClick: (event) => {
            const opener = event.currentTarget;
            requestCrottsHelp(() => opener);
          },
        },
        [icon(CircleHelp), h("span", { className: "top-link-label", key: "label" }, "Help")],
      ),
      h(
        "a",
        {
          className: "top-link",
          key: "members",
          href: "gvdg-members.html",
          "aria-label": "Return to members",
          title: "Members",
        },
        [icon(UsersRound), h("span", { className: "top-link-label", key: "label" }, "Members")],
      ),
      h(
        "button",
        {
          "aria-label": "Leaderboard",
          className: "iconbtn",
          hidden: !header.showLeaderboard,
          key: "leaderboard",
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
          className: "iconbtn",
          key: "theme",
          id: "themeBtn",
          title: dark ? "Switch to light mode" : "Switch to dark mode",
          type: "button",
          onClick: onToggleTheme,
        },
        icon(dark ? Sun : Moon),
      ),
    ]),
    previewSolo || offline || bodyView.kind === "watch" || bodyView.kind === "scorecard" ? null : h(InstallCoachBanner, { key: "install" }),
    showApplyBar
      ? h("div", { className: "score-apply", key: "apply" }, [
        h("p", { key: "copy" }, "No club login yet?"),
        h(ApplyForClubLogin, { className: "btn secondary", key: "link" }),
      ])
      : null,
    h("main", { key: "main", id: "app" }, previewSolo ? h(SoloScorecardPreview)
      : offline ? h(OfflineRoundView, { route: offline, onScoring: setOfflineScoring }) : h(ScoreBody, { view: bodyView })),
    h(CrottsWidget, { key: "help" }),
  ]);
}

const root = document.getElementById("scoreRoot");
if (!root) {
  throw new Error("Missing scoreRoot mount element");
}

createRoot(root).render(h(ScoreShell));
