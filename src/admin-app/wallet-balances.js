// Admin › Money › Wallets: every member's store-credit balance (owner: "need admin to be able to view all member wallet
// balances"). Members with a balance first, highest first; the total store credit the club owes; a search that
// autocompletes names; "Adjust" fills the adjustment form above with that member. Refreshes after an adjustment.
import React from "react";
import { adminRequest } from "./admin-api.js";
import { AutocompleteInput } from "../shared/autocomplete.js";

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
      h("button", { className: "admin-btn secondary", type: "button", key: "adjust", onClick: () => adjust(member) }, "Adjust"),
    ]))) : null,
  ]);
}
