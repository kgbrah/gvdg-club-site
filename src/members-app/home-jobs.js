import React from "react";

import { requestJson } from "./api.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { dollars } from "./format.js";
import { memberAlert, memberConfirm } from "./member-dialogs.js";
import { pickUnpaidJobs } from "./registration-utils.js";
import {
  announceWalletUpdated,
  payEventWithWallet,
  walletPayErrorMessage,
} from "./registration-payments.js";
import { homeConditionRows } from "../shared/course-conditions-model.js";

const h = React.createElement;

function HomePayJob({ events, registrations, token, onReload }) {
  const jobs = pickUnpaidJobs(events, registrations);
  const [wallet, setWallet] = React.useState({ status: "idle", balanceCents: 0 });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!token || !jobs.length) {
      setWallet({ status: "idle", balanceCents: 0 });
      return undefined;
    }
    const controller = new AbortController();
    requestJson("/shop/wallet", { token, signal: controller.signal })
      .then((payload) => setWallet({ status: "ready", balanceCents: Number(payload.balance_cents || 0) }))
      .catch((error) => {
        if (error.name !== "AbortError") setWallet({ status: "ready", balanceCents: 0 });
      });
    return () => controller.abort();
  }, [token, jobs.length]);

  if (!jobs.length) return null;
  const first = jobs[0];
  const extra = jobs.length - 1;
  const canWallet = wallet.status === "ready" && wallet.balanceCents >= first.owed;

  async function onClick() {
    if (!canWallet) {
      selectDashboardTab("events");
      return;
    }
    const confirmed = await memberConfirm({
      confirmText: "Pay",
      message: `Pay ${dollars(first.owed)} from store credit for ${first.event.name || "this event"}?`,
      title: "Pay with store credit?",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await payEventWithWallet(first.event.id, token);
      if (!result.ok) {
        await memberAlert({
          message: walletPayErrorMessage(result.data.error),
          title: "Store credit payment failed",
        });
        return;
      }
      announceWalletUpdated();
      onReload?.();
    } finally {
      setBusy(false);
    }
  }

  return h("button", {
    type: "button",
    className: "player-keep-score player-pay-job",
    "data-react-home-pay": canWallet ? "wallet" : "due",
    disabled: busy,
    onClick,
  }, [
    h("div", { key: "copy" }, [
      h("h2", { key: "title" }, `Pay ${dollars(first.owed)}`),
      h("p", { key: "meta" }, extra
        ? `${first.event.name || "Club event"} + ${extra} more`
        : first.event.name || "Club event"),
    ]),
    h("span", { className: "player-keep-score-go", key: "go" }, busy ? "Paying..." : canWallet ? "Pay" : "Due"),
  ]);
}

function HomeConditionsCard() {
  const [state, setState] = React.useState({ status: "idle", reports: [] });

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", reports: [] });
    requestJson("/course-conditions", { signal: controller.signal })
      .then((payload) => setState({ status: "ready", reports: homeConditionRows(payload?.reports) }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ status: "ready", reports: [] });
      });
    return () => controller.abort();
  }, []);

  return h("section", {
    className: "player-card",
    "data-react-home-conditions": state.status,
  }, [
    h("div", { className: "player-job-head", key: "head" }, [
      h("h3", { key: "title" }, "Course conditions"),
      h("button", {
        type: "button",
        className: "player-job-link",
        onClick: () => selectDashboardTab("club"),
        key: "report",
      }, "Report"),
    ]),
    state.reports.length
      ? h("div", { className: "player-conditions", key: "list" }, state.reports.map((report) => h("div", {
        className: "player-condition-row",
        key: report.id || report.courseName,
      }, [
        h("div", { key: "copy" }, [
          h("div", { className: "player-condition-name", key: "name" }, report.courseName || "Course"),
          h("div", { className: "player-card-meta", key: "meta" }, [report.when, report.note].filter(Boolean).join(" · ")),
        ]),
        h("span", {
          className: "course-condition-badge " + report.status,
          "data-course-condition": report.status,
          key: "pill",
        }, report.label),
      ])))
      : h("p", { className: "player-card-meta", key: "empty" }, state.status === "loading" ? "Checking courses..." : "No reports in the last 48 hours."),
  ]);
}

export function HomeJobs({ events, registrations, token, onReload }) {
  return h("div", { className: "player-jobs", "data-react-home-jobs": "ready" }, [
    h(HomePayJob, { events, registrations, token, onReload, key: "pay" }),
    h(HomeConditionsCard, { key: "conditions" }),
  ]);
}
