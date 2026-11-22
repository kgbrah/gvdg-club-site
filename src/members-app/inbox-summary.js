import React from "react";

import { requestJson } from "./api.js";

const listeners = new Set();
const NO_LOST_FOUND = { waiting: 0, recent: [] };
let cache = { token: "", at: 0, unread: 0, unseen: 0, market: 0, lostFound: NO_LOST_FOUND, pending: null };

// Lost & Found rides along the same request: what waits on the member and the latest returns (for Home).
function lostFoundOf(value) {
  const recent = Array.isArray(value?.recent) ? value.recent.filter((row) => row && typeof row.disc === "string").slice(0, 3) : [];
  return { waiting: Number(value?.waiting) || 0, recent };
}

function publish(next) {
  cache = { ...next, pending: null };
  listeners.forEach((listener) => listener(cache));
}

export function announceInboxChanged() {
  window.dispatchEvent(new CustomEvent("gvdg:inbox-changed"));
}

export function refreshInbox(token, force = false) {
  if (!token) return;
  const now = Date.now();
  if (!force && cache.token === token && now - cache.at < 12000) {
    listeners.forEach((listener) => listener(cache));
    return;
  }
  if (cache.pending && cache.token === token) return;
  cache = { ...cache, token, pending: true };
  requestJson("/me/messages/summary", { token }).then((data) => {
    publish({
      token,
      at: Date.now(),
      unread: Number(data?.unread) || 0,
      unseen: Number(data?.unseen) || 0,
      market: Number(data?.market) || 0,
      lostFound: lostFoundOf(data?.lostFound),
    });
  }).catch(() => {
    cache = { ...cache, pending: null };
  });
}

export function useInboxSummary(token) {
  const [summary, setSummary] = React.useState(() => (
    cache.token === token
      ? { unread: cache.unread, unseen: cache.unseen, market: cache.market, lostFound: cache.lostFound }
      : { unread: 0, unseen: 0, market: 0, lostFound: NO_LOST_FOUND }
  ));

  React.useEffect(() => {
    if (!token) return undefined;
    let live = true;
    const apply = (next) => {
      if (live && next.token === token) setSummary({ unread: next.unread, unseen: next.unseen, market: next.market || 0, lostFound: next.lostFound || NO_LOST_FOUND });
    };
    listeners.add(apply);
    refreshInbox(token);
    const timer = window.setInterval(() => { if (!document.hidden) refreshInbox(token, true); }, 45000);
    const onChange = () => refreshInbox(token, true);
    window.addEventListener("gvdg:inbox-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      live = false;
      listeners.delete(apply);
      window.clearInterval(timer);
      window.removeEventListener("gvdg:inbox-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [token]);

  return {
    unread: summary.unread, unseen: summary.unseen, market: summary.market || 0, lostFound: summary.lostFound || NO_LOST_FOUND,
    total: summary.unread + summary.unseen,
  };
}
