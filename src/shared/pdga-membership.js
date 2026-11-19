// "Join or renew your PDGA membership" with the club's PDGA discount code. PDGA's checkout can't be prefilled from a
// link, so the code sits beside the button with a copy control ("paste it at checkout"). The code comes from the
// server only for signed-in current club members (PDGA asks clubs to keep it within the club).
import React from "react";
import { PdgaCredit } from "./pdga-credit.js";
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
export function PdgaMembershipCard({ data, compact = false, credit = true }) {
  if (!data || !data.joinUrl) return null; // no answer (signed out, or the check failed): nothing to show
  const player = data.player;
  const status = player ? player.membershipStatus : null;
  const left = player ? daysUntil(player.membershipExpires) : null;
  const line = data.lookup === "none" ? "No PDGA number on your profile yet."
    : data.lookup === "unavailable" ? "PDGA couldn't be checked right now."
      : !player ? "PDGA has no player with the number on your profile."
        : status === "current"
          ? `Current PDGA member through ${player.membershipExpires || "the end of the year"}${left != null && left <= SOON_DAYS ? ` (${Math.max(0, left)} days left)` : ""}.`
          : `Your PDGA membership ${status === "expired" ? "expired" : "isn't current"}${player.membershipExpires ? ` (${player.membershipExpires})` : ""}.`;
  const renew = Boolean(player) && (status !== "current" || (left != null && left <= SOON_DAYS));
  const href = data.lookup === "none" || (!player && data.lookup === "ok") ? data.joinUrl : data.renewUrl;
  const label = data.lookup === "none" || (!player && data.lookup === "ok") ? "Join the PDGA" : renew ? "Renew with PDGA" : "Renew early with PDGA";
  return h("div", { className: `pdga-membership${compact ? " compact" : ""}`, "data-pdga-membership": status || data.lookup }, [
    h("h3", { key: "title" }, "PDGA membership"),
    h("p", { className: "player-card-meta", key: "line" }, line),
    h("div", { className: "member-action-grid", key: "actions" }, [
      h("a", { className: `player-btn${renew || data.lookup === "none" ? " primary" : ""}`, href, ...SIGNUP_LINK, key: "go" }, label),
    ]),
    data.promo ? h(PromoCode, { promo: data.promo, key: "promo" })
      : data.clubDiscountAvailable ? h("p", { className: "dash-note", key: "promo-note" }, "Current GVDG members get $5 off with the club's code.") : null,
    player && credit ? h(PdgaCredit, { key: "credit" }) : null,
  ]);
}
