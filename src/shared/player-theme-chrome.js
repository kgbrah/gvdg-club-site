import React from "react";
import { MoonStar, Sun } from "lucide-react";

import {
  SCORE_AUTH_EVENT,
  THEME_EVENT,
  TOKEN_KEY,
  loadLocalPlayerTheme,
  paintStatusBar,
  readSessionValue,
  syncPlayerTheme,
  togglePlayerThemeMode,
} from "./player-theme-session.js";

const h = React.createElement;
const AUTH_EVENTS = [SCORE_AUTH_EVENT, "gvdg:member-dashboard-opened"];

export function themeRoot() {
  return document.body;
}

function storedTheme() {
  try {
    const theme = localStorage.getItem("theme");
    if (theme === "dark" || theme === "light") return theme;
  } catch {
  }
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function usePlayerThemeSession() {
  const local = loadLocalPlayerTheme();
  const [theme, setThemeState] = React.useState(storedTheme);
  const [playerTheme, setPlayerTheme] = React.useState(local.theme);
  const memberIdRef = React.useRef(local.memberId || "me");

  React.useEffect(() => {
    const root = themeRoot();
    let active = new AbortController();
    function apply(nextTheme, memberId) {
      if (memberId) memberIdRef.current = memberId;
      setPlayerTheme(nextTheme);
    }
    function refresh() {
      active.abort();
      active = new AbortController();
      syncPlayerTheme({
        root,
        signal: active.signal,
        onTheme: apply,
      }).catch(() => {});
    }
    refresh();
    function onThemeEvent(event) {
      if (Object.prototype.hasOwnProperty.call(event.detail || {}, "theme")) {
        setPlayerTheme(event.detail.theme);
      }
    }
    window.addEventListener(THEME_EVENT, onThemeEvent);
    for (const name of AUTH_EVENTS) window.addEventListener(name, refresh);
    return () => {
      active.abort();
      window.removeEventListener(THEME_EVENT, onThemeEvent);
      for (const name of AUTH_EVENTS) window.removeEventListener(name, refresh);
    };
  }, []);

  React.useEffect(() => {
    if (playerTheme) {
      if (playerTheme.mode === "dark") document.documentElement.setAttribute("data-theme", "dark");
      else document.documentElement.removeAttribute("data-theme");
      paintStatusBar(playerTheme);
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    paintStatusBar(null, theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
    }
  }, [theme, playerTheme]);

  const dark = playerTheme ? playerTheme.mode === "dark" : theme === "dark";

  function toggle() {
    if (playerTheme) {
      const next = togglePlayerThemeMode(playerTheme, {
        root: themeRoot(),
        memberId: memberIdRef.current,
        token: readSessionValue(TOKEN_KEY),
      });
      setPlayerTheme(next);
      return;
    }
    setThemeState((current) => (current === "dark" ? "light" : "dark"));
  }

  return { dark, playerTheme, toggle };
}

export function PlayerThemeToggle() {
  const { dark, toggle } = usePlayerThemeSession();
  return h("button", {
    "aria-label": dark ? "Switch to light mode" : "Switch to dark mode",
    "aria-pressed": dark ? "true" : "false",
    className: "theme-toggle",
    onClick: toggle,
    title: dark ? "Switch to light mode" : "Switch to dark mode",
    type: "button",
  }, h(dark ? Sun : MoonStar, {
    "aria-hidden": "true",
    focusable: "false",
    size: 22,
    strokeWidth: 2.4,
  }));
}
