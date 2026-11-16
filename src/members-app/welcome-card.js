import React from "react";
import { X } from "lucide-react";

import { TOKEN_KEY, request, storageGet } from "./api.js";
import { useMemberContext } from "./member-context.js";
import { selectDashboardTab } from "./dashboard-shell.js";

const h = React.createElement;
const PREFIX = "gvdg:welcome:";
const dismissed = new Set();

function stored(key) {
  try { return localStorage.getItem(key) === "1"; }
  catch { return false; }
}

function remember(key) {
  try { localStorage.setItem(key, "1"); }
  catch { /* The in-memory set still hides it for this session. */ }
}

// One-time welcome for a member whose application an admin just approved. The server flag
// (`welcome` on /login and /me) is cleared on dismiss; localStorage covers an offline dismiss.
export function WelcomeCard() {
  const { sub, name, welcome } = useMemberContext();
  const [hidden, setHidden] = React.useState(false);
  const key = PREFIX + sub;
  if (!welcome || !sub || hidden || dismissed.has(key) || stored(key)) return null;

  function dismiss() {
    dismissed.add(key);
    remember(key);
    setHidden(true);
    const token = storageGet(TOKEN_KEY);
    if (token) request("/me/welcome-seen", { method: "POST", token }).catch(() => {});
  }

  const first = String(name || "").trim().split(/\s+/)[0];
  return h("section", { className: "player-story-block member-welcome", "aria-label": "Welcome", "data-react-welcome-card": "ready" }, [
    h("h3", { key: "title" }, first ? `Welcome to the club, ${first}!` : "Welcome to the club!"),
    h("p", { className: "player-card-meta", key: "copy" }, "You're approved. Start a casual round, sign up for the next event, or set up your profile so your ratings show here."),
    h("div", { className: "member-action-grid", key: "actions" }, [
      h("button", { type: "button", className: "player-btn primary", key: "events", onClick: () => { dismiss(); selectDashboardTab("events"); } }, "See events"),
      h("button", { type: "button", className: "player-btn", key: "profile", onClick: () => { dismiss(); window.dispatchEvent(new CustomEvent("gvdg:member-edit-profile-requested")); } }, "Set up profile"),
      h("button", { type: "button", className: "member-first-dismiss", key: "dismiss", "aria-label": "Dismiss welcome", onClick: dismiss }, [h(X, { size: 14, "aria-hidden": true, key: "icon" }), "Dismiss"]),
    ]),
  ]);
}
