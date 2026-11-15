import { recoveryResult, retryDelay } from "./round-recovery.js";

const DB_NAME = "gvdg-clip-recovery";
const STORE = "clips";

export function createClipStore(indexedDB) {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("scopeKey", "scopeKey");
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Clip storage upgrade is blocked"));
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => { database.close(); opening = null; };
          resolve(database);
        };
      }).catch((error) => { opening = null; throw error; });
    }
    return opening;
  }
  async function transact(mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || request.error || new Error("Clip storage transaction aborted"));
    });
  }
  return {
    list: (scopeKey) => transact("readonly", (store) => store.index("scopeKey").getAll(scopeKey)),
    put: (record) => transact("readwrite", (store) => store.put(record)),
    remove: (id) => transact("readwrite", (store) => store.delete(id)),
  };
}

/** Keep the original blob until the server confirms the clip's retrievable record. */
export async function drainClipDrafts(store, scopeKey, send, {
  now = Date.now, active = () => true, online = () => true, onResult = () => {},
} = {}) {
  while (active() && online()) {
    const rows = (await store.list(scopeKey)).filter((row) => row.state === "pending");
    if (!active() || !rows.length) return null;
    const row = rows.sort((a, b) => (a.nextAt - b.nextAt) || (a.createdAt - b.createdAt))[0];
    if (row.nextAt > now()) return row.nextAt;
    const result = await send(row);
    if (!result) return null;
    const state = result.ok && !result.data?.id ? "pending" : recoveryResult(result);
    if (state === "saved") await store.remove(row.id);
    else {
      const attempt = row.attempt + 1;
      await store.put({
        ...row, state, attempt,
        nextAt: state === "pending" ? now() + retryDelay(result, attempt, now()) : 0,
        error: result.data?.error || null,
      });
    }
    onResult(row, state);
    if (state === "auth") return null;
  }
  return null;
}
