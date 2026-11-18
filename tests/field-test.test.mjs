import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createFieldStore, createMemoryFieldBackend, FIELD_LOG_CAP } from "../src/shared/field-test-store.js";
import { sanitizeFieldEvent, scrubFieldText } from "../src/shared/field-test-privacy.js";
import {
  annotateConditions, batteryRate, combineDevices, describe, median, percentile, summarizeFieldLog,
} from "../src/shared/field-test-summary.js";
import { buildFieldExport, csvCell, eventsToCsv, fieldExportName } from "../src/shared/field-test-export.js";
import { compareRoundCard, startFieldRecorder } from "../src/shared/field-test-recorder.js";

const T0 = Date.UTC(2026, 10, 17, 14, 0, 0);
const at = (seconds) => T0 + seconds * 1000;

test("ring buffer keeps the newest events up to the cap", async () => {
  const backend = createMemoryFieldBackend();
  const store = createFieldStore(backend, { cap: 100 });
  for (let batch = 0; batch < 5; batch += 1) {
    await store.append(Array.from({ length: 30 }, (_, index) => ({ type: "tap.feedback", ms: batch * 30 + index, at: at(batch) })));
  }
  const rows = await store.all();
  assert.equal(rows.length, 100);
  assert.equal(await store.count(), 100);
  assert.deepEqual(rows.map((row) => row.ms), Array.from({ length: 100 }, (_, index) => index + 50));
  assert.ok(rows.every((row, index) => index === 0 || row.seq > rows[index - 1].seq), "sequence numbers stay ordered");
});

test("default cap is 10k and the log survives a new store instance (a reload)", async () => {
  assert.equal(FIELD_LOG_CAP, 10_000);
  const backend = createMemoryFieldBackend();
  const first = createFieldStore(backend);
  await first.append(Array.from({ length: FIELD_LOG_CAP + 25 }, (_, index) => ({ type: "battery", level: index % 100, at: at(index) })));
  const reloaded = createFieldStore(backend);
  assert.equal(await reloaded.count(), FIELD_LOG_CAP);
  const rows = await reloaded.all();
  assert.equal(rows[0].seq, 26, "the 25 oldest events were dropped");
  await reloaded.append([{ type: "note", text: "after reload", at: at(99_999) }]);
  const after = await createFieldStore(backend).all();
  assert.equal(after.length, FIELD_LOG_CAP);
  assert.equal(after.at(-1).text, "after reload");
  await reloaded.clear();
  assert.equal(await first.count(), 0);
});

test("median and nearest-rank p90", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([], 90), null);
  const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(ten, 90), 90);
  assert.equal(percentile([...ten, 110], 90), 100);
  assert.equal(percentile([7], 90), 7);
  assert.deepEqual(describe([40, 10, "x", 30, 20, null]), { n: 4, median: 25, p90: 40, min: 10, max: 40 });
});

test("battery drain per hour skips charging spans and needs 15 minutes", () => {
  const samples = [
    { at: at(0), level: 90, charging: false },
    { at: at(1800), level: 87, charging: false },
    { at: at(3600), level: 84, charging: false },
    { at: at(4500), level: 90, charging: true },
    { at: at(5400), level: 95, charging: true },
  ];
  const rate = batteryRate(samples);
  assert.equal(rate.pctPerHour, 6);
  assert.equal(rate.hours, 1);
  assert.equal(batteryRate(samples.slice(0, 1)).pctPerHour, null);
  assert.equal(batteryRate([{ at: at(0), level: 80 }, { at: at(600), level: 79 }]).pctPerHour, null, "10 minutes is too short");
});

test("offline time and network conditions follow the event order, across a reload", () => {
  const events = [
    { type: "session.start", at: at(0), online: true, net: "on", sid: "a" },
    { type: "tap.feedback", at: at(10), ms: 40, net: "on", eff: "4g", sid: "a" },
    { type: "net.offline", at: at(100), net: "off", sid: "a" },
    { type: "tap.feedback", at: at(110), ms: 70, net: "off", sid: "a" },
    // The app was closed and reopened while still offline, then the signal came back.
    { type: "session.start", at: at(200), online: false, net: "off", sid: "b" },
    { type: "net.online", at: at(400), net: "on", sid: "b" },
    { type: "sync.ack", at: at(420), state: "saved", ms: 900, attempt: 1, net: "on", sid: "b" },
    { type: "tap.feedback", at: at(500), ms: 45, net: "on", eff: "3g", sid: "b" },
    { type: "tap.feedback", at: at(600), ms: 35, net: "on", eff: "4g", sid: "b" },
  ];
  const { offlineSpans, stillOffline } = annotateConditions(events);
  assert.deepEqual(offlineSpans, [300_000]);
  assert.equal(stillOffline, 0);
  const summary = summarizeFieldLog(events);
  assert.equal(summary.network.offlineMs, 300_000);
  assert.equal(summary.network.offlineCount, 1);
  assert.deepEqual(summary.conditions.connected.feedback, describe([40, 35]));
  assert.deepEqual(summary.conditions.interrupted.feedback, describe([70]));
  assert.deepEqual(summary.conditions.slow.feedback, describe([45]));
  assert.equal(summary.conditions.interrupted.ack.n, 1, "an ack 20 s after reconnecting counts as interrupted");
  assert.equal(summary.span.sessions, 2);
});

test("summary reports feedback, acks, reconnects, rounds, clips and battery", () => {
  const events = [
    { type: "session.start", at: at(0), online: true, sid: "s" },
    ...[30, 50, 40, 60, 200].map((ms, index) => ({ type: "tap.feedback", at: at(1 + index), ms, clickMs: ms - 20, sid: "s" })),
    { type: "tap.nochange", at: at(7), target: "minus" },
    { type: "sync.queue", at: at(8), queue: 3, kind: "score", roundId: "r1", key: "i:0", hole: 1, strokes: 3 },
    { type: "sync.queue", at: at(8), queue: 2, kind: "score", roundId: "r1", key: "i:0", hole: 1, strokes: 4 },
    { type: "sync.queue", at: at(8), queue: 2, kind: "score", roundId: "r1", key: "i:1", hole: 1, strokes: 3 },
    { type: "sync.ack", at: at(9), state: "saved", ms: 120, queuedMs: 150, attempt: 0, queue: 2 },
    { type: "sync.ack", at: at(10), state: "pending", ms: 12000, attempt: 0, status: 0 },
    { type: "sync.ack", at: at(20), state: "saved", ms: 300, attempt: 1 },
    { type: "sync.ack", at: at(21), state: "error", error: "recovery_edit_conflict", attempt: 0, ms: 90 },
    { type: "sync.conflict", at: at(22), hole: 4, source: "ws" },
    { type: "ws.close", at: at(30), role: "scorer", code: 1006 },
    { type: "ws.open", at: at(34), role: "scorer", connectMs: 200, recoverMs: 4000 },
    { type: "ws.open", at: at(35), role: "spectator", connectMs: 150 },
    { type: "live.update", at: at(36), role: "spectator", first: true, rev: 4 },
    { type: "live.update", at: at(40), role: "spectator", rev: 5, delayMs: 800, gapMs: 4000 },
    { type: "live.update", at: at(50), role: "spectator", rev: 6, delayMs: 600, gapMs: 10000 },
    { type: "round.open", at: at(1), roundId: "r1", roundCode: "QA1" },
    { type: "round.finish", at: at(60), roundId: "r1", result: "final" },
    { type: "round.check", at: at(61), roundId: "r1", verdict: "match", status: "final", duplicates: 0 },
    { type: "round.open", at: at(62), roundId: "r2" },
    { type: "round.check", at: at(90), roundId: "r2", verdict: "lost/duplicate suspected", status: "final", duplicates: 1 },
    { type: "clip.start", at: at(70), id: "c1", bytes: 1000 },
    { type: "clip.result", at: at(71), id: "c1", state: "pending" },
    { type: "clip.start", at: at(72), id: "c1", bytes: 1000 },
    { type: "clip.result", at: at(73), id: "c1", state: "saved" },
    { type: "clip.start", at: at(74), id: "c2", bytes: 500 },
    { type: "clip.result", at: at(75), id: "c2", state: "error" },
    { type: "battery.unavailable", at: at(0) },
    { type: "note", at: at(0), battery: 80 },
    { type: "note", at: at(3600), battery: 72, chip: "Battery" },
    { type: "error", at: at(80), message: "boom" },
  ];
  const summary = summarizeFieldLog(events);
  assert.deepEqual([summary.feedback.n, summary.feedback.median, summary.feedback.p90, summary.feedback.max], [5, 50, 200, 200]);
  assert.equal(summary.feedback.clickMedian, 30);
  assert.equal(summary.feedback.noChange, 1);
  assert.deepEqual([summary.ack.n, summary.ack.median, summary.ack.p90], [2, 210, 300]);
  assert.equal(summary.ack.retries, 1);
  assert.equal(summary.ack.failures, 2);
  assert.equal(summary.ack.staleReviews, 1);
  assert.equal(summary.ack.conflicts, 1);
  assert.equal(summary.ack.maxQueue, 3);
  assert.equal(summary.network.reconnects, 1);
  assert.equal(summary.network.recovery.median, 4000);
  assert.deepEqual([summary.live.spectator.delay.n, summary.live.spectator.delay.median], [2, 700]);
  assert.deepEqual([summary.rounds.started, summary.rounds.finished, summary.rounds.suspected, summary.rounds.duplicates], [2, 2, 1, 1]);
  assert.deepEqual(summary.rounds.suspectedRounds, ["r2"]);
  assert.deepEqual([summary.rounds.scoredCells, summary.rounds.corrections], [2, 1]);
  assert.deepEqual([summary.clips.attempted, summary.clips.saved, summary.clips.successRate, summary.clips.bytes], [2, 1, 50, 2500]);
  assert.equal(summary.battery.source, "notes");
  assert.equal(summary.battery.pctPerHour, 8);
  assert.equal(summary.errors, 1);
});

test("combined comparison pools samples and keeps each device's median range", () => {
  const device = (label, feedback, ack) => ({
    label,
    events: [
      ...feedback.map((ms, index) => ({ type: "tap.feedback", at: at(index), ms })),
      ...ack.map((ms, index) => ({ type: "sync.ack", state: "saved", at: at(100 + index), ms })),
    ],
  });
  const result = combineDevices([device("iPhone", [10, 20, 30], [100, 300]), device("Pixel", [50, 70], [400])]);
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices[0].summary.feedback.median, 20);
  assert.equal(result.devices[1].summary.feedback.median, 60);
  assert.deepEqual(result.combined.feedback.pooled, describe([10, 20, 30, 50, 70]));
  assert.deepEqual(result.combined.feedback.range, { min: 20, max: 60 });
  assert.deepEqual(result.combined.ack.range, { min: 200, max: 400 });
  assert.equal(result.combined.ack.pooled.median, 300);
});

test("CSV cells cannot start a spreadsheet formula", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("\tcmd"), "'\tcmd");
  assert.equal(csvCell(-12), "-12", "numbers stay numeric");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(true), "true");
  const csv = eventsToCsv([{ seq: 1, at: T0, sid: "s1", app: "score", type: "note", net: "on", text: "=cmd|' /C calc'!A0", chip: "App closed" }]);
  const [header, row] = csv.trim().split("\r\n");
  assert.equal(header, "seq,time,session,app,type,net,eff,ms,target,kind,hole,state,status,detail");
  assert.match(row, /^1,2026-11-17T14:00:00.000Z,s1,score,note,on,,,,,,,,/);
  assert.ok(row.includes("\"{\"\"text\"\":\"\"=cmd"), "free text stays inside the quoted detail JSON");
  assert.ok(!/,=/.test(row), "no cell begins with =");
});

test("privacy filter drops names and PDGA numbers but keeps the member's own id", () => {
  const names = ["Jordan Reyes", "Avery Brooks"];
  const event = sanitizeFieldEvent({
    type: "note", memberId: "m_42", roundCode: "GVDG44",
    text: "Jordan Reyes lost signal; Avery's PDGA #123456 and 98765 noted",
    playerName: "Avery Brooks", players: [{ name: "Jordan" }], label: "Jordan Reyes",
    nested: { pdgaNo: 98765, name: "Avery", hole: 4, note: { displayName: "Morgan" } },
    rows: [{ key: "i:1", localTotal: 54 }],
  }, { names });
  assert.equal(event.memberId, "m_42");
  assert.equal(event.roundCode, "GVDG44");
  assert.equal(event.playerName, undefined);
  assert.equal(event.players, undefined);
  assert.equal(event.label, undefined);
  assert.deepEqual(event.nested, { hole: 4, note: {} });
  assert.deepEqual(event.rows, [{ key: "i:1", localTotal: 54 }]);
  assert.equal(event.text, "[player] lost signal; [player]'s PDGA [number] and [number] noted");
  assert.ok(!/Jordan|Avery|123456|98765/.test(JSON.stringify(event)));
  assert.equal(scrubFieldText("Hole 11 at 10:42, battery 54%", names), "Hole 11 at 10:42, battery 54%");
  const exported = buildFieldExport([{ type: "note", at: T0, text: "pdga 55555", playerName: "X" }]);
  assert.equal(exported.events[0].text, "PDGA [number]");
  assert.equal(exported.events[0].playerName, undefined);
  assert.equal(exported.schema, "gvdg-field-log/1");
  assert.equal(fieldExportName({ label: "Pixel 7 / Chrome" }, new Date(T0)), "gvdg-field-log-pixel-7-chrome-20261117-1400.json");
});

test("end-of-round check flags lost and duplicate writes", () => {
  const events = [
    { type: "sync.queue", id: "a", kind: "score", roundId: "r1", key: "i:0", hole: 1, strokes: 3 },
    { type: "sync.queue", id: "b", kind: "score", roundId: "r1", key: "i:0", hole: 1, strokes: 4 },
    { type: "sync.queue", id: "c", kind: "score", roundId: "r1", key: "i:1", hole: 1, strokes: 2 },
    { type: "sync.queue", id: "d", kind: "score", roundId: "r1", key: "i:1", hole: 2, strokes: 5 },
    { type: "sync.discard", id: "d" },
    { type: "sync.queue", id: "e", kind: "score", roundId: "other", key: "i:0", hole: 2, strokes: 9 },
    { type: "sync.ack", id: "b", roundId: "r1", state: "saved" },
  ];
  const match = compareRoundCard(events, { roundId: "r1", rows: [{ key: "i:0", holes: { 1: 4, 2: 3 } }, { key: "i:1", holes: { 1: 2 } }] });
  assert.equal(match.verdict, "match");
  assert.equal(match.checked, 2);
  assert.deepEqual(match.rows, [{ key: "i:0", holes: 1, localTotal: 4, serverTotal: 4 }, { key: "i:1", holes: 1, localTotal: 2, serverTotal: 2 }]);
  const lost = compareRoundCard(events, { roundId: "r1", rows: [{ key: "i:0", holes: { 1: 3 } }, { key: "i:1", holes: {} }] });
  assert.equal(lost.verdict, "lost/duplicate suspected");
  assert.deepEqual(lost.mismatches, [{ key: "i:0", hole: 1, local: 4, server: 3 }, { key: "i:1", hole: 1, local: 2, server: null }]);
  const duplicated = compareRoundCard([...events, { type: "sync.ack", id: "b", roundId: "r1", state: "saved" }],
    { roundId: "r1", rows: [{ key: "i:0", holes: { 1: 4 } }, { key: "i:1", holes: { 1: 2 } }] });
  assert.equal(duplicated.duplicates, 1);
  assert.equal(duplicated.verdict, "lost/duplicate suspected");
  assert.equal(compareRoundCard([], { roundId: "r1", rows: [] }).verdict, "no local scores");
});

function fakeEnvironment() {
  const listeners = [];
  const timers = { timeouts: 0, intervals: 0 };
  const target = (name) => ({
    addEventListener(type, _handler, options) { listeners.push({ target: name, type, options }); },
    removeEventListener(type) {
      const index = listeners.findIndex((row) => row.target === name && row.type === type);
      if (index >= 0) listeners.splice(index, 1);
    },
  });
  const storage = new Map();
  const win = {
    ...target("window"),
    document: { ...target("document"), body: {}, visibilityState: "visible", querySelector: () => null, querySelectorAll: () => [] },
    navigator: { onLine: true, userAgent: "node-test", connection: target("connection") },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    location: { href: "https://gvdgclub.com/score.html?round=QA1&gt=secret" },
    performance: { now: () => 1000 },
    setTimeout: () => { timers.timeouts += 1; return timers.timeouts; },
    clearTimeout: () => {},
    setInterval: () => { timers.intervals += 1; return timers.intervals; },
    clearInterval: () => {},
    fetch: () => Promise.reject(new Error("offline")),
  };
  return { win, listeners, timers, storage };
}

test("with field test mode off the gate adds no listeners, timers or storage writes", async () => {
  const env = fakeEnvironment();
  const saved = {};
  for (const key of ["window", "document", "localStorage", "setTimeout", "setInterval"]) saved[key] = globalThis[key];
  let writes = 0;
  globalThis.localStorage = { ...env.win.localStorage, setItem: () => { writes += 1; } };
  globalThis.window = env.win;
  globalThis.document = env.win.document;
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let timerCalls = 0;
  globalThis.setTimeout = (...args) => { timerCalls += 1; return realSetTimeout(...args); };
  globalThis.setInterval = (...args) => { timerCalls += 1; return realSetInterval(...args); };
  try {
    const gate = await import("../src/shared/field-test-gate.js?off-test");
    assert.equal(gate.fieldTestOn(), false);
    const socket = { ...env.win, addEventListener() { throw new Error("must not listen while off"); } };
    gate.fieldLog("tap.feedback", { ms: 5 });
    gate.fieldNote({ chip: "App closed" });
    gate.fieldLiveUpdate("scorer", { rev: 3 });
    gate.fieldRedactNames(["Jordan Reyes"]);
    assert.equal(gate.fieldWatchSocket(socket, "scorer"), socket);
    assert.equal(gate.fieldMark(), 0);
    assert.equal(gate.fieldSince(0), null);
    assert.equal(await gate.startFieldTest("score"), null);
    assert.equal(gate.activeFieldRecorder(), null);
    assert.equal(env.listeners.length, 0);
    assert.equal(timerCalls, 0);
    assert.equal(writes, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("the recorder only listens while running and removes every listener on stop", async () => {
  const env = fakeEnvironment();
  const store = createFieldStore(createMemoryFieldBackend());
  const recorder = startFieldRecorder({ app: "score", store, win: env.win, early: [{ type: "note", data: { chip: "App closed" }, at: T0, t: 1 }] });
  const types = env.listeners.map((row) => row.target + ":" + row.type).sort();
  for (const expected of ["document:pointerdown", "document:visibilitychange", "window:error", "window:offline", "window:online", "window:pagehide", "window:unhandledrejection", "connection:change"]) {
    assert.ok(types.includes(expected), "listens for " + expected);
  }
  recorder.setRedactions(["Jordan Reyes"]);
  recorder.log("note", { text: "Jordan Reyes closed the app", playerName: "Jordan Reyes" });
  recorder.log("live.update", { role: "spectator", rev: 2, updatedAt: new Date(T0).toISOString() }, T0 + 50);
  recorder.log("live.update", { role: "spectator", rev: 2 }, T0 + 60);
  recorder.log("live.update", { role: "spectator", rev: 3, updatedAt: new Date(T0 + 1000).toISOString() }, T0 + 1400);
  recorder.log("ws.close", { role: "scorer", code: 1006 }, T0 + 2000);
  recorder.log("ws.open", { role: "scorer", connectMs: 90 }, T0 + 6500);
  await recorder.stop();
  assert.equal(env.listeners.length, 0, "stop removes every listener");
  const rows = await store.all();
  const types2 = rows.map((row) => row.type);
  assert.equal(types2[0], "session.start");
  assert.ok(types2.includes("battery.unavailable"), "no battery API is recorded as unavailable");
  const note = rows.find((row) => row.type === "note" && row.text);
  assert.equal(note.text, "[player] closed the app");
  assert.equal(note.playerName, undefined);
  const start = rows.find((row) => row.type === "session.start");
  assert.equal(start.page, "/score.html?round=QA1", "the guest token is not logged");
  const live = rows.filter((row) => row.type === "live.update");
  assert.equal(live.length, 2, "a same-revision rebroadcast is skipped");
  assert.equal(live[0].first, true);
  assert.equal(live[1].delayMs, 400);
  assert.equal(live[1].gapMs, 1350);
  const open = rows.find((row) => row.type === "ws.open");
  assert.equal(open.recoverMs, 4500);
});

test("score.html and the scorer bundle stay free of instrumentation code until it is needed", () => {
  const gate = readFileSync("src/shared/field-test-gate.js", "utf8");
  assert.match(gate, /import\("\.\/field-test-recorder\.js"\)/, "the recorder is a dynamic import");
  assert.doesNotMatch(gate, /^import /m, "the gate imports nothing");
  const recorder = readFileSync("src/shared/field-test-recorder.js", "utf8");
  const imports = [...recorder.matchAll(/^import .* from "(.+)";$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["./field-test-privacy.js", "./field-test-store.js"]);
});

test("the owner's comparison joins exports from the same phone and labels the rest", async () => {
  const { deviceLabel, formatReport, groupLogs } = await import("../scripts/field/summarize-logs.mjs");
  const events = [
    { sid: "a", seq: 1, at: at(0), type: "tap.feedback", ms: 40 },
    { sid: "a", seq: 2, at: at(1), type: "sync.ack", state: "saved", ms: 150, text: "Jordan PDGA 12345" },
  ];
  const exportOf = (device, list) => JSON.stringify({ schema: "gvdg-field-log/1", device, events: list });
  const { devices, warnings } = groupLogs([
    { name: "a1.json", text: exportOf({ label: "Pixel 7" }, events) },
    { name: "a2.json", text: exportOf({ label: "Pixel 7" }, [...events, { sid: "b", seq: 3, at: at(2), type: "tap.feedback", ms: 60 }]) },
    { name: "ios.json", text: exportOf({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1" }, [{ sid: "c", seq: 1, at: at(0), type: "tap.feedback", ms: 80 }]) },
    { name: "junk.json", text: "{\"schema\":\"other\"}" },
    { name: "broken.json", text: "{" },
  ]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(devices.map((device) => [device.label, device.events.length]), [["Pixel 7", 3], ["iPhone iOS 18.1 · Safari", 1]]);
  assert.equal(devices[0].events[1].text, "Jordan PDGA [number]", "exports are re-filtered for PDGA numbers");
  assert.equal(deviceLabel({ device: {} }, "fallback"), "fallback");
  const report = formatReport(combineDevices(devices), warnings);
  assert.match(report, /\| Pixel 7 \| 0\/0 \| 0 \| 0 \| 50 \(60\) \| 150 \(150\) \|/);
  assert.match(report, /\| Score-entry feedback \(ms\) \| 60 \| 80 \| 50–80 \| 3 \|/);
});

test("clip and upload results use the recovery queue's retry rules", async () => {
  const { fieldResultState } = await import("../src/shared/field-test-gate.js?results");
  assert.equal(fieldResultState(null), "skipped");
  assert.equal(fieldResultState({ ok: true, data: { id: 7 } }), "saved");
  assert.equal(fieldResultState({ ok: true, data: { clientId: "c1" } }), "saved");
  assert.equal(fieldResultState({ ok: true, data: {} }), "pending", "an OK without a clip record is retried");
  for (const status of [0, 408, 425, 429, 500, 503]) assert.equal(fieldResultState({ ok: false, status }), "pending");
  assert.equal(fieldResultState({ ok: false, status: 401 }), "auth");
  assert.equal(fieldResultState({ ok: false, status: 413 }), "error");
});
