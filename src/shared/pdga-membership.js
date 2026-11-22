// "Join or renew your PDGA membership" with the club's PDGA discount code. PDGA's checkout can't be prefilled from a
// link, so the code sits beside the button with a copy control ("paste it at checkout"). The code comes from the
// server only for signed-in current club members (PDGA asks clubs to keep it within the club).
import React from "react";
import { PdgaCredit, PdgaLink, pdgaPlayerHref } from "./pdga-credit.js";
import { SIGNUP_LINK } from "./outside-link.js";

const h = React.createElement;
const SOON_DAYS = 45;

function daysUntil(isoDay) {
  const time = Date.parse(String(isoDay || "") + "T23:59:59Z");
  return Number.isFinite(time) ? Math.ceil((time - Date.now()) / 86_400_000) : null;
}

/** Whether a member should be nudged about their PDGA membership: lapsed, or ending within SOON_DAYS. */
export function pdgaMembershipNeedsAttention(data) {
  const player = data && data.player;
  if (!player) return false;
  if (player.membershipStatus !== "current") return true;
  const left = daysUntil(player.membershipExpires);
  return left != null && left <= SOON_DAYS;
}

// Tapping Join / Renew marks the time; coming back to the app within RENEW_WINDOW_MS asks PDGA again right away, so
// the renewal shows up (owner: "the notification should go away once the player has renewed").
const RENEW_KEY = "gvdg_pdga_renew_started";
const RENEW_WINDOW_MS = 2 * 60 * 60 * 1000;

export function markPdgaRenewStarted(storage = typeof sessionStorage !== "undefined" ? sessionStorage : null) {
  try { storage && storage.setItem(RENEW_KEY, String(Date.now())); } catch { /* private mode: the button still works */ }
}

/** True within RENEW_WINDOW_MS of tapping Join / Renew. */
export function pdgaRenewPending(storage = typeof sessionStorage !== "undefined" ? sessionStorage : null, now = Date.now()) {
  try {
    const started = Number(storage && storage.getItem(RENEW_KEY));
    return Number.isFinite(started) && started > 0 && now - started < RENEW_WINDOW_MS;
  } catch {
    return false;
  }
}

export function clearPdgaRenewStarted(storage = typeof sessionStorage !== "undefined" ? sessionStorage : null) {
  try { storage && storage.removeItem(RENEW_KEY); } catch { /* harmless */ }
}

/** "I've renewed": asks PDGA now, and says so when PDGA hasn't caught up yet. */
function CheckAgain({ onCheckAgain }) {
  const [state, setState] = React.useState("idle");
  async function check() {
    setState("checking");
    try {
      const next = await onCheckAgain();
      setState(pdgaMembershipNeedsAttention(next) ? "not-yet" : "idle");
    } catch {
      setState("failed");
    }
  }
  return h(React.Fragment, null, [
    h("button", { className: "player-btn", type: "button", key: "check", disabled: state === "checking", onClick: check },
      state === "checking" ? "Checking PDGA…" : "I've renewed"),
    state === "not-yet" ? h("p", { className: "dash-note", role: "status", key: "not-yet" }, "PDGA hasn't updated your membership yet. If you just paid, give it a few minutes and check again.") : null,
    state === "failed" ? h("p", { className: "dash-note", role: "status", key: "failed" }, "PDGA couldn't be checked right now. Try again in a few minutes.") : null,
  ]);
}

function PromoCode({ promo }) {
  const [copied, setCopied] = React.useState(false);
  return h("div", { className: "pdga-promo", "data-pdga-promo": "" }, [
    h("p", { key: "line" }, ["Club code: ", h("b", { className: "pdga-promo-code", key: "code" }, promo.code), " — $5 off at PDGA's checkout",
      promo.validThrough ? ` (good through ${promo.validThrough})` : "", "."]),
    h("button", { className: "player-btn", type: "button", key: "copy", onClick: async () => {
      try { await navigator.clipboard.writeText(promo.code); setCopied(true); } catch { setCopied(false); }
    } }, copied ? "Copied" : "Copy code"),
  ]);
}

/** The card: status from PDGA, the join/renew button, and the code (or how to get it). */
/** credit: false inside a card that already credits PDGA (Home), so the line isn't shown twice. */
export function PdgaMembershipCard({ data, compact = false, credit = true, onCheckAgain = null }) {
  if (!data || !data.joinUrl) return null; // no answer (signed out, or the check failed): nothing to show
  const player = data.player;
  const status = player ? player.membershipStatus : null;
  const left = player ? daysUntil(player.membershipExpires) : null;
  const line = data.lookup === "none" ? "No PDGA number on your profile yet."
    : data.lookup === "unavailable" ? "PDGA couldn't be checked right now."
      : !player ? "PDGA has no player with the number on your profile."
        : status === "current"
          ? `Current PDGA member through ${player.membershipExpires || "the end of the year"}${left != null && left <= SOON_DAYS ? ` (${Math.max(0, left)} days left)` : ". You're all set"}.`
          : `Your PDGA membership ${status === "expired" ? "expired" : "isn't current"}${player.membershipExpires ? ` (${player.membershipExpires})` : ""}.`;
  const renew = Boolean(player) && (status !== "current" || (left != null && left <= SOON_DAYS));
  // Already renewed (current, not ending within SOON_DAYS): just the status, no renew button or club code (owner:
  // "I already renewed" — the card still offered "Renew early with PDGA" and the code).
  const settled = Boolean(player) && status === "current" && !renew;
  const href = data.lookup === "none" || (!player && data.lookup === "ok") ? data.joinUrl : data.renewUrl;
  const label = data.lookup === "none" || (!player && data.lookup === "ok") ? "Join the PDGA" : "Renew with PDGA";
  const playerHref = player ? (player.url || pdgaPlayerHref(data.pdgaNumber)) : "";
  return h("div", { className: `pdga-membership${compact ? " compact" : ""}`, "data-pdga-membership": status || data.lookup }, [
    h("h3", { key: "title" }, "PDGA membership"),
    h("p", { className: "player-card-meta", key: "line" }, [
      player && playerHref
        ? [h(PdgaLink, { href: playerHref, key: "player" }, player.name || `PDGA #${data.pdgaNumber}`), " · ", line]
        : line,
    ]),
    settled ? null : h("div", { className: "member-action-grid", key: "actions" }, [
      h("a", { className: `player-btn${renew || data.lookup === "none" ? " primary" : ""}`, href, ...SIGNUP_LINK, key: "go", onClick: () => markPdgaRenewStarted() }, label),
      renew && onCheckAgain ? h(CheckAgain, { onCheckAgain, key: "again" }) : null,
    ]),
    settled ? null : data.promo ? h(PromoCode, { promo: data.promo, key: "promo" })
      : data.clubDiscountAvailable ? h("p", { className: "dash-note", key: "promo-note" }, "Current GVDG members get $5 off with the club's code.") : null,
    player && credit ? h(PdgaCredit, { key: "credit" }) : null,
  ]);
}
