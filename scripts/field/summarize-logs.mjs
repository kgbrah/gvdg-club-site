#!/usr/bin/env node
// Compare field test logs exported from volunteers' phones (Account > Field log > Export).
//
//   node scripts/field/summarize-logs.mjs logs/*.json [--json summary.json]
//
// Prints a per-device table of the "Paired measurements" in docs/field-verification.md, then a combined
// row that pools the raw samples and shows the range of the device medians. Devices are never merged into
// one reliability claim; logs from the same phone (same label, or same browser if unlabeled) are joined.
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { FIELD_EXPORT_SCHEMA } from "../../src/shared/field-test-export.js";
import { sanitizeFieldEvent } from "../../src/shared/field-test-privacy.js";
import { CONDITIONS, combineDevices } from "../../src/shared/field-test-summary.js";

/** A readable name for the phone behind a log. */
export function deviceLabel(log, fallback = "phone") {
  const device = log?.device || {};
  if (device.label) return String(device.label).trim();
  const ua = String(device.ua || "");
  const ios = /iPhone OS ([\d_]+)/.exec(ua);
  const android = /Android ([\d.]+)/.exec(ua);
  const os = ios ? "iPhone iOS " + ios[1].replace(/_/g, ".") : android ? "Android " + android[1] : "";
  const browser = /CriOS|Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ") || fallback;
}

/** Parse exported files and join logs from the same phone. */
export function groupLogs(files) {
  const devices = new Map();
  const warnings = [];
  for (const { name, text } of files) {
    let log;
    try { log = JSON.parse(text); } catch { warnings.push(name + ": not JSON, skipped"); continue; }
    if (!log || log.schema !== FIELD_EXPORT_SCHEMA || !Array.isArray(log.events)) {
      warnings.push(name + ": not a GVDG field log (" + FIELD_EXPORT_SCHEMA + "), skipped");
      continue;
    }
    const label = deviceLabel(log, basename(name, ".json"));
    const entry = devices.get(label) || { label, events: [], files: [], seen: new Set() };
    for (const event of log.events) {
      // The same phone exported twice: keep one copy of each event.
      const key = [event.sid, event.seq, event.at, event.type].join("|");
      if (entry.seen.has(key)) continue;
      entry.seen.add(key);
      entry.events.push(sanitizeFieldEvent(event));
    }
    entry.files.push(basename(name));
    devices.set(label, entry);
  }
  return { devices: [...devices.values()].map(({ seen: _seen, ...device }) => device), warnings };
}

const num = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : "–");
const msCell = (stats) => (stats && stats.n ? num(stats.median) + " (" + num(stats.p90) + ")" : "–");
const sCell = (stats) => (stats && stats.n ? num(stats.median / 1000, 1) + " (" + num(stats.p90 / 1000, 1) + ")" : "–");
const rangeCell = (range, scale = 1, digits = 0) => (Number.isFinite(range?.min) ? num(range.min / scale, digits) + "–" + num(range.max / scale, digits) : "–");

function table(head, rows) {
  const out = ["| " + head.join(" | ") + " |", "|" + head.map(() => "---").join("|") + "|"];
  for (const row of rows) out.push("| " + row.join(" | ") + " |");
  return out.join("\n");
}

/** The printed report: per device, combined, and by network condition. */
export function formatReport(result, warnings = []) {
  const lines = [];
  lines.push("# Field test comparison");
  lines.push("");
  lines.push(result.devices.length + " device(s). Times are medians with p90 in brackets.");
  lines.push("");
  lines.push("## Per device");
  lines.push(table(
    ["Device", "Rounds done", "Lost/dup suspected", "Corrections", "Feedback ms", "Save ms", "Retries / failed", "Offline min", "Reconnects", "Recovery s", "Spectator delay s", "Clips saved", "Battery %/h"],
    result.devices.map(({ label, summary: s }) => [
      label,
      s.rounds.finished + "/" + s.rounds.started,
      String(s.rounds.suspected + s.rounds.duplicates),
      String(s.rounds.corrections),
      msCell(s.feedback),
      msCell(s.ack),
      s.ack.retries + " / " + s.ack.failures,
      num(s.network.offlineMs / 60000, 1),
      String(s.network.reconnects),
      sCell(s.network.recovery),
      sCell(s.live.spectator?.delay),
      s.clips.attempted ? s.clips.saved + "/" + s.clips.attempted : "–",
      s.battery.pctPerHour == null ? "–" : num(s.battery.pctPerHour, 1) + (s.battery.source === "notes" ? " (notes)" : ""),
    ]),
  ));
  lines.push("");
  const c = result.combined;
  lines.push("## Combined");
  lines.push("Pooled samples across devices; the range is the spread of the device medians.");
  lines.push(table(["Measure", "Pooled median", "Pooled p90", "Range of device medians", "Samples"], [
    ["Score-entry feedback (ms)", num(c.feedback.pooled.median), num(c.feedback.pooled.p90), rangeCell(c.feedback.range), String(c.feedback.pooled.n)],
    ["Server save (ms)", num(c.ack.pooled.median), num(c.ack.pooled.p90), rangeCell(c.ack.range), String(c.ack.pooled.n)],
    ["Reconnect recovery (s)", num(c.recovery.pooled.median / 1000, 1), num(c.recovery.pooled.p90 / 1000, 1), rangeCell(c.recovery.range, 1000, 1), String(c.recovery.pooled.n)],
    ["Spectator update delay (s)", num(c.spectatorDelay.pooled.median / 1000, 1), num(c.spectatorDelay.pooled.p90 / 1000, 1), rangeCell(c.spectatorDelay.range, 1000, 1), String(c.spectatorDelay.pooled.n)],
    ["Battery change (%/h)", "–", "–", rangeCell(c.batteryPerHour.range, 1, 1), "per device"],
    ["Rounds completed", c.roundsFinished + " of " + c.roundsStarted, "", "", ""],
    ["Lost/duplicate suspected", String(c.suspected), "", "", ""],
  ]));
  lines.push("");
  lines.push("## By network condition");
  lines.push("Feedback / save medians in ms (samples).");
  lines.push(table(["Device", ...CONDITIONS.map((name) => name[0].toUpperCase() + name.slice(1))], result.devices.map(({ label, summary }) => [
    label,
    ...CONDITIONS.map((name) => {
      const row = summary.conditions[name];
      if (!row.feedback.n && !row.ack.n) return "–";
      return num(row.feedback.median) + " / " + num(row.ack.median) + " (" + row.feedback.n + "/" + row.ack.n + ")";
    }),
  ])));
  lines.push("");
  lines.push("Correction effort in taps and seconds, help requests and clip availability after the round come from the volunteers' sheets.");
  if (warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of warnings) lines.push("- " + warning);
  }
  return lines.join("\n") + "\n";
}

async function main(argv) {
  const args = argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : "";
  const paths = args.filter((arg, index) => !arg.startsWith("--") && !(jsonIndex >= 0 && index === jsonIndex + 1));
  if (!paths.length) {
    console.error("Usage: node scripts/field/summarize-logs.mjs <exported-log.json>... [--json out.json]");
    process.exitCode = 2;
    return;
  }
  const files = await Promise.all(paths.map(async (name) => ({ name, text: await readFile(name, "utf8") })));
  const { devices, warnings } = groupLogs(files);
  if (!devices.length) {
    console.error(warnings.join("\n") || "No field logs found.");
    process.exitCode = 1;
    return;
  }
  const result = combineDevices(devices);
  process.stdout.write(formatReport(result, warnings));
  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({ ...result, files: devices.map(({ label, files: list }) => ({ label, files: list })) }, null, 2) + "\n");
    console.log("Wrote " + jsonOut);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv);
}
