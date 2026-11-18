// Summary maths for field test logs. Used by the member Field log screen and by
// scripts/field/summarize-logs.mjs, so a volunteer's phone and the owner's comparison agree.
//
// Definitions:
//   median  middle value; the mean of the two middle values when the count is even
//   p90     nearest-rank 90th percentile: the value at rank ceil(0.9 * n) of the sorted samples
//   conditions  every timed sample is filed under one network condition when it happened:
//     interrupted  the phone was offline, or reconnected within the last 60 s
//     slow         navigator.connection reported slow-2g, 2g or 3g
//     connected    everything else (iPhones report no connection type, so they land here when online)

export const RECONNECT_WINDOW_MS = 60_000;
export const SLOW_TYPES = Object.freeze(["slow-2g", "2g", "3g"]);
export const CONDITIONS = Object.freeze(["connected", "slow", "interrupted"]);
const SLOW = new Set(SLOW_TYPES);
const MIN_BATTERY_MS = 15 * 60 * 1000;

function numbers(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    .map(Number).filter(Number.isFinite);
}

export function median(values) {
  const sorted = numbers(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, p) {
  const sorted = numbers(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function describe(values) {
  const list = numbers(values);
  if (!list.length) return { n: 0, median: null, p90: null, min: null, max: null };
  return { n: list.length, median: median(list), p90: percentile(list, 90), min: Math.min(...list), max: Math.max(...list) };
}

function ordered(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event.type === "string" && Number.isFinite(event.at))
    .slice()
    .sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
}

/** Walk the log once and file each event under the network condition at that moment. */
export function annotateConditions(events) {
  let offline = false;
  let reconnectedAt = null;
  let offlineSince = null;
  const offlineSpans = [];
  const out = [];
  for (const event of ordered(events)) {
    const goingOffline = event.type === "net.offline" || (event.type === "session.start" && event.online === false);
    const comingOnline = event.type === "net.online" || (event.type === "session.start" && event.online === true && offline);
    if (goingOffline && !offline) { offline = true; offlineSince = event.at; }
    if (comingOnline && offline) {
      offline = false;
      offlineSpans.push(event.at - offlineSince);
      offlineSince = null;
      reconnectedAt = event.at;
    }
    let condition = "connected";
    if (offline || event.net === "off") condition = "interrupted";
    else if (reconnectedAt != null && event.at - reconnectedAt <= RECONNECT_WINDOW_MS) condition = "interrupted";
    else if (SLOW.has(event.eff)) condition = "slow";
    out.push({ event, condition });
  }
  const last = out.length ? out[out.length - 1].event.at : null;
  return { rows: out, offlineSpans, stillOffline: offline ? Math.max(0, (last ?? 0) - offlineSince) : 0 };
}

/** Battery drop per hour while not charging, from API samples or volunteer battery notes. */
export function batteryRate(samples) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((row) => row && Number.isFinite(row.at) && Number.isFinite(row.level))
    .sort((a, b) => a.at - b.at);
  let drop = 0;
  let ms = 0;
  for (let index = 1; index < list.length; index += 1) {
    const a = list[index - 1];
    const b = list[index];
    if (a.charging || b.charging || b.level > a.level) continue;
    drop += a.level - b.level;
    ms += b.at - a.at;
  }
  const hours = ms / 3_600_000;
  return {
    samples: list.length,
    hours: Math.round(hours * 100) / 100,
    drop,
    pctPerHour: ms >= MIN_BATTERY_MS ? Math.round((drop / hours) * 10) / 10 : null,
    start: list.length ? list[0].level : null,
    end: list.length ? list[list.length - 1].level : null,
  };
}

function lastBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key != null) map.set(key, row);
  }
  return map;
}

/** The numbers the Field log screen and the owner's comparison report. */
export function summarizeFieldLog(events) {
  const { rows, offlineSpans, stillOffline } = annotateConditions(events);
  const list = rows.map((row) => row.event);
  const of = (type) => list.filter((event) => event.type === type);
  const byCondition = Object.fromEntries(CONDITIONS.map((name) => [name, { feedback: [], ack: [] }]));

  const feedback = [];
  const clickFeedback = [];
  const ack = [];
  const queuedAck = [];
  let retries = 0;
  let failures = 0;
  let authFailures = 0;
  let staleReviews = 0;
  let maxQueue = 0;
  for (const { event, condition } of rows) {
    if (event.type === "tap.feedback" && Number.isFinite(event.ms)) {
      feedback.push(event.ms);
      if (Number.isFinite(event.clickMs)) clickFeedback.push(event.clickMs);
      byCondition[condition].feedback.push(event.ms);
    }
    if (event.type === "sync.ack") {
      if (event.state === "saved" && Number.isFinite(event.ms)) {
        ack.push(event.ms);
        byCondition[condition].ack.push(event.ms);
        if (Number.isFinite(event.queuedMs)) queuedAck.push(event.queuedMs);
      }
      if (event.attempt > 0) retries += 1;
      if (event.state === "pending") failures += 1;
      if (event.state === "error") failures += 1;
      if (event.state === "auth") { failures += 1; authFailures += 1; }
      if (event.error === "recovery_edit_conflict") staleReviews += 1;
    }
    if ((event.type === "sync.queue" || event.type === "sync.ack") && Number.isFinite(event.queue)) maxQueue = Math.max(maxQueue, event.queue);
  }

  const wsOpens = of("ws.open");
  const recoveries = wsOpens.map((event) => event.recoverMs).filter(Number.isFinite);
  const offlineMs = offlineSpans.reduce((sum, value) => sum + value, 0) + stillOffline;

  const liveRows = of("live.update").filter((event) => !event.first);
  const liveByRole = {};
  for (const event of liveRows) {
    const role = event.role || "live";
    (liveByRole[role] ||= { delay: [], gap: [] });
    if (Number.isFinite(event.delayMs)) liveByRole[role].delay.push(event.delayMs);
    if (Number.isFinite(event.gapMs)) liveByRole[role].gap.push(event.gapMs);
  }

  const opened = lastBy(of("round.open"), (event) => event.roundId || event.roundCode || null);
  const finishedIds = new Set();
  for (const event of of("round.finish")) {
    if (["final", "locked", "saved"].includes(event.result)) finishedIds.add(event.roundId || event.roundCode || "unknown");
  }
  for (const event of of("round.check")) {
    if (event.status === "final" || event.reason === "locked" || event.reason === "final") finishedIds.add(event.roundId || "unknown");
  }
  const checks = lastBy(of("round.check"), (event) => event.roundId || null);
  const suspected = [...checks.values()].filter((event) => event.verdict === "lost/duplicate suspected");

  const clipStarts = of("clip.start");
  const clipResults = of("clip.result");
  const clipIds = new Set(clipStarts.map((event) => event.id).filter(Boolean));
  const savedClips = new Set(clipResults.filter((event) => event.state === "saved").map((event) => event.id).filter(Boolean));
  const clipFailures = clipResults.filter((event) => event.state !== "saved").length;

  const apiBattery = of("battery").map((event) => ({ at: event.at, level: event.level, charging: event.charging === true }));
  const noteBattery = of("note").filter((event) => Number.isFinite(event.battery)).map((event) => ({ at: event.at, level: event.battery, charging: false }));
  const battery = batteryRate(apiBattery.length >= 2 ? apiBattery : noteBattery);

  // Correction effort, as the log sees it: every score entry after the first for the same player and hole.
  const scoreEdits = new Map();
  for (const event of of("sync.queue")) {
    if (event.kind !== "score" || event.key == null || !Number.isFinite(event.hole)) continue;
    const key = (event.roundId || "") + "|" + event.key + "|" + event.hole;
    scoreEdits.set(key, (scoreEdits.get(key) || 0) + 1);
  }
  const corrections = [...scoreEdits.values()].reduce((sum, count) => sum + count - 1, 0);

  const sessions = new Set(list.map((event) => event.sid).filter(Boolean));
  return {
    span: {
      events: list.length,
      sessions: sessions.size,
      first: list.length ? list[0].at : null,
      last: list.length ? list[list.length - 1].at : null,
    },
    feedback: { ...describe(feedback), clickMedian: median(clickFeedback), noChange: of("tap.nochange").length },
    ack: {
      ...describe(ack),
      queued: describe(queuedAck),
      writes: of("sync.queue").length,
      retries,
      failures,
      authFailures,
      staleReviews,
      conflicts: of("sync.conflict").length,
      discarded: of("sync.discard").length,
      maxQueue,
    },
    network: {
      offlineMs,
      offlineCount: offlineSpans.length + (stillOffline ? 1 : 0),
      longestOfflineMs: Math.max(0, stillOffline, ...offlineSpans),
      reconnects: recoveries.length,
      recovery: describe(recoveries),
      connect: describe(wsOpens.map((event) => event.connectMs)),
      closes: of("ws.close").length,
    },
    live: Object.fromEntries(Object.entries(liveByRole).map(([role, values]) => [role, { delay: describe(values.delay), gap: describe(values.gap) }])),
    rounds: {
      started: opened.size,
      finished: finishedIds.size,
      checked: checks.size,
      matched: [...checks.values()].filter((event) => event.verdict === "match").length,
      suspected: suspected.length,
      suspectedRounds: suspected.map((event) => event.roundId).filter(Boolean),
      duplicates: [...checks.values()].reduce((sum, event) => sum + (Number(event.duplicates) || 0), 0),
      scoredCells: scoreEdits.size,
      corrections,
    },
    clips: {
      attempted: clipIds.size,
      saved: savedClips.size,
      failures: clipFailures,
      successRate: clipIds.size ? Math.round((savedClips.size / clipIds.size) * 1000) / 10 : null,
      bytes: clipStarts.reduce((sum, event) => sum + (Number(event.bytes) || 0), 0),
    },
    battery: {
      ...battery,
      source: apiBattery.length >= 2 ? "api" : noteBattery.length ? "notes" : "none",
      apiAvailable: of("battery.unavailable").length === 0 && apiBattery.length > 0,
    },
    errors: of("error").length,
    notes: of("note").length,
    conditions: Object.fromEntries(CONDITIONS.map((name) => [name, {
      feedback: describe(byCondition[name].feedback),
      ack: describe(byCondition[name].ack),
    }])),
  };
}

/** Raw samples behind the summary's medians, for pooling several devices. */
export function fieldSamples(events) {
  const list = ordered(events);
  const live = list.filter((event) => event.type === "live.update" && !event.first && Number.isFinite(event.delayMs));
  return {
    feedback: list.filter((event) => event.type === "tap.feedback").map((event) => event.ms).filter(Number.isFinite),
    ack: list.filter((event) => event.type === "sync.ack" && event.state === "saved").map((event) => event.ms).filter(Number.isFinite),
    recovery: list.filter((event) => event.type === "ws.open").map((event) => event.recoverMs).filter(Number.isFinite),
    spectatorDelay: live.filter((event) => event.role === "spectator").map((event) => event.delayMs),
    scorerDelay: live.filter((event) => event.role === "scorer").map((event) => event.delayMs),
  };
}

function range(values) {
  const list = numbers(values);
  return list.length ? { min: Math.min(...list), max: Math.max(...list) } : { min: null, max: null };
}

/**
 * Combine per-device logs: each device keeps its own medians, the combined row pools the raw samples,
 * and the range is the spread of the device medians. Devices are never averaged into one claim.
 */
export function combineDevices(devices) {
  const rows = (Array.isArray(devices) ? devices : []).map((device) => ({
    label: device.label,
    summary: summarizeFieldLog(device.events),
    samples: fieldSamples(device.events),
  }));
  const pooled = (key) => rows.flatMap((row) => row.samples[key]);
  const deviceMedians = (pick) => rows.map((row) => pick(row.summary)).filter(Number.isFinite);
  const metric = (key, pick) => ({ pooled: describe(pooled(key)), range: range(deviceMedians(pick)) });
  return {
    devices: rows.map(({ label, summary }) => ({ label, summary })),
    combined: {
      devices: rows.length,
      feedback: metric("feedback", (summary) => summary.feedback.median),
      ack: metric("ack", (summary) => summary.ack.median),
      recovery: metric("recovery", (summary) => summary.network.recovery.median),
      spectatorDelay: metric("spectatorDelay", (summary) => summary.live.spectator?.delay.median),
      batteryPerHour: { range: range(deviceMedians((summary) => summary.battery.pctPerHour)) },
      roundsStarted: rows.reduce((sum, row) => sum + row.summary.rounds.started, 0),
      roundsFinished: rows.reduce((sum, row) => sum + row.summary.rounds.finished, 0),
      suspected: rows.reduce((sum, row) => sum + row.summary.rounds.suspected, 0),
    },
  };
}
