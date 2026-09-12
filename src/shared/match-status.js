/**
 * Canonical on-screen matchplay label for one side.
 *
 * The worker stores per-side `status` + `outcome`. Closed matches keep
 * "won N&M" on both sides; the trailer/loser must read as "N down" / "lost N&M".
 * Live labels after the N-up/N-down fix already differ by side. This still
 * remaps so older stored results and any leftover "N up" trailer rows stay honest.
 */
export function displayMatchStatus(match) {
  if (!match) return "AS";
  const status = String(match.status || "").trim();
  if (!status) return "AS";
  const trailing = match.outcome === "lost" || match.outcome === "trailing";
  if (!trailing) return status;
  return status
    .replace(/^won /i, "lost ")
    .replace(/^(\d+) up\b/i, "$1 down");
}
