import React from "react";

import { requestJson } from "./api.js";

const listeners = new Set();
let cache = { token: "", at: 0, unread: 0, unseen: 0, market: 0, pending: null };

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
    });
  }).catch(() => {
    cache = { ...cache, pending: null };
  });
}

export function useInboxSummary(token) {
  const [summary, setSummary] = React.useState(() => (
    cache.token === token ? { unread: cache.unread, unseen: cache.unseen, market: cache.market } : { unread: 0, unseen: 0, market: 0 }
  ));

  React.useEffect(() => {
    if (!token) return undefined;
    let live = true;
    const apply = (next) => {
      if (live && next.token === token) setSummary({ unread: next.unread, unseen: next.unseen, market: next.market || 0 });
    };
    listeners.add(apply);
    refreshInbox(token);
    const timer = window.setInterval(() => refreshInbox(token, true), 45000);
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

  return { unread: summary.unread, unseen: summary.unseen, market: summary.market || 0, total: summary.unread + summary.unseen };
}
