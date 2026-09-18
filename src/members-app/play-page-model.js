import { liveWatchHref } from "../shared/live-watch.js";

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function relClass(delta) {
  if (delta == null) return "";
  return delta < 0 ? "under" : delta > 0 ? "over" : "even";
}

export function publicCasualRound(row) {
  const code = String(row?.round_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return null;
  const title = String(row.course_name || "").trim() || ("Casual round " + code);
  return {
    kind: "casual",
    code,
    title,
    layout: String(row.layout_name || "").trim(),
    when: row.finalized_at || row.created_at || "",
    total: numberOrNull(row.total),
    toPar: numberOrNull(row.to_par),
    place: numberOrNull(row.place),
    href: liveWatchHref({ roundCode: code }),
    sort: Date.parse(row.finalized_at || row.created_at || "") || 0,
  };
}

export function recentPlayRounds(casual, limit = 8) {
  const seen = new Set();
  const rows = [];
  for (const raw of Array.isArray(casual) ? casual : []) {
    const row = publicCasualRound(raw);
    if (!row || seen.has(row.code)) continue;
    seen.add(row.code);
    rows.push(row);
  }
  return rows.sort((a, b) => (b.sort || 0) - (a.sort || 0)).slice(0, limit);
}
