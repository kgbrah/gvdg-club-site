import { layoutQuality, layoutRevision, layoutRows, mapCoordinates } from "./course-quality.js";

const PACKS_DB = "gvdg-course-packs";
const PACKS_STORE = "layouts";
const PACK_VERSION = 1;

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function coursePackKey(courseId, layoutId) {
  const course = positiveId(courseId);
  const layout = positiveId(layoutId);
  return course && layout ? course + ":" + layout : "";
}

function snapshotMarker(marker) {
  if (!marker || typeof marker !== "object") return null;
  const coordinates = mapCoordinates(marker);
  const label = typeof marker.label === "string" ? marker.label.slice(0, 120) : "";
  return coordinates || label ? {
    label, lat: coordinates?.lat ?? null, lng: coordinates?.lng ?? null,
    ...(marker.source === "community" ? { source: "community" } : {}),
  } : null;
}

function makePack(course, layout, savedAt) {
  const key = coursePackKey(course?.id, layout?.id);
  const quality = layoutQuality(layout);
  if (!key || !quality.holes.length || (layout.course_id != null && Number(layout.course_id) !== Number(course.id))) return null;
  const storedLayout = {
    id: positiveId(layout.id), course_id: positiveId(course.id), name: String(layout.name || "Layout"),
    expected_holes: layout.expected_holes ?? layout.hole_count ?? null,
    total_par: Number.isFinite(layout.total_par) ? layout.total_par : null,
    created_at: layout.created_at ?? null, updated_at: layout.updated_at ?? null, map_updated_at: layout.map_updated_at ?? null,
    holes: layoutRows(layout).map((row) => {
      if (!row || typeof row !== "object") return null;
      const rawHole = row.hole ?? row.number;
      const hole = quality.holes.find((item) => item.hole === Number(rawHole));
      const distance = Number(row.distance_ft);
      const teeSignId = positiveId(row.verified?.tee_sign_id ?? row.tee_sign_id);
      return {
        hole: rawHole, par: hole?.par ?? null, par_source: hole?.parSource ?? null,
        tee: snapshotMarker(row.tee), target: snapshotMarker(row.target),
        distance_ft: Number.isFinite(distance) && distance > 0 ? distance : null,
        distance_source: typeof row.distance_source === "string" ? row.distance_source : null,
        ...(teeSignId ? { tee_sign_id: teeSignId } : {}),
      };
    }),
  };
  const storedQuality = layoutQuality(storedLayout);
  return {
    version: PACK_VERSION, key, savedAt, revision: layout.revision || layoutRevision(layout),
    contentRevision: layoutRevision(storedLayout),
    course: { id: positiveId(course.id), name: String(course.name || "Course"), location: String(course.location || ""), ...mapCoordinates(course) },
    layout: storedLayout,
    quality: storedQuality,
    assets: { layout: "saved", schematicHoles: storedQuality.mappedCount, satellite: "not-included" },
  };
}

function validPack(pack) {
  if (pack?.version !== PACK_VERSION || !pack.key ||
      pack.key !== coursePackKey(pack.course?.id, pack.layout?.id) ||
      pack.layout.course_id !== pack.course.id || !Array.isArray(pack.layout.holes) ||
      typeof pack.savedAt !== "string" || !Array.isArray(pack.quality?.holes) ||
      pack.assets?.layout !== "saved" || pack.assets.satellite !== "not-included") return false;
  return pack.contentRevision === layoutRevision(pack.layout) &&
    pack.assets.schematicHoles === layoutQuality(pack.layout).mappedCount;
}

function failure(error) {
  if (error?.name === "QuotaExceededError") return "storage-full";
  return "storage-unavailable";
}

function openDb(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) throw new Error("IndexedDB unavailable");
    const request = factory.open(PACKS_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PACKS_STORE, { keyPath: "key" });
    request.onblocked = () => reject(new Error("Course pack storage is busy"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function indexedPackDriver(factory) {
  async function execute(mode, action) {
    const db = await openDb(factory());
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(PACKS_STORE, mode);
        const request = action(transaction.objectStore(PACKS_STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error || request.error || new Error("Course pack transaction was aborted"));
        transaction.onerror = () => reject(transaction.error || request.error);
      });
    } finally {
      db.close();
    }
  }
  return {
    list: () => execute("readonly", (store) => store.getAll()),
    put: (pack) => execute("readwrite", (store) => store.put(pack)),
    get: (key) => execute("readonly", (store) => store.get(key)),
    remove: (key) => execute("readwrite", (store) => store.delete(key)),
  };
}

// Resolves only once the record can be read back after the transaction commits.
export function createCoursePackStore(driver = indexedPackDriver(() => globalThis.indexedDB)) {
  return {
    async list() {
      try {
        const rows = await driver.list();
        const packs = rows.filter(validPack).sort((a, b) => a.course.name.localeCompare(b.course.name) || a.layout.name.localeCompare(b.layout.name));
        return { ok: true, packs, unreadable: rows.length - packs.length };
      } catch (error) {
        return { ok: false, error: failure(error), packs: [] };
      }
    },
    async get(courseId, layoutId) {
      const key = coursePackKey(courseId, layoutId);
      if (!key) return { ok: false, error: "invalid-layout" };
      try {
        const pack = await driver.get(key);
        return pack == null ? { ok: false, error: "not-saved" } :
          validPack(pack) ? { ok: true, pack } : { ok: false, error: "unreadable-pack" };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    },
    async save(course, layout, date = new Date()) {
      const pack = makePack(course, layout, date.toISOString());
      if (!pack) return { ok: false, error: "invalid-layout" };
      try {
        await driver.put(pack);
        const saved = await driver.get(pack.key);
        if (!validPack(saved) || saved.revision !== pack.revision || saved.savedAt !== pack.savedAt) {
          return { ok: false, error: "could-not-confirm" };
        }
        return { ok: true, pack: saved };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    },
    async remove(courseId, layoutId) {
      const key = coursePackKey(courseId, layoutId);
      if (!key) return { ok: false, error: "invalid-layout" };
      try {
        await driver.remove(key);
        if (await driver.get(key) != null) return { ok: false, error: "could-not-confirm" };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    },
  };
}

export const coursePackStore = createCoursePackStore();
