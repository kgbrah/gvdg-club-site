// Presentation helpers for the public bag-tag board (pure, unit-tested).

const ASSIGNED = /^Assigned\s+#(\d+)\s+to\s+(.+)$/i;
const RELEASED = /^Released\s+#(\d+)\s+from\s+(.+)$/i;

function parseMove(move) {
  const summary = String((move && move.summary) || "").trim();
  let match = summary.match(ASSIGNED);
  if (match) return { kind: "assign", tag: Number(match[1]), name: match[2].trim(), summary };
  match = summary.match(RELEASED);
  if (match) return { kind: "release", tag: Number(match[1]), name: match[2].trim(), summary };
  return { kind: "other", tag: null, name: "", summary };
}

/** Moves arrive newest first. Consecutive assign/release churn for the same tag + member (and
 *  identical repeats) collapses into one entry showing the newest state with a `count`. */
export function collapseBagTagMoves(moves, limit = 8) {
  const out = [];
  for (const move of Array.isArray(moves) ? moves : []) {
    const parsed = parseMove(move);
    if (!parsed.summary) continue;
    const last = out[out.length - 1];
    const sameTag = last && parsed.kind !== "other" && last.kind !== "other"
      && last.tag === parsed.tag && last.name.toLowerCase() === parsed.name.toLowerCase();
    const sameText = last && last.kind === "other" && parsed.kind === "other" && last.summary === parsed.summary;
    if (sameTag || sameText) {
      last.count += 1;
      continue;
    }
    out.push({ id: move.id, createdAt: move.createdAt || "", count: 1, ...parsed });
  }
  return out.slice(0, limit);
}

export function bagTagHolderGroups(holders) {
  const list = (Array.isArray(holders) ? holders : [])
    .filter((holder) => holder && Number.isFinite(Number(holder.tagNumber)))
    .slice()
    .sort((a, b) => Number(a.tagNumber) - Number(b.tagNumber));
  return { podium: list.slice(0, 3), rest: list.slice(3) };
}
