import React from "react";
import { ArrowRight, ChevronRight, Wallet } from "lucide-react";
import { selectDashboardTab } from "./dashboard-shell.js";

import { RECENT_ROUNDS_KEY, localStorageGet, requestJson } from "./api.js";
import { dollars, formatEventDay } from "./format.js";
import { parseClubInstant } from "../shared/events-model.js";

const h = React.createElement;

function roundMeta(parts) {
  return parts.filter(Boolean).join(" - ");
}

function walletDate(value) {
  const date = parseClubInstant(value);
  return date
    ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })
    : "";
}

function walletSource(source) {
  if (source === "event_payout") return "Event payout";
  if (source === "event_entry") return "Event entry";
  if (source === "store_purchase") return "Pro shop";
  if (source === "manual_adjustment") return "Admin adjustment";
  return "Store credit";
}

function recentCasualRounds() {
  try {
    const rows = JSON.parse(localStorageGet(RECENT_ROUNDS_KEY) || "[]");
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      code: String(row?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      label: String(row?.label || ""),
      updatedAt: Number(row?.updatedAt || 0),
    })).filter((row) => {
      if (!row.code || seen.has(row.code)) return false;
      seen.add(row.code);
      return true;
    }).slice(0, 8);
  } catch {
    return [];
  }
}

async function loadRecentCasualRows(token, signal) {
  const checks = recentCasualRounds().map(async (row) => {
    try {
      const data = await requestJson(`/rounds/${encodeURIComponent(row.code)}/live/mine`, { token, signal });
      const cardmates = Array.isArray(data.cardmates) ? data.cardmates : [];
      if (data.status !== "live" || data.cardId == null || !cardmates.length) return null;
      const names = cardmates.map((player) => player?.name).filter(Boolean).slice(0, 4).join(", ");
      return {
        kind: "round",
        title: row.label || `Casual round ${row.code}`,
        meta: names ? `Card: ${names}` : "Casual card in progress",
        href: `score.html?round=${encodeURIComponent(row.code)}`,
        sort: row.updatedAt || 0,
      };
    } catch {
      return null;
    }
  });
  return (await Promise.all(checks)).filter(Boolean);
}

function LiveRoundCard({ item }) {
  return h("div", { className: "live-round-card" }, [
    h("div", { key: "body" }, [
      h("span", { className: "live-round-badge", key: "badge" }, item.kind === "event" ? "Club event" : "Casual round"),
      h("div", { className: "live-round-title", key: "title" }, item.title),
      item.meta ? h("div", { className: "live-round-meta", key: "meta" }, item.meta) : null,
    ]),
    h("a", { className: "passkey-btn", href: item.href, key: "link" }, "Rejoin scorecard"),
  ]);
}

export function LiveScoringPanel({ token, compact = false, variant = "home", onCasualActive }) {
  const [state, setState] = React.useState({ status: "idle", items: [] });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", items: [] });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", items: [] });
    Promise.all([
      requestJson("/my-live-rounds", { token, signal: controller.signal }).catch(() => ({ rounds: [] })),
      loadRecentCasualRows(token, controller.signal),
    ]).then(([events, casualRows]) => {
      const eventRows = (Array.isArray(events.rounds) ? events.rounds : []).map((event) => ({
        kind: "event",
        title: event.name || "Live club event",
        meta: roundMeta([formatEventDay(event.date), event.course_name, event.layout_name, event.division]),
        href: `score.html?event=${encodeURIComponent(event.id)}`,
        sort: Date.parse(event.date || "") || 0,
      }));
      if (controller.signal.aborted) return;
      onCasualActive?.(casualRows.length > 0);
      setState({ status: "ready", items: eventRows.concat(casualRows).sort((a, b) => (b.sort || 0) - (a.sort || 0)) });
    }).catch((error) => {
      if (error.name !== "AbortError") setState({ status: "ready", items: [] });
    });
    return () => controller.abort();
  }, [token, onCasualActive]);

  if (!token) return null;
  const count = state.items.length;
  if (variant === "play") {
    return h("section", { className: "player-card", "data-react-live-scoring": state.status, "data-react-play-live": "ready" }, [
      h("h3", { key: "title" }, "Your cards"),
      count
        ? h("div", { className: "live-round-list", key: "list" }, state.items.map((item) => h(LiveRoundCard, { item, key: `${item.kind}-${item.href}` })))
        : h("p", { className: "player-card-meta", key: "empty" }, state.status === "loading" ? "Looking for a live card…" : "No live card yet."),
    ]);
  }
  if (compact) {
    const live = state.items[0];
    const extras = state.items.slice(1);
    return h("div", { className: "player-keep-score-wrap", "data-react-live-scoring": state.status }, [
      h("a", {
        className: "player-keep-score member-round-hero",
        href: live?.href || "score.html?start=1",
        key: "cta",
      }, [
        h("div", { className: "member-round-copy", key: "copy" }, [
          live ? h("span", { className: "member-round-status", key: "status" },
            live.kind === "event" ? "Club event in progress" : "Casual round in progress") : null,
          h("h2", { key: "title" }, live ? "Continue round" : "Start a round"),
          h("p", { key: "meta" }, live?.title || "Open a casual scorecard"),
        ]),
        h("span", { className: "member-round-arrow", key: "go" }, h(ArrowRight, { size: 23, "aria-hidden": true })),
      ]),
      extras.length
        ? h("div", { className: "live-round-list", key: "extras" }, extras.map((item) => h(LiveRoundCard, { item, key: `${item.kind}-${item.href}` })))
        : null,
    ]);
  }
  return h("details", { className: "club-board react-live-scoring dash-collapse", "data-react-live-scoring": state.status }, [
    h("summary", { className: "my-dashboard-title dash-collapse-summary", key: "title" }, count ? `Live Scoring (${count})` : "Live Scoring"),
    h("div", { className: "live-round-list", key: "list" }, count
      ? state.items.map((item) => h(LiveRoundCard, { item, key: `${item.kind}-${item.href}` }))
      : h("p", { className: "dash-note" }, "No live cards.")),
  ]);
}

function WalletLine({ transaction }) {
  const cents = Number(transaction.amount_cents || 0);
  const when = walletDate(transaction.created_at);
  return h("div", { className: "wallet-line" }, [
    h("div", { className: "wallet-line-main", key: "main" }, [
      h("div", { className: "wallet-source", key: "source" }, `${walletSource(transaction.source)}${when ? ` - ${when}` : ""}`),
      transaction.note ? h("div", { className: "wallet-note", key: "note" }, transaction.note) : null,
    ]),
    h("div", { className: `wallet-amount ${cents >= 0 ? "credit" : "debit"}`, key: "amount" }, `${cents >= 0 ? "+" : ""}${dollars(cents)}`),
  ]);
}

export function WalletPanel({ token, compact = false }) {
  const [state, setState] = React.useState({ status: "idle", wallet: null });

  React.useEffect(() => {
    if (!token) {
      setState({ status: "idle", wallet: null });
      return undefined;
    }
    const controller = new AbortController();
    function load() {
      setState((current) => ({ ...current, status: current.wallet ? current.status : "loading" }));
      requestJson("/shop/wallet", { token, signal: controller.signal })
        .then((wallet) => setState({ status: "ready", wallet }))
        .catch((error) => {
          if (error.name !== "AbortError") setState({ status: "error", wallet: null });
        });
    }
    load();
    window.addEventListener("gvdg:wallet-updated", load);
    return () => {
      controller.abort();
      window.removeEventListener("gvdg:wallet-updated", load);
    };
  }, [token]);

  if (!token) return null;
  if (!state.wallet) {
    return compact ? null : h("p", { className: "dash-note", role: "status" },
      state.status === "error" ? "Wallet is temporarily unavailable." : "Loading wallet…");
  }
  if (compact) {
    return h("a", {
      className: "member-account-row member-account-link react-wallet-panel",
      href: "#wallet",
      onClick: (event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        selectDashboardTab("wallet");
      },
      "data-react-wallet": state.status,
    }, [
      h(Wallet, { className: "member-account-icon", key: "icon", size: 20, "aria-hidden": true }),
      h("span", { className: "member-account-copy", key: "copy" }, [
        h("strong", { key: "label" }, "Wallet"),
        h("small", { key: "hint" }, "Store credit"),
      ]),
      h("strong", { className: "member-account-value", key: "amount" }, dollars(state.wallet.balance_cents || 0)),
      h(ChevronRight, { className: "member-account-chevron", size: 18, "aria-hidden": true, key: "arrow" }),
    ]);
  }
  const transactions = (Array.isArray(state.wallet.transactions) ? state.wallet.transactions : []).slice(0, 4);
  return h("div", { className: "wallet-panel react-wallet-panel", "data-react-wallet": state.status }, [
    h("div", { key: "balance" }, [
      h("div", { className: "wallet-label", key: "label" }, "Store credit wallet"),
      h("div", { className: "wallet-balance", key: "amount" }, dollars(state.wallet.balance_cents || 0)),
    ]),
    h("a", { className: "dashboard-action primary", href: "pro-shop.html", key: "shop" }, "Shop with credit"),
    h("div", { className: "wallet-ledger", key: "ledger" }, transactions.length
      ? transactions.map((transaction, index) => h(WalletLine, { transaction, key: transaction.id || index }))
      : h("div", { className: "wallet-empty" }, "No store credit activity yet.")),
  ]);
}
