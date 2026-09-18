import React from "react";

import { requestJson } from "./api.js";
import { selectDashboardTab } from "./dashboard-shell.js";
import { dollars } from "./format.js";
import { pickUnpaidJobs } from "./registration-utils.js";
import { homeConditionRows } from "../shared/course-conditions-model.js";

const h = React.createElement;

function HomePayJob({ events, registrations, paymentsConfig }) {
  const jobs = pickUnpaidJobs(events, registrations);
  if (!jobs.length) return null;
  const first = jobs[0];
  const extra = jobs.length - 1;
  return h("button", {
    type: "button",
    className: "player-keep-score player-pay-job",
    "data-react-home-pay": "due",
    onClick: () => selectDashboardTab("events"),
  }, [
    h("div", { key: "copy" }, [
      h("h2", { key: "title" }, `Pay ${dollars(first.owed)}`),
      h("p", { key: "meta" }, extra
        ? `${first.event.name || "Club event"} + ${extra} more`
        : first.event.name || "Club event"),
    ]),
    h("span", { className: "player-keep-score-go", key: "go" }, paymentsConfig?.enabled ? "Pay" : "Due"),
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

export function HomeJobs({ events, registrations, paymentsConfig }) {
  return h("div", { className: "player-jobs", "data-react-home-jobs": "ready" }, [
    h(HomePayJob, { events, registrations, paymentsConfig, key: "pay" }),
    h(HomeConditionsCard, { key: "conditions" }),
  ]);
}
