import { createRoundJournal } from "../score-app/round-recovery.js";

export const SHOT_TYPES = [
  ["backhand", "Backhand"], ["forehand", "Forehand"], ["overhand", "Overhand"],
  ["roller", "Roller"], ["other", "Other"],
];

export const EMPTY_PRACTICE = {
  discs: [], throws: { items: [], next: null }, putting: { items: [], next: null },
  puttingTotals: { attempts: 0, makes: 0, sessions: 0 }, puttingTrends: [], throwGroups: [],
};

export function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function metersFromDistance(distance, unit) {
  const rounded = Number(Number(distance).toFixed(3));
  if (!Number.isFinite(rounded) || rounded <= 0 || (unit !== "m" && unit !== "ft")) return null;
  return Number((rounded * (unit === "ft" ? 0.3048 : 1)).toFixed(3));
}

export function distanceFromMeters(meters, unit) {
  return Number((Number(meters) / (unit === "ft" ? 0.3048 : 1)).toFixed(2));
}

export function practicePercent(makes, attempts) {
  return Number.isInteger(attempts) && attempts > 0 && Number.isInteger(makes) && makes >= 0 && makes <= attempts
    ? Math.round(1000 * makes / attempts) / 10
    : null;
}

export function distanceBetween(origin, end) {
  const radians = (value) => value * Math.PI / 180;
  const dlat = radians(end.lat - origin.lat);
  const dlng = radians(end.lng - origin.lng);
  const value = Math.sin(dlat / 2) ** 2 + Math.cos(radians(origin.lat)) * Math.cos(radians(end.lat)) * Math.sin(dlng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, value))));
}

export function puttingMakeTotals(stations) {
  return stations.reduce((total, station) => ({
    attempts: total.attempts + Number(station.attempts),
    makes: total.makes + Number(station.makes),
  }), { attempts: 0, makes: 0 });
}

export function stagePutting(form) {
  const distances = new Set();
  let total = 0;
  const stations = form.stations.map((station) => {
    const distance = Number(station.distance);
    const meters = metersFromDistance(distance, station.unit);
    const attempts = Number(station.attempts);
    const makes = station.makes === "" ? NaN : Number(station.makes);
    if (!meters || meters > 100 || distance < 0.1 || !Number.isInteger(attempts) || attempts < 1 || attempts > 500
      || !Number.isInteger(makes) || makes < 0 || makes > attempts || distances.has(meters)) return null;
    distances.add(meters);
    total += attempts;
    return { distance, unit: station.unit, attempts, makes };
  });
  if (!form.date || !stations.length || stations.length > 12 || stations.some((station) => station === null) || total > 1000) return null;
  return { date: form.date, stations };
}

export function isPracticeSnapshot(snapshot, owner) {
  return snapshot?.owner === owner && Array.isArray(snapshot.discs)
    && Array.isArray(snapshot.throws?.items) && Array.isArray(snapshot.putting?.items)
    && Array.isArray(snapshot.puttingTrends) && Array.isArray(snapshot.throwGroups)
    && snapshot.puttingTotals && typeof snapshot.puttingTotals === "object";
}

export function createPracticeStorage(storage, owner) {
  const scoped = JSON.stringify(["practice", owner]);
  const key = "gvdg:practice-snapshot:" + encodeURIComponent(owner);
  const journal = createRoundJournal(storage, { key: scoped });
  return {
    load() {
      const saved = JSON.parse(storage.getItem(key) || "null");
      return isPracticeSnapshot(saved, owner) ? saved : null;
    },
    save(snapshot) {
      if (snapshot.owner !== owner) throw new Error("practice_scope_changed");
      // Committed GPS stays on the server. Unconfirmed coordinates are stored only in the owner's drafts.
      const throws = { ...snapshot.throws, items: snapshot.throws.items.map(({ record, ...row }) => {
        const { origin: _origin, end: _end, ...other } = record;
        return { ...row, record: other };
      }) };
      storage.setItem(key, JSON.stringify({ ...snapshot, throws }));
    },
    journal,
    append(kind, edit) {
      if (journal.entries().length >= 100) throw new Error("draft_limit");
      return journal.enqueue(kind, edit);
    },
    matchesStorageKey(storageKey) { return storageKey === key || journal.hasStorageKey(storageKey); },
  };
}

function withDraft(rows, entries, kind) {
  const active = new Map(rows.map((item) => [item.id, item]));
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    const { id, action, expectedRevision, record } = entry.body;
    const previous = active.get(id);
    if (action === "delete") {
      if (previous) active.set(id, { ...previous, draftId: entry.id, draftState: entry.state, deleting: true });
    } else {
      active.set(id, { id, kind, revision: expectedRevision + 1, record, draftId: entry.id, draftState: entry.state });
    }
  }
  return [...active.values()];
}

export function practiceDraftView(snapshot, entries) {
  const base = snapshot || EMPTY_PRACTICE;
  const dateOrder = (a, b) => String(b.record.date).localeCompare(a.record.date) || b.id.localeCompare(a.id);
  return {
    ...base,
    discs: withDraft(base.discs, entries, "disc"),
    throws: { ...base.throws, items: withDraft(base.throws.items, entries, "throw").sort(dateOrder) },
    putting: { ...base.putting, items: withDraft(base.putting.items, entries, "putting").sort(dateOrder) },
  };
}
