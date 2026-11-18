// Export formats for the field test log: one JSON file with everything (device, summary, events) and a
// CSV of the events for a spreadsheet. Both are run through the privacy filter again on the way out.
import { sanitizeFieldEvent } from "./field-test-privacy.js";
import { summarizeFieldLog } from "./field-test-summary.js";

export const FIELD_EXPORT_SCHEMA = "gvdg-field-log/1";
export const CSV_COLUMNS = Object.freeze(["seq", "time", "session", "app", "type", "net", "eff", "ms", "target", "kind", "hole", "state", "status", "detail"]);
const CORE = new Set(["seq", "at", "t", "sid", "app", "type", "net", "eff", "ms", "target", "kind", "hole", "state", "status"]);

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with = + - @, a tab or a
 * carriage return) gets a leading apostrophe; cells with commas, quotes or line breaks are quoted.
 * Numbers stay numbers, so a negative delay is still -12.
 */
export function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function eventsToCsv(events) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const event of Array.isArray(events) ? events : []) {
    const detail = {};
    for (const [key, value] of Object.entries(event || {})) if (!CORE.has(key)) detail[key] = value;
    const row = {
      seq: event.seq ?? null,
      time: Number.isFinite(event.at) ? new Date(event.at).toISOString() : "",
      session: event.sid ?? "",
      app: event.app ?? "",
      type: event.type ?? "",
      net: event.net ?? "",
      eff: event.eff ?? "",
      ms: Number.isFinite(event.ms) ? event.ms : null,
      target: event.target ?? "",
      kind: event.kind ?? "",
      hole: Number.isFinite(event.hole) ? event.hole : null,
      state: event.state ?? "",
      status: event.status ?? "",
      detail: Object.keys(detail).length ? JSON.stringify(detail) : "",
    };
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function slug(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

export function fieldExportName(device, at = new Date(), extension = "json") {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const label = slug(device?.label) || "phone";
  return "gvdg-field-log-" + label + "-" + stamp + "." + extension;
}

/** The latest session context in the log, used to describe the device in an export. */
export function deviceFromEvents(events, label = "") {
  const sessions = (Array.isArray(events) ? events : []).filter((event) => event.type === "session.start");
  const builds = (Array.isArray(events) ? events : []).filter((event) => event.type === "session.build");
  const last = sessions[sessions.length - 1] || {};
  const build = builds[builds.length - 1] || {};
  return {
    label: String(label || last.deviceLabel || "").slice(0, 60),
    ua: last.ua || "",
    platform: last.platform || "",
    mobile: last.mobile ?? null,
    screen: last.screen || "",
    dpr: last.dpr ?? null,
    standalone: last.standalone ?? null,
    memberId: last.memberId ?? null,
    commit: build.commit || last.build || null,
    swCache: build.swCache || null,
  };
}

export function buildFieldExport(events, { label = "", exportedAt = new Date() } = {}) {
  const clean = (Array.isArray(events) ? events : []).map((event) => sanitizeFieldEvent(event));
  return {
    schema: FIELD_EXPORT_SCHEMA,
    exportedAt: exportedAt.toISOString(),
    device: deviceFromEvents(clean, label),
    summary: summarizeFieldLog(clean),
    events: clean,
  };
}
