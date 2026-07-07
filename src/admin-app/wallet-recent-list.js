import React from "react";

const h = React.createElement;

const EMPTY_STATE = { status: "loading", transactions: [] };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function currentState() {
  const state = window.__gvdgAdminWalletRecentState;
  return state && typeof state === "object" ? state : EMPTY_STATE;
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
    amountCents: normalizeAmount(source.amount_cents),
    createdAt: normalizeText(source.created_at),
    memberId: normalizeText(source.member_id),
    memberName: normalizeText(source.member_name),
    note: normalizeText(source.note),
    sourceName: normalizeText(source.source, "wallet") || "wallet",
  };
}

function normalizeState(state) {
  return {
    status: state.status === "loading" ? "loading" : "ready",
    transactions: Array.isArray(state.transactions) ? state.transactions.map(normalizeTransaction) : [],
  };
}

function dollarsFromCents(cents) {
  const n = Number(cents || 0);
  const abs = Math.abs(n);
  const out = "$" + (abs / 100).toLocaleString(undefined, { minimumFractionDigits: abs % 100 ? 2 : 0 });
  return n < 0 ? "-" + out : out;
}

function transactionTitle(transaction) {
  return `${transaction.memberName || transaction.memberId || "Member"} - ${transaction.sourceName}`;
}

function transactionMeta(transaction) {
  return [transaction.note, transaction.createdAt].filter(Boolean).join(" - ");
}

function WalletTransactionRow({ transaction, index }) {
  const amountClass = transaction.amountCents >= 0 ? "credit" : "debit";
  const amountText = `${transaction.amountCents >= 0 ? "+" : ""}${dollarsFromCents(transaction.amountCents)}`;

  return h("div", { className: "wallet-row", "data-admin-wallet-row": String(index) }, [
    h("div", { key: "left" }, [
      h("strong", { key: "title" }, transactionTitle(transaction)),
      h("div", { className: "shop-admin-meta", key: "meta" }, transactionMeta(transaction)),
    ]),
    h("span", { className: amountClass, key: "amount" }, amountText),
  ]);
}

export function AdminWalletRecentList() {
  const [state, setState] = React.useState(() => normalizeState(currentState()));

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : currentState()));
    }
    window.addEventListener("gvdg:admin-wallet-recent", update);
    setState(normalizeState(currentState()));
    return () => window.removeEventListener("gvdg:admin-wallet-recent", update);
  }, []);

  if (state.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-wallet-recent": "loading", role: "status" }, "Loading...");
  }

  if (!state.transactions.length) {
    return h("p", { className: "al-note", "data-react-admin-wallet-recent": "empty", role: "status" }, "No wallet activity yet.");
  }

  return h("div", { className: "wallet-ledger", "data-react-admin-wallet-recent": "ready" }, state.transactions.map((transaction, index) => (
    h(WalletTransactionRow, {
      index,
      key: `${transaction.memberId || transaction.memberName || "member"}-${transaction.createdAt || index}-${transaction.amountCents}`,
      transaction,
    })
  )));
}
