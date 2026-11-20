// Admin › Money › Wallets: every member's store-credit balance (owner: "need admin to be able to view all member wallet
// balances"). Members with a balance first, highest first; the total store credit the club owes; a search that
// autocompletes names; "Adjust" fills the adjustment form above with that member. Refreshes after an adjustment.
import React from "react";
import { adminRequest } from "./admin-api.js";
import { AutocompleteInput } from "../shared/autocomplete.js";
import { currentAdminRoute } from "./admin-shell-state.js";

const h = React.createElement;

export function walletMoney(cents) {
  const value = Number(cents) || 0;
  const text = "$" + (Math.abs(value) / 100).toFixed(2);
  return value < 0 ? "-" + text : text;
}

function activityDate(iso) {
  const time = Date.parse(String(iso || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso || "")) ? "" : "Z"));
  return Number.isFinite(time) ? new Date(time).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "";
}

const SOURCE_LABELS = {
  manual_adjustment: "Admin adjustment",
  store_purchase: "Pro shop purchase",
  order_reversal: "Pro shop refund",
  event_entry: "Event entry",
  event_payout: "Event payout",
  sheet_import: "Google Sheet balance",
};

function activityTime(iso) {
  const time = Date.parse(String(iso || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso || "")) ? "" : "Z"));
  return Number.isFinite(time) ? new Date(time).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

/**
 * One ledger entry as the drill-down shows it: what it was (with the event or order), the signed amount, the balance
 * right after it (the running balance, newest first, from the member's current balance), and who posted it.
 */
export function walletLedgerRows(transactions, { balanceCents = 0, newerCents = 0, names = new Map() } = {}) {
  let after = (Number(balanceCents) || 0) - (Number(newerCents) || 0);
  return (Array.isArray(transactions) ? transactions : []).map((tx) => {
    const amount = Number(tx.amount_cents) || 0;
    const source = String(tx.source || "");
    const what = SOURCE_LABELS[source] || (source ? source.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Wallet entry");
    const detail = tx.event_name ? tx.event_name : tx.event_id ? "Event #" + tx.event_id : tx.order_id ? "Order #" + tx.order_id : "";
    const by = tx.created_by ? names.get(String(tx.created_by)) || String(tx.created_by) : "";
    const row = { id: tx.id, when: activityTime(tx.created_at), what, detail, note: tx.note ? String(tx.note) : "", amountCents: amount, balanceAfterCents: after, by };
    after -= amount;
    return row;
  });
}

function signedMoney(cents) {
  return (cents > 0 ? "+" : cents < 0 ? "−" : "") + walletMoney(Math.abs(cents));
}

/** A member's transactions, newest first, 25 at a time. */
function WalletLedger({ member, names }) {
  const [state, setState] = React.useState({ status: "loading", transactions: [], more: false, balanceCents: member.balanceCents });
  const load = React.useCallback(async (before) => {
    setState((current) => ({ ...current, status: before ? "more" : "loading" }));
    try {
      const response = await adminRequest(`/admin/wallets/${encodeURIComponent(member.memberId)}?page=1${before ? "&before=" + before : ""}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("load");
      setState((current) => ({
        status: "ready",
        balanceCents: Number(data.balance_cents) || 0,
        transactions: before ? current.transactions.concat(data.transactions || []) : (data.transactions || []),
        more: data.more === true,
      }));
    } catch {
      setState((current) => ({ ...current, status: "error" }));
    }
  }, [member.memberId]);
  React.useEffect(() => { load(null); }, [load, member.balanceCents]);
  const rows = walletLedgerRows(state.transactions, { balanceCents: state.balanceCents, names });
  const last = state.transactions[state.transactions.length - 1];
  return h("div", { className: "admin-wallet-ledger", "data-wallet-ledger": state.status }, [
    state.status === "loading" ? h("p", { className: "al-note", key: "loading" }, "Loading transactions…") : null,
    state.status === "error" ? h("p", { className: "al-note", role: "alert", key: "error" }, "Couldn't load transactions.") : null,
    state.status !== "loading" && !rows.length && state.status !== "error" ? h("p", { className: "al-note", key: "none" }, "No transactions yet.") : null,
    rows.length ? h("ol", { className: "admin-wallet-ledger-list", key: "list" }, rows.map((row) => h("li", { className: "admin-wallet-tx", "data-wallet-tx": row.id, key: row.id }, [
      h("div", { className: "admin-wallet-tx-top", key: "top" }, [
        h("span", { className: "admin-wallet-tx-what", key: "what" }, row.detail ? `${row.what}: ${row.detail}` : row.what),
        h("span", { className: "admin-wallet-tx-amount" + (row.amountCents < 0 ? " debit" : " credit"), key: "amount" }, signedMoney(row.amountCents)),
      ]),
      row.note ? h("div", { className: "admin-wallet-tx-note", key: "note" }, row.note) : null,
      h("div", { className: "admin-event-meta", key: "meta" }, [row.when, "balance after " + walletMoney(row.balanceAfterCents), row.by ? "by " + row.by : null].filter(Boolean).join(" · ")),
    ]))) : null,
    state.more ? h("button", { className: "admin-btn secondary", type: "button", key: "older", disabled: state.status === "more", onClick: () => load(last?.id) },
      state.status === "more" ? "Loading…" : "Show older transactions") : null,
  ]);
}

/** The rows to show: a name/PDGA search, then members with a balance (or everyone, when asked). */
export function visibleWalletRows(members, { query = "", showZero = false } = {}) {
  const typed = String(query).trim().toLowerCase();
  return (Array.isArray(members) ? members : []).filter((member) => {
    if (!showZero && !typed && !member.balanceCents) return false;
    if (!typed) return true;
    return String(member.name || "").toLowerCase().includes(typed) || String(member.pdgaNo || "").includes(typed);
  });
}

export function AdminWalletBalances() {
  const [state, setState] = React.useState({ status: "loading", members: [], totalCents: 0, withBalance: 0 });
  const [query, setQuery] = React.useState("");
  const [showZero, setShowZero] = React.useState(false);
  const [open, setOpen] = React.useState(() => new Set());
  // Arriving from Admin › Members › Wallet: open that member's transactions.
  const [arriving, setArriving] = React.useState(() => (currentAdminRoute().tab === "wallets" ? currentAdminRoute().memberId || "" : ""));
  React.useEffect(() => {
    const route = (event) => { if (event.detail?.tab === "wallets" && event.detail.memberId) setArriving(String(event.detail.memberId)); };
    window.addEventListener("gvdg:admin-active-tab", route);
    return () => window.removeEventListener("gvdg:admin-active-tab", route);
  }, []);
  React.useEffect(() => {
    if (!arriving || state.status !== "ready") return;
    const key = arriving.toLowerCase();
    const member = state.members.find((row) => [row.memberId, row.pdgaNo, row.udisc].some((id) => id && String(id).toLowerCase() === key));
    setArriving("");
    if (!member) return;
    setQuery(member.name);
    setOpen((current) => new Set(current).add(member.memberId));
  }, [arriving, state.status, state.members]);
  const names = React.useMemo(() => new Map(state.members.map((member) => [member.memberId, member.name])), [state.members]);
  function toggle(memberId) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId); else next.add(memberId);
      return next;
    });
  }
  const load = React.useCallback(async () => {
    try {
      const response = await adminRequest("/admin/wallets/balances");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("load");
      setState({ status: "ready", members: data.members || [], totalCents: data.totalCents || 0, withBalance: data.withBalance || 0 });
      // The adjustment form above autocompletes from the same members.
      window.dispatchEvent(new CustomEvent("gvdg:admin-wallet-roster", { detail: { members: data.members || [] } }));
    } catch {
      setState((current) => ({ ...current, status: "error" }));
    }
  }, []);
  React.useEffect(() => {
    load();
    const again = (event) => { if (event.detail?.ok === true) load(); };
    window.addEventListener("gvdg:admin-wallet-adjustment-result", again);
    return () => window.removeEventListener("gvdg:admin-wallet-adjustment-result", again);
  }, [load]);

  const rows = visibleWalletRows(state.members, { query, showZero });
  function adjust(member) {
    window.dispatchEvent(new CustomEvent("gvdg:admin-wallet-member", { detail: { memberId: member.memberId, name: member.name } }));
    document.getElementById("adminWalletForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return h("section", { className: "al-section admin-wallet-balances", "data-admin-wallet-balances": state.status }, [
    h("h4", { className: "al-h", key: "title" }, "Member balances"),
    state.status === "ready" ? h("p", { className: "al-note", key: "total", "data-wallet-total": state.totalCents },
      `${walletMoney(state.totalCents)} in store credit across ${state.withBalance} member${state.withBalance === 1 ? "" : "s"}.`) : null,
    state.status === "error" ? h("p", { className: "al-note", role: "alert", key: "error" }, "Couldn't load balances.") : null,
    state.status === "loading" ? h("p", { className: "al-note", key: "loading" }, "Loading balances…") : null,
    h("div", { className: "admin-wallet-balance-tools", key: "tools" }, [
      h("label", { htmlFor: "walletBalanceSearch", className: "admin-wallet-search-label", key: "label" }, "Find a member's balance"),
      h(AutocompleteInput, {
        id: "walletBalanceSearch", key: "search", type: "search", maxLength: 60, value: query, placeholder: "Find a member",
        "aria-label": "Find a member's balance",
        suggestions: state.members.map((member) => ({ label: member.name, value: member.name, hint: walletMoney(member.balanceCents), key: member.memberId })),
        onChange: (event) => setQuery(event.target.value),
      }),
      h("label", { className: "admin-wallet-zero", key: "zero" }, [
        h("input", { type: "checkbox", checked: showZero, onChange: (event) => setShowZero(event.target.checked), key: "box" }), " Show $0 balances",
      ]),
    ]),
    state.status === "ready" && !rows.length ? h("p", { className: "al-note", key: "none" }, query.trim() ? "No member matches." : "No member has store credit.") : null,
    rows.length ? h("ul", { className: "admin-wallet-balance-list", key: "list" }, rows.map((member) => h("li", {
      className: "admin-evrow", "data-wallet-member": member.memberId, key: member.memberId,
    }, [
      h("span", { className: "ev-name", key: "name" }, member.name + (member.onRoster === false ? " (no longer on the roster)" : "")),
      h("span", { className: "admin-wallet-balance" + (member.balanceCents < 0 ? " negative" : ""), key: "balance" }, walletMoney(member.balanceCents)),
      h("span", { className: "admin-event-meta", key: "meta" }, [
        member.pdgaNo ? "PDGA #" + member.pdgaNo : null,
        member.transactions ? `${member.transactions} transaction${member.transactions === 1 ? "" : "s"}` : "No activity",
        member.lastActivityAt ? "last " + activityDate(member.lastActivityAt) : null,
      ].filter(Boolean).join(" · ")),
      h("div", { className: "admin-wallet-actions", key: "actions" }, [
        member.transactions ? h("button", {
          className: "admin-btn secondary", type: "button", key: "history", "aria-expanded": open.has(member.memberId) ? "true" : "false",
          onClick: () => toggle(member.memberId),
        }, open.has(member.memberId) ? "Hide transactions" : "Transactions") : null,
        h("button", { className: "admin-btn secondary", type: "button", key: "adjust", onClick: () => adjust(member) }, "Adjust"),
      ]),
      open.has(member.memberId) ? h(WalletLedger, { member, names, key: "ledger" }) : null,
    ]))) : null,
  ]);
}
