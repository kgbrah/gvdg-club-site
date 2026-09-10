import { parseMatchGrid, parseRyderWorkbook, parseScoreboard } from "../../ryder-cup.js";
import { resolveApiBase } from "./api-base.js";
import { mergeRyderCupData } from "../public-app/ryder-board-merge.js";

export const RYDER_CUP_LEAGUE_ID = 4;
const SHEET_ID = "1PSP5bZaG-db04YeREGjQHzlQlLT6QT97np7WBbEGq5I";

function gvizUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

function config() {
  const data = globalThis.document?.body?.dataset || {};
  return {
    gridCsvUrl: String(data.gridCsv || "").trim() || gvizUrl("2109671762"),
    scoreboardCsvUrl: String(data.scoreboardCsv || "").trim() || gvizUrl("932426467"),
    workbookUrl: String(data.workbookUrl || "").trim() ||
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx&id=${SHEET_ID}`,
  };
}

async function fetchCsv(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Sheet request failed (${response.status})`);
  return response.text();
}

async function fetchWorkbook(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Workbook request failed (${response.status})`);
  return response.arrayBuffer();
}

export async function fetchRyderSheetData() {
  const urls = config();
  try {
    const workbook = await fetchWorkbook(urls.workbookUrl);
    return await parseRyderWorkbook(workbook);
  } catch {
    const [gridCsv, scoreboardCsv] = await Promise.all([
      fetchCsv(urls.gridCsvUrl),
      fetchCsv(urls.scoreboardCsvUrl),
    ]);
    const { weeks, teamPoints } = parseMatchGrid(gridCsv);
    const scoreboard = parseScoreboard(scoreboardCsv);
    return { weeks, teamPoints, scoreboard };
  }
}

export async function fetchMergedRyderData() {
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
