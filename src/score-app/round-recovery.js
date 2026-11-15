const JOURNAL = "gvdg:round-recovery:";
const DEVICE = "gvdg:round-recovery-device";

export function roundRecoveryScope({ roundCode, eventId, roundId, cardId, playerIndex }) {
  if ((!roundCode && !eventId) || !roundId || cardId == null || !Number.isInteger(playerIndex)) return null;
  return {
    key: JSON.stringify([roundCode ? "round" : "event", roundCode || eventId, roundId, cardId, playerIndex]),
    roundId,
    cardId,
    actorIndex: playerIndex,
  };
}

export function recoveryResult(result) {
  if (result && result.ok) return "saved";
  const status = Number(result && result.status);
  if (!status || status === 408 || status === 425 || status === 429 || status >= 500) return "pending";
  if (status === 401 || status === 403) return "auth";
  return "error";
}

export function retryDelay(result, attempt, now = Date.now()) {
  const header = result && result.retryAfter;
  const retryAfter = header == null ? 0
    : /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Math.max(Number.isFinite(retryAfter) ? Math.min(retryAfter, 300_000) : 0,
    Math.min(60_000, 1500 * 2 ** Math.min(6, Math.max(0, attempt - 1))));
}

export function createRoundJournal(storage, scope, { now = Date.now, uuid = () => crypto.randomUUID() } = {}) {
  const encodedScope = encodeURIComponent(scope.key);
  const prefix = JOURNAL + encodedScope + ":";
  const lockKey = JOURNAL + "submitted:" + encodedScope;
  const read = (key) => JSON.parse(storage.getItem(key) || "null");
  const keyFor = (item) => prefix + item.id;
  const write = (item) => storage.setItem(keyFor(item), JSON.stringify(item));

  function entries() {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key && key.startsWith(prefix))
      .map(read)
      .filter(Boolean)
      .sort((a, b) => a.order.localeCompare(b.order));
  }

  function enqueue(kind, body, previous) {
    // Each mutation gets its own durable key. An acknowledgement can only remove the exact
    // request it sent, even if another tab or rapid tap wrote an edit during the request.
    const device = read(DEVICE) || { stream: uuid(), clock: 0 };
    device.clock = Math.max(now(), device.clock + 1);
    storage.setItem(DEVICE, JSON.stringify(device));
    const id = uuid();
    const order = String(device.clock).padStart(16, "0") + ":" + id;
    const item = {
      id, stream: device.stream, order, kind, body, state: "pending", attempt: 0, nextAt: 0,
      ...(previous === undefined ? {} : { previous }),
    };
    write(item);
    return item;
  }

  return {
    entries,
    enqueue,
    lockName: prefix,
    writeLockName: prefix + "writes",
    isSubmitted: () => storage.getItem(lockKey) === "1",
    markSubmitted: () => storage.setItem(lockKey, "1"),
    hasStorageKey: (key) => !key || key.startsWith(prefix),
    remove: (item) => storage.removeItem(keyFor(item)),
    update(item, patch) {
      const existing = read(keyFor(item));
      if (existing) write({ ...existing, ...patch });
    },
  };
}

/** Drain strictly in order, re-reading the journal after each acknowledgement. */
export async function drainRoundJournal(journal, send, {
  now = Date.now, active = () => true, online = () => true, onResult = () => {},
} = {}) {
  while (active() && online()) {
    const items = journal.entries();
    const item = items.find((row) => row.state !== "error");
    if (!item || item.state === "auth") return null;
    if (item.nextAt > now()) return item.nextAt;
    const result = await send(item);
    // Scope changes don't invalidate the write result, but a request skipped before sending
    // must leave the item exactly as it was for the next session.
    if (!result) return null;
    const state = recoveryResult(result);
    if (state === "saved") journal.remove(item);
    else {
      const attempt = item.attempt + 1;
      journal.update(item, {
        state,
        attempt,
        nextAt: state === "pending" ? now() + retryDelay(result, attempt, now()) : 0,
        error: result.data && result.data.error || null,
      });
    }
    onResult(item, state, result);
    if (state === "auth") return null;
  }
  return null;
}

export function resetJournalRetries(journal, { includeErrors = false, wakePending = true } = {}) {
  for (const item of journal.entries()) {
    if (item.state === "auth" || (includeErrors && item.state === "error")) {
      journal.update(item, { state: "pending", attempt: 0, nextAt: 0, error: null });
    } else if (wakePending && item.state === "pending" && item.nextAt) {
      journal.update(item, { nextAt: 0 });
    }
  }
}
