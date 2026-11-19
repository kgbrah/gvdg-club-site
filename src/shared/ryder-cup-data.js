import { resolveApiBase } from "./api-base.js";
import { mergeRyderCupData } from "../public-app/ryder-board-merge.js";
import { RYDER_CUP_2026_FINAL } from "./ryder-cup-2026-final.js";

export const RYDER_CUP_LEAGUE_ID = 4;

/** The season's official tally. The 2026 Ryder Cup is over, so this is the club's Google Sheet as it stood at the
 *  end, saved in the app (ryder-cup-2026-final.js): no download from Google, and the standings stay exactly as they
 *  were (the sheet has all 66 matches; the app's own results only the 22 it imported). */
export async function fetchRyderSheetData() {
  return RYDER_CUP_2026_FINAL;
}

// One merge per visit, shared by every panel that shows Ryder Cup standings (Stats and the league panel both asked).
// Kept 5 minutes; a failure isn't kept.
const RYDER_FRESH_MS = 5 * 60_000;
let mergedRyder = null;

export function fetchMergedRyderData() {
  const now = Date.now();
  if (mergedRyder && now - mergedRyder.at < RYDER_FRESH_MS) return mergedRyder.promise;
  const promise = loadMergedRyderData().catch((error) => {
    if (mergedRyder?.promise === promise) mergedRyder = null;
    throw error;
  });
  mergedRyder = { at: now, promise };
  return promise;
}

async function loadMergedRyderData() {
  const sheetPromise = fetchRyderSheetData().catch(() => null);
  let live = null;
  try {
    const base = resolveApiBase({ datasetKeys: ["apiBase", "authBase"] });
    const response = await fetch(`${base}/leagues/${RYDER_CUP_LEAGUE_ID}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.ok) live = await response.json();
  } catch {
    live = null;
  }
  const sheet = await sheetPromise;
  if (!live && !sheet) throw new Error("ryder_unavailable");
  return mergeRyderCupData(live, sheet);
}
