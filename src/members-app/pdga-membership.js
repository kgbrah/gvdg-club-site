// The signed-in member's PDGA membership (GET /pdga/membership), for the Club page and, when it needs attention,
// Home. One shared answer for both. Coming back to the app after tapping Join / Renew asks PDGA again right away
// (?fresh=1), so a renewal clears the Home nudge (owner: "the notification should go away once the player has
// renewed"); "I've renewed" on the card does the same.
import React from "react";
import { requestJson, storageGet, TOKEN_KEY } from "./api.js";
import { clearPdgaRenewStarted, pdgaMembershipNeedsAttention, pdgaRenewPending } from "../shared/pdga-membership.js";

const listeners = new Set();
let latest = null;
const inflight = new Map();

/** Ask the server (fresh: ask PDGA now, not the stored answer); every card using the hook updates. */
export function refreshPdgaMembership({ fresh = false } = {}) {
  const token = storageGet(TOKEN_KEY);
  if (!token) return Promise.resolve(null);
  const key = fresh ? "fresh" : "stored";
  if (inflight.has(key)) return inflight.get(key);
  const pending = requestJson("/pdga/membership" + (fresh ? "?fresh=1" : ""), { token })
    .then((data) => {
      latest = data;
      listeners.forEach((listener) => listener(data));
      if (fresh && !pdgaMembershipNeedsAttention(data)) clearPdgaRenewStarted();
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

export function usePdgaMembership() {
  const [data, setData] = React.useState(latest);
  React.useEffect(() => {
    listeners.add(setData);
    refreshPdgaMembership({ fresh: pdgaRenewPending() }).catch(() => {});
    const back = () => {
      if (document.visibilityState === "visible" && pdgaRenewPending()) refreshPdgaMembership({ fresh: true }).catch(() => {});
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      listeners.delete(setData);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);
  return data;
}

/** For the card's "I've renewed". */
export const checkPdgaMembershipAgain = () => refreshPdgaMembership({ fresh: true });
