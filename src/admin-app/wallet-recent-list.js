import React from "react";
import { ChevronDown } from "lucide-react";

import { adminJson } from "./admin-api.js";
import { useSettledWhileLoading } from "../shared/settled-state.js";
import { currentAdminActiveTab, currentAdminAuthGateState } from "./admin-shell-state.js";
import { describeWalletTx, signedMoney, WalletLedger } from "./wallet-balances.js";

const h = React.createElement;

const EMPTY_STATE = { status: "idle", transactions: [] };
const LOADING_STATE = { status: "loading", transactions: [] };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeAmount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTransaction(transaction) {
  const source = objectOrEmpty(transaction);
  return {
    id: source.id,
    amountCents: normalizeAmount(source.amount_cents),
    createdAt: normalizeText(source.created_at),
    memberId: normalizeText(source.member_id),
    memberName: normalizeText(source.member_name),
    note: normalizeText(source.note),
    sourceName: normalizeText(source.source, "wallet") || "wallet",
    raw: source,
  };
}

function normalizeState(state) {
  const status = state.status === "idle" || state.status === "loading" || state.status === "error" ? state.status : "ready";
  return {
    status,
    transactions: Array.isArray(state.transactions) ? state.transactions.map(normalizeTransaction) : [],
  };
}

/**
 * One ledger entry in words (owner: "Let's extend the drill down to the ledger too"): who, what it was (and for which
 * event or order), when, who posted it. Tapping it opens that member's whole wallet history right under it.
 */
function WalletTransactionRow({ transaction, index, names, open, onToggle }) {
  const about = describeWalletTx(transaction.raw, names);
  const who = names.get(transaction.memberId) || transaction.memberName || transaction.memberId || "Member";
  const member = React.useMemo(() => ({ memberId: transaction.memberId, balanceCents: 0 }), [transaction.memberId]);
  return h("div", { className: "wallet-row-wrap" + (open ? " open" : ""), "data-admin-wallet-row": String(index) }, [
    h("button", {
      className: "wallet-row", type: "button", key: "row", disabled: !transaction.memberId,
      "aria-expanded": open ? "true" : "false", "aria-label": `${who}, ${about.what}, ${signedMoney(about.amountCents)}. ${open ? "Hide" : "Show"} ${who}'s wallet history`,
      onClick: onToggle,
    }, [
      // Name, amount and arrow on the first line; what it was and when underneath, the full width (narrow phones).
      h("strong", { key: "title" }, who),
      h("span", { className: about.amountCents >= 0 ? "credit" : "debit", key: "amount" }, signedMoney(about.amountCents)),
      h(ChevronDown, { className: "wallet-row-chevron", "aria-hidden": true, size: 18, key: "chevron" }),
      h("div", { className: "wallet-row-what wallet-row-full", key: "what" }, about.detail ? `${about.what}: ${about.detail}` : about.what),
      about.note ? h("div", { className: "shop-admin-meta wallet-row-full", key: "note" }, about.note) : null,
      h("div", { className: "shop-admin-meta wallet-row-full", key: "meta" }, [about.when, about.by ? "by " + about.by : null].filter(Boolean).join(" · ")),
    ]),
    open ? h("div", { className: "wallet-row-history", key: "history" }, [
      h("p", { className: "al-note", key: "title" }, `${who}'s wallet history`),
      h(WalletLedger, { member, names, key: "ledger" }),
    ]) : null,
  ]);
}

export function AdminWalletRecentList() {
  const [state, setState] = React.useState(() => normalizeState(EMPTY_STATE));
  const [adminReady, setAdminReady] = React.useState(() => currentAdminAuthGateState().status === "panel");
  const [activeTab, setActiveTab] = React.useState(() => currentAdminActiveTab());
  const [refreshCount, setRefreshCount] = React.useState(0);
  const [openRow, setOpenRow] = React.useState(null);
  // Current names (for members and for the admins who posted), from the balances list on this screen.
  const [roster, setRoster] = React.useState([]);
  React.useEffect(() => {
    const take = (event) => setRoster(Array.isArray(event.detail?.members) ? event.detail.members : []);
    window.addEventListener("gvdg:admin-wallet-roster", take);
    return () => window.removeEventListener("gvdg:admin-wallet-roster", take);
  }, []);
  const shouldLoad = adminReady && activeTab === "wallets";

  React.useEffect(() => {
    function updateAuth(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : currentAdminAuthGateState();
      setAdminReady(detail.status === "panel");
    }
    function updateTab(event) {
      const tab = event.detail && typeof event.detail.tab === "string" ? event.detail.tab : currentAdminActiveTab();
      setActiveTab(tab);
    }
    function refreshAfterAdjustment(event) {
      if (event.detail?.ok === true) setRefreshCount((count) => count + 1);
    }

    window.addEventListener("gvdg:admin-auth-gate", updateAuth);
    window.addEventListener("gvdg:admin-active-tab", updateTab);
    window.addEventListener("gvdg:admin-wallet-adjustment-result", refreshAfterAdjustment);
    setAdminReady(currentAdminAuthGateState().status === "panel");
    setActiveTab(currentAdminActiveTab());
    return () => {
      window.removeEventListener("gvdg:admin-auth-gate", updateAuth);
      window.removeEventListener("gvdg:admin-active-tab", updateTab);
      window.removeEventListener("gvdg:admin-wallet-adjustment-result", refreshAfterAdjustment);
    };
  }, []);

  React.useEffect(() => {
    if (!shouldLoad) return undefined;
    const controller = new AbortController();
    setState(normalizeState(LOADING_STATE));
    adminJson("/admin/wallets/recent", { signal: controller.signal })
      .then((data) => {
        setState(normalizeState({ status: "ready", transactions: data?.transactions }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setState(normalizeState({ status: "error", transactions: [] }));
      });
    return () => controller.abort();
  }, [shouldLoad, refreshCount]);

  const view = useSettledWhileLoading(state);
  const names = React.useMemo(() => {
    const map = new Map(view.transactions.filter((tx) => tx.memberId && tx.memberName).map((tx) => [tx.memberId, tx.memberName]));
    for (const member of roster) if (member?.memberId && member.name) map.set(member.memberId, member.name);
    return map;
  }, [view.transactions, roster]);

  if (view.status === "idle" || view.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-wallet-recent": "loading", role: "status" }, "Loading…");
  }

  if (view.status === "error") {
    return h("p", { className: "al-note", "data-react-admin-wallet-recent": "error", role: "alert" }, "Wallet activity could not load.");
  }

  if (!view.transactions.length) {
    return h("p", { className: "al-note", "data-react-admin-wallet-recent": "empty", role: "status" }, "No wallet activity yet.");
  }

  return h("div", { className: "wallet-ledger", "data-react-admin-wallet-recent": "ready" }, view.transactions.map((transaction, index) => {
    const rowKey = String(transaction.id ?? `${transaction.memberId || transaction.memberName || "member"}-${transaction.createdAt || index}-${transaction.amountCents}`);
    return h(WalletTransactionRow, {
      index, key: rowKey, transaction, names, open: openRow === rowKey,
      onToggle: () => setOpenRow((current) => (current === rowKey ? null : rowKey)),
    });
  }));
}
