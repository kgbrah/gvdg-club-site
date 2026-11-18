// Admin › Scoring › Live casual rounds: every casual round still live, by its round code (GET /admin/rounds/active),
// so an admin can watch one or end a ghost: a card someone started and never finished, which keeps showing
// "Casual round in progress" on players' Home screens. Ending one is the admin cancel (POST /rounds/:code/cancel).
import React from "react";

import { adminJson, adminToken } from "./admin-api.js";
import { adminConfirm } from "./admin-dialogs.js";
import { currentAdminActiveTab, currentAdminAuthGateState } from "./admin-shell-state.js";

const h = React.createElement;
const QUIET_MS = 60 * 60 * 1000;
const TITLE_STYLE = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: ".45rem" };
const LINK_BUTTON_STYLE = { display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none" };

function access() {
  return currentAdminActiveTab() === "scoring" && currentAdminAuthGateState().status === "panel";
}

/** "just now", "25 min ago", "3 h ago", "2 days ago". */
export function sinceText(value, now = Date.now()) {
  const at = Date.parse(String(value || ""));
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The detail line under a round's code. */
export function liveRoundMeta(round, now = Date.now()) {
  const holes = Number(round?.holes) || 0;
  const scored = Number(round?.holesScored) || 0;
  const last = sinceText(round?.lastActivity, now);
  return [
    holes ? `${scored} of ${holes} holes scored` : "",
    last ? `last activity ${last}` : "",
  ].filter(Boolean).join(" · ");
}

export function isQuiet(round, now = Date.now()) {
  const at = Date.parse(String(round?.lastActivity || ""));
  return Number.isFinite(at) && now - at > QUIET_MS;
}

function RoundRow({ round, onEnded }) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const course = [round.courseName, round.layoutName].filter(Boolean).join(" · ");
  async function end() {
    const confirmed = await adminConfirm({
      title: `End round ${round.code}?`,
      message: "Its scores are discarded and it disappears from every player's Home. Players can start a new round any time.",
      confirmText: "End round",
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setMessage("");
    try {
      await adminJson(`/rounds/${encodeURIComponent(round.code)}/cancel`, { method: "POST", body: {} });
      onEnded();
    } catch (error) {
      setMessage(error.status === 409 ? "That round was already finished." : "That round couldn't be ended. Try again.");
      setBusy(false);
    }
  }
  return h("li", { className: "al-section admin-market-report", "data-admin-live-round": round.code }, [
    h("h3", { className: "al-h", key: "code", style: TITLE_STYLE }, [
      h("code", { key: "c" }, round.code),
      isQuiet(round) ? h("span", { className: "admin-badge", key: "quiet" }, "Quiet over 1 hour") : null,
    ]),
    h("p", { className: "al-note", key: "course" }, [course || "Casual round", round.players?.length ? " · " + round.players.join(", ") : ""].join("")),
    h("p", { className: "al-note", key: "meta" }, liveRoundMeta(round)),
    h("div", { className: "admin-today-actions admin-market-actions", key: "actions" }, [
      h("a", {
        className: "admin-btn secondary", href: `score.html?round=${encodeURIComponent(round.code)}&watch=1`, key: "watch", rel: "noopener", style: LINK_BUTTON_STYLE,
        target: "_blank",
      }, "Watch"),
      h("button", { className: "admin-btn secondary", disabled: busy, key: "end", onClick: () => { void end(); }, type: "button" }, busy ? "Ending…" : "End round"),
    ]),
    message ? h("p", { className: "dash-note", key: "message", role: "alert" }, message) : null,
  ]);
}

export function AdminLiveRounds() {
  const [active, setActive] = React.useState(access);
  const [state, setState] = React.useState({ status: "loading", rounds: [] });
  React.useLayoutEffect(() => {
    const update = () => setActive(access());
    window.addEventListener("gvdg:admin-auth-gate", update);
    window.addEventListener("gvdg:admin-active-tab", update);
    return () => {
      window.removeEventListener("gvdg:admin-auth-gate", update);
      window.removeEventListener("gvdg:admin-active-tab", update);
    };
  }, []);
  const load = React.useCallback(async () => {
    const token = adminToken();
    if (!access()) return;
    setState((current) => ({ ...current, status: current.rounds.length ? "refreshing" : "loading" }));
    try {
      const data = await adminJson("/admin/rounds/active", { token });
      if (access() && token === adminToken()) setState({ status: "ready", rounds: Array.isArray(data?.rounds) ? data.rounds : [] });
    } catch {
      if (access()) setState({ status: "error", rounds: [] });
    }
  }, []);
  React.useEffect(() => { if (active) void load(); }, [active, load]);
  if (!active) return null;
  const rounds = state.rounds;
  return h("section", { className: "admin-scoring-card-block", "data-admin-live-rounds": state.status }, [
    h("h2", { className: "admin-pane-kicker", key: "title" }, `Live casual rounds (${rounds.length})`),
    h("p", { className: "al-note", key: "intro" },
      "Every casual round still open, by its code. End one nobody is playing (it stops showing as in progress on players' Home)."),
    h("button", { className: "admin-btn secondary", disabled: state.status === "loading" || state.status === "refreshing", key: "refresh", onClick: () => { void load(); }, type: "button" },
      state.status === "refreshing" ? "Refreshing…" : "Refresh"),
    state.status === "loading" ? h("p", { className: "dash-note", key: "loading", role: "status" }, "Looking for live rounds…") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error", role: "alert" }, "Live rounds couldn't load.") : null,
    state.status === "ready" && !rounds.length ? h("p", { className: "dash-note", key: "none" }, "No casual rounds are live.") : null,
    rounds.length ? h("ul", { className: "admin-community-list", key: "list" }, rounds.map((round) => h(RoundRow, { key: round.code, onEnded: () => { void load(); }, round }))) : null,
  ]);
}
