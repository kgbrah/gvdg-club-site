import { parseOfflineRound } from "../shared/offline-round.js";

const DB_NAME = "gvdg-offline-rounds";
const STORE_NAME = "rounds";

export function sameOfflineOwner(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id);
}

function ownerKey(owner) { return owner ? `${owner.kind}:${owner.id}` : "device"; }

function offlineError(code) {
  return Object.assign(new Error(code), { code });
}

export function createOfflineRoundStore(factory = () => globalThis.indexedDB) {
  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = factory().open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "localId" }).createIndex("ownerKey", "ownerKey");
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(offlineError("storage_busy"));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
      }).catch((error) => { opening = null; throw error; });
    }
    return opening;
  }

  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      let result;
      let failure;
      const fail = (error) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || offlineError("storage_aborted"));
      operation(tx.objectStore(STORE_NAME), (value) => { result = value; }, fail);
    });
  }

  function select(operation) {
    return transaction("readonly", (store, done) => {
      const request = operation(store);
      request.onsuccess = () => done(request.result);
    });
  }

  return {
    async list(owner) {
      const keys = owner ? [ownerKey(owner), "device"] : ["device"];
      const pages = await Promise.all(keys.map((key) => select((store) => store.index("ownerKey").getAll(key))));
      return pages.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
    get: (id) => select((store) => store.get(id)),
    add(round) {
      return transaction("readwrite", (store, done) => {
        const saved = { ...round, ownerKey: ownerKey(round.owner) };
        const request = store.add(saved);
        request.onsuccess = () => done(saved);
      });
    },
    update(id, expectedRevision, currentOwner, edit) {
      return transaction("readwrite", (store, done, fail) => {
        const request = store.get(id);
        request.onsuccess = () => {
          try {
            const previous = request.result;
            if (!previous) throw offlineError("local_round_missing");
            if (previous.owner && !sameOfflineOwner(previous.owner, currentOwner)) throw offlineError("offline_owner_mismatch");
            if (expectedRevision != null && expectedRevision !== previous.revision) throw offlineError("local_round_changed");
            const edited = edit(previous);
            if (!edited || edited === previous) { done(previous); return; }
            if (previous.owner && !sameOfflineOwner(previous.owner, edited.owner)) throw offlineError("offline_owner_mismatch");
            if (!previous.owner && edited.owner && (previous.startedAs !== "device" || !sameOfflineOwner(edited.owner, currentOwner))) {
              throw offlineError("offline_owner_mismatch");
            }
            if (previous.sealedAt && (!edited.sealedAt || JSON.stringify(parseOfflineRound(previous)) !== JSON.stringify(parseOfflineRound(edited)))) {
              throw offlineError("offline_round_sealed");
            }
            const next = { ...edited, localId: id, revision: previous.revision + 1, ownerKey: ownerKey(edited.owner) };
            store.put(next).onsuccess = () => done(next);
          } catch (error) { fail(error); }
        };
      });
    },
  };
}

export const offlineRoundStore = createOfflineRoundStore();
