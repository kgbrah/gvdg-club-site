// The field test log: a ring buffer of timestamped events that survives reloads, closing the app and
// restarting the phone. Browsers keep it in IndexedDB; tests use the in-memory backend, which keeps its
// rows across store instances the same way a database keeps them across page loads.

export const FIELD_LOG_CAP = 10_000;
export const FIELD_DB_NAME = "gvdg-field-test";
const STORE = "events";

/** In-memory backend with the same contract as the IndexedDB one. */
export function createMemoryFieldBackend() {
  let rows = [];
  let next = 1;
  return {
    async append(events, cap) {
      for (const event of events) rows.push({ ...event, seq: next++ });
      if (rows.length > cap) rows = rows.slice(rows.length - cap);
      return rows.length;
    },
    async all() { return rows.map((row) => ({ ...row })); },
    async count() { return rows.length; },
    async clear() { rows = []; },
  };
}

/** IndexedDB backend: one object store keyed by an auto-increment sequence number. */
export function createIdbFieldBackend(indexedDB, name = FIELD_DB_NAME) {
  let opening = null;
  function open() {
    if (!indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE, { keyPath: "seq", autoIncrement: true });
        };
        request.onerror = () => reject(request.error || new Error("Field log unavailable"));
        request.onblocked = () => reject(new Error("Field log upgrade is blocked"));
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => { database.close(); opening = null; };
          resolve(database);
        };
      }).catch((error) => { opening = null; throw error; });
    }
    return opening;
  }
  function run(mode, work) {
    return open().then((database) => new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      let result;
      work(transaction.objectStore(STORE), (value) => { result = value; });
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error("Field log write failed"));
      transaction.onerror = () => {};
    }));
  }
  return {
    append(events, cap) {
      return run("readwrite", (store, done) => {
        for (const event of events) {
          const { seq: _ignored, ...row } = event;
          store.add(row);
        }
        // Trim in the same transaction, so a second open tab can't push the log past the cap.
        const counted = store.count();
        counted.onsuccess = () => {
          let excess = counted.result - cap;
          done(Math.min(counted.result, cap));
          if (excess <= 0) return;
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at || excess <= 0) return;
            at.delete();
            excess -= 1;
            at.continue();
          };
        };
      });
    },
    all() {
      return run("readonly", (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result || []);
      });
    },
    count() {
      return run("readonly", (store, done) => {
        const request = store.count();
        request.onsuccess = () => done(request.result || 0);
      });
    },
    clear() {
      return run("readwrite", (store) => { store.clear(); });
    },
  };
}

/** The ring buffer over a backend. Writes are serialised so events keep their order. */
export function createFieldStore(backend, { cap = FIELD_LOG_CAP } = {}) {
  let tail = Promise.resolve();
  const queue = (work) => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
  return {
    cap,
    append: (events) => queue(() => (events.length ? backend.append(events, cap) : backend.count())),
    all: () => queue(() => backend.all()).then((rows) => rows.sort((a, b) => a.seq - b.seq)),
    count: () => queue(() => backend.count()),
    clear: () => queue(() => backend.clear()),
  };
}

let browserStore = null;
/** The page's shared store over IndexedDB. */
export function fieldLogStore() {
  if (!browserStore) browserStore = createFieldStore(createIdbFieldBackend(globalThis.indexedDB));
  return browserStore;
}
