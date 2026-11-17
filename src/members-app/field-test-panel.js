import React from "react";
import { ClipboardList, Download, FileText, FlaskConical, RefreshCw, Share2, Trash2 } from "lucide-react";

import {
  activeFieldRecorder, FIELD_GUIDE_HREF, FIELD_TEST_DEVICE_KEY, subscribeFieldTest,
} from "../shared/field-test-gate.js";
import { FIELD_PRIVACY_COPY, FieldNoteForm, FieldTestSwitch, useFieldTestMode } from "../shared/field-test-ui.js";
import { fieldLogStore } from "../shared/field-test-store.js";
import { CONDITIONS, summarizeFieldLog } from "../shared/field-test-summary.js";
import { buildFieldExport, deviceFromEvents, eventsToCsv, fieldExportName } from "../shared/field-test-export.js";

const h = React.createElement;

function readLabel() {
  try { return localStorage.getItem(FIELD_TEST_DEVICE_KEY) || ""; } catch { return ""; }
}
function saveLabel(value) {
  try {
    if (value) localStorage.setItem(FIELD_TEST_DEVICE_KEY, value);
    else localStorage.removeItem(FIELD_TEST_DEVICE_KEY);
  } catch { /* the label is optional */ }
}

function ms(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 10_000 ? (value / 1000).toFixed(1) + " s" : Math.round(value) + " ms";
}
function seconds(value) {
  return Number.isFinite(value) ? (value / 1000).toFixed(1) + " s" : "—";
}
function minutes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 min";
  return value < 60_000 ? Math.round(value / 1000) + " s" : (value / 60_000).toFixed(1) + " min";
}
function clock(at) {
  try { return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}
function timeOnly(at) {
  try { return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }); } catch { return ""; }
}

async function readEvents() {
  const recorder = activeFieldRecorder();
  if (recorder) await recorder.flush().catch(() => {});
  return fieldLogStore().all();
}

function useFieldLog() {
  const [state, setState] = React.useState({ status: "loading", events: [], error: "" });
  const refresh = React.useCallback(async () => {
    try {
      const events = await readEvents();
      setState({ status: "ready", events, error: "" });
    } catch {
      setState((current) => ({ ...current, status: "error", error: "This phone's field log could not be read." }));
    }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => subscribeFieldTest(() => { void refresh(); }), [refresh]);
  return { ...state, refresh };
}

function Tile({ title, value, detail, tone, testId }) {
  return h("div", { className: "field-tile" + (tone ? " is-" + tone : ""), "data-field-tile": testId }, [
    h("span", { className: "field-tile-title", key: "title" }, title),
    h("strong", { className: "field-tile-value", key: "value" }, value),
    detail ? h("small", { className: "field-tile-detail", key: "detail" }, detail) : null,
  ]);
}

function liveLine(live) {
  const spectator = live.spectator?.delay;
  const scorer = live.scorer?.delay;
  if (spectator?.n) return { value: ms(spectator.median), detail: "Watch link · p90 " + ms(spectator.p90) + " · " + spectator.n + " updates" };
  if (scorer?.n) return { value: ms(scorer.median), detail: "Scorer socket · p90 " + ms(scorer.p90) + " · " + scorer.n + " updates" };
  return { value: "—", detail: "Open the watch link on a second phone" };
}

function FieldSummary({ summary }) {
  const live = liveLine(summary.live);
  const battery = summary.battery;
  const batteryDetail = battery.source === "api" ? battery.samples + " readings · " + battery.hours + " h off the charger"
    : battery.source === "notes" ? "From your battery notes · " + battery.hours + " h"
      : battery.apiAvailable ? "Read every 5 minutes. Needs 15 minutes off the charger."
        : "No battery API here. Add Battery % notes at the start and end.";
  return h("div", { className: "field-summary-grid", "data-field-summary": "ready" }, [
    h(Tile, { key: "feedback", testId: "feedback", title: "Score feedback", value: ms(summary.feedback.median),
      detail: summary.feedback.n ? "p90 " + ms(summary.feedback.p90) + " · max " + ms(summary.feedback.max) + " · " + summary.feedback.n + " taps" : "Tap − / + on a scorecard" }),
    h(Tile, { key: "ack", testId: "ack", title: "Server save", value: ms(summary.ack.median),
      detail: summary.ack.n ? "p90 " + ms(summary.ack.p90) + " · " + summary.ack.n + " saves" : "No saves yet" }),
    h(Tile, { key: "retries", testId: "retries", title: "Retries / failures", value: summary.ack.retries + " / " + summary.ack.failures,
      tone: summary.ack.authFailures ? "warn" : "",
      detail: "Most queued " + summary.ack.maxQueue + " · stale edits " + summary.ack.staleReviews + " · conflicts " + summary.ack.conflicts }),
    h(Tile, { key: "offline", testId: "offline", title: "Offline", value: minutes(summary.network.offlineMs),
      detail: summary.network.offlineCount + " drops · " + summary.network.reconnects + " reconnects · recovery " + seconds(summary.network.recovery.median) }),
    h(Tile, { key: "live", testId: "live", title: "Live update delay", value: live.value, detail: live.detail }),
    h(Tile, { key: "rounds", testId: "rounds", title: "Rounds finished", value: summary.rounds.finished + " of " + summary.rounds.started,
      tone: summary.rounds.suspected ? "warn" : "",
      detail: summary.rounds.suspected ? summary.rounds.suspected + " lost/duplicate suspected" : summary.rounds.checked ? "Final cards match this phone" : "Card check runs when a card locks" }),
    h(Tile, { key: "clips", testId: "clips", title: "Clips uploaded", value: summary.clips.successRate == null ? "—" : summary.clips.successRate + "%",
      detail: summary.clips.saved + " of " + summary.clips.attempted + " · " + summary.clips.failures + " failed tries" }),
    h(Tile, { key: "battery", testId: "battery", title: "Battery per hour",
      value: battery.pctPerHour == null ? "—" : battery.pctPerHour + "%", detail: batteryDetail }),
  ]);
}

function ConditionTable({ conditions, footer }) {
  return h("div", { className: "field-conditions", key: "conditions" },
    h("table", { key: "table" }, [
      h("caption", { key: "caption" }, "By connection"),
      h("thead", { key: "head" }, h("tr", null, [
        h("th", { scope: "col", key: "c" }, "Condition"),
        h("th", { scope: "col", key: "f" }, "Feedback"),
        h("th", { scope: "col", key: "a" }, "Save"),
      ])),
      h("tbody", { key: "body" }, CONDITIONS.map((name) => h("tr", { key: name }, [
        h("th", { scope: "row", key: "name" }, name[0].toUpperCase() + name.slice(1)),
        h("td", { key: "f" }, conditions[name].feedback.n ? ms(conditions[name].feedback.median) + " (" + conditions[name].feedback.n + ")" : "—"),
        h("td", { key: "a" }, conditions[name].ack.n ? ms(conditions[name].ack.median) + " (" + conditions[name].ack.n + ")" : "—"),
      ]))),
    ]),
    h("p", { className: "player-card-meta", key: "footer" }, footer));
}

function eventLine(event) {
  const bits = [event.type];
  if (event.target) bits.push(event.target);
  if (event.kind) bits.push(event.kind);
  if (event.chip) bits.push(event.chip);
  if (Number.isFinite(event.hole)) bits.push("hole " + event.hole);
  if (Number.isFinite(event.ms)) bits.push(ms(event.ms));
  if (event.state) bits.push(event.state);
  if (event.verdict) bits.push(event.verdict);
  if (Number.isFinite(event.level)) bits.push(event.level + "%");
  if (Number.isFinite(event.battery)) bits.push(event.battery + "%");
  return bits.join(" · ");
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function exportFiles(events, label) {
  const now = new Date();
  const data = buildFieldExport(events, { label, exportedAt: now });
  const json = JSON.stringify(data, null, 2);
  const csv = eventsToCsv(data.events);
  return {
    data,
    json: new File([json], fieldExportName(data.device, now, "json"), { type: "application/json" }),
    // Android's share sheet only takes some file types, so the JSON also has a plain-text twin.
    jsonText: new File([json], fieldExportName(data.device, now, "json") + ".txt", { type: "text/plain" }),
    csv: new File([csv], fieldExportName(data.device, now, "csv"), { type: "text/csv" }),
  };
}

function canShare(files) {
  try { return typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files }); } catch { return false; }
}

export function MemberFieldTestPage() {
  const on = useFieldTestMode();
  const log = useFieldLog();
  const [label, setLabel] = React.useState(readLabel);
  const [status, setStatus] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const labelId = React.useId();
  const summary = React.useMemo(() => summarizeFieldLog(log.events), [log.events]);
  const latest = log.events.slice(-12).reverse();
  const device = React.useMemo(() => deviceFromEvents(log.events), [log.events]);
  const build = device.commit ? "App build " + String(device.commit).slice(0, 7) : "App build not stamped";

  async function share() {
    setBusy(true);
    setStatus("");
    try {
      // Safari only opens the share sheet straight from the tap, so use the log this screen already read
      // (it refreshes when it opens, after notes and on Refresh) instead of waiting on storage again.
      const events = log.events.length ? log.events : await readEvents();
      if (!events.length) { setStatus("The log is empty. Turn on field test mode and play a round first."); return; }
      const files = exportFiles(events, label.trim());
      const sets = [[files.json, files.csv], [files.jsonText, files.csv]];
      const shareable = sets.find(canShare);
      if (shareable) {
        try {
          await navigator.share({ files: shareable, title: "GVDG field log", text: "Field test log" + (label.trim() ? " · " + label.trim() : "") });
          setStatus("Shared " + files.data.events.length + " events. Send them to the club.");
          return;
        } catch (error) {
          if (error && error.name === "AbortError") { setStatus("Sharing cancelled."); return; }
        }
      }
      downloadFile(files.json);
      downloadFile(files.csv);
      setStatus("Saved " + files.json.name + " and the CSV to this phone's downloads.");
    } catch {
      setStatus("Could not export the log. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    try {
      const events = await readEvents();
      const files = exportFiles(events, label.trim());
      downloadFile(files.json);
      downloadFile(files.csv);
      setStatus("Saved " + files.json.name + " and the CSV to this phone's downloads.");
    } catch {
      setStatus("Could not export the log. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const recorder = activeFieldRecorder();
      if (recorder) await recorder.flush().catch(() => {});
      await fieldLogStore().clear();
      setConfirming(false);
      setStatus("The field log on this phone is empty.");
      await log.refresh();
    } catch {
      setStatus("Could not clear the log. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return h("div", { className: "react-more-page member-subpage member-field-test", "data-member-field-test": log.status }, [
    h("section", { className: "player-card field-test-intro", "aria-labelledby": labelId + "-title", key: "intro" }, [
      h("h2", { id: labelId + "-title", key: "title" }, "Field test"),
      h("p", { className: "player-card-meta", key: "lead" }, "Play a real round with field test mode on. This phone records how fast scores show and save, connection drops, battery and your notes. Then send the log to the club."),
      h("div", { className: "member-link-list", key: "switch" }, h(FieldTestSwitch, {
        app: "members", rowClass: "member-link-row member-switch-row", copyClass: "member-link-copy",
        trackClass: "member-switch", knobClass: "member-switch-knob",
        icon: h(FlaskConical, { className: "member-link-icon", size: 19, "aria-hidden": true, key: "icon" }),
      })),
      h("label", { className: "field-device-label", htmlFor: labelId, key: "label" }, [
        h("span", { key: "text" }, "Phone name for the report"),
        h("input", {
          id: labelId, key: "input", className: "form-input", value: label, maxLength: 60, autoComplete: "off",
          placeholder: "Pixel 7 · Chrome", onChange: (event) => { setLabel(event.target.value); saveLabel(event.target.value.trim()); },
        }),
      ]),
      log.events.length ? h("p", { className: "player-card-meta", key: "build", "data-field-build": "" },
        build + " · offline cache " + (device.swCache || "not installed") + ". Write these on your sheet.") : null,
      h("p", { className: "player-card-meta field-privacy", key: "privacy" }, FIELD_PRIVACY_COPY),
      h("a", { className: "dashboard-action", href: FIELD_GUIDE_HREF, key: "guide" }, [
        h(ClipboardList, { size: 17, "aria-hidden": true, key: "icon" }), "Volunteer checklist",
      ]),
    ]),
    h("section", { className: "member-link-section field-summary-section", "aria-label": "Summary", key: "summary" }, [
      h("div", { className: "field-section-head", key: "head" }, [
        h("h2", { key: "title" }, "Summary"),
        h("button", { type: "button", className: "dashboard-action", key: "refresh", onClick: () => { void log.refresh(); } }, [
          h(RefreshCw, { size: 16, "aria-hidden": true, key: "icon" }), "Refresh",
        ]),
      ]),
      log.status === "error" ? h("p", { className: "dash-note", role: "alert", key: "error" }, log.error) : null,
      h(FieldSummary, { summary, key: "tiles" }),
      h(ConditionTable, {
        conditions: summary.conditions, key: "conditions",
        footer: summary.span.events
          ? summary.span.events + " events · " + summary.span.sessions + " app sessions · since " + clock(summary.span.first)
          : "No events yet.",
      }),
    ]),
    h("section", { className: "player-card field-notes", "aria-label": "Add note", key: "notes" }, [
      h("h2", { key: "title" }, "Add note"),
      on ? h(FieldNoteForm, { key: "form", className: "field-note-form", buttonClass: "dashboard-action", inputClass: "form-input", onAdded: () => { void log.refresh(); } })
        : h("p", { className: "player-card-meta", key: "off" }, "Turn on field test mode to add notes."),
    ]),
    h("section", { className: "player-card field-export", "aria-label": "Send the log", key: "export" }, [
      h("h2", { key: "title" }, "Send the log"),
      h("p", { className: "player-card-meta", key: "copy" }, "Export makes a JSON file with everything and a CSV of the events. Share them with the club organizer."),
      h("div", { className: "field-test-actions", key: "actions" }, [
        h("button", { type: "button", className: "dashboard-action primary", disabled: busy, onClick: share, key: "share", "data-field-export": "share" }, [
          h(Share2, { size: 17, "aria-hidden": true, key: "icon" }), "Export",
        ]),
        h("button", { type: "button", className: "dashboard-action", disabled: busy, onClick: download, key: "download", "data-field-export": "download" }, [
          h(Download, { size: 17, "aria-hidden": true, key: "icon" }), "Download files",
        ]),
        confirming ? null : h("button", { type: "button", className: "dashboard-action field-danger", disabled: busy || !log.events.length,
          onClick: () => setConfirming(true), key: "clear", "data-field-clear": "ask" }, [
          h(Trash2, { size: 17, "aria-hidden": true, key: "icon" }), "Clear log",
        ]),
      ]),
      confirming ? h("div", { className: "field-confirm", role: "alertdialog", "aria-label": "Clear the field log", key: "confirm" }, [
        h("p", { key: "copy" }, "Delete all " + log.events.length + " events from this phone? Export first if the club still needs them."),
        h("div", { className: "field-test-actions", key: "actions" }, [
          h("button", { type: "button", className: "dashboard-action field-danger", disabled: busy, onClick: clear, key: "yes", "data-field-clear": "confirm" }, "Delete log"),
          h("button", { type: "button", className: "dashboard-action", onClick: () => setConfirming(false), key: "no" }, "Cancel"),
        ]),
      ]) : null,
      h("p", { className: "player-card-meta", role: "status", "aria-live": "polite", key: "status", "data-field-status": "" }, status),
    ]),
    h("details", { className: "player-card field-latest", key: "latest" }, [
      h("summary", { key: "summary" }, [h(FileText, { size: 16, "aria-hidden": true, key: "icon" }), "Latest events"]),
      latest.length ? h("ol", { key: "list" }, latest.map((event) => h("li", { key: event.seq ?? event.at + event.type }, [
        h("time", { key: "time" }, timeOnly(event.at)), " ", eventLine(event),
      ]))) : h("p", { className: "player-card-meta", key: "empty" }, "Nothing recorded yet."),
    ]),
  ]);
}
