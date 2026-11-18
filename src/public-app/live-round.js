// "Return to round" on Lost & Found: the way back to the scorecard you're on. Arriving from the scoring app's Tools
// carries it in the link; otherwise the page looks for a card you're on right now: a casual round from this phone's
// recent rounds (touched in the last 12 hours, checked live), then a live club event for a signed-in member.
import React from "react";

import { resolveApiBase } from "../shared/api-base.js";
import { safeRoundReturn } from "../shared/lost-found-model.js";
import { readMemberToken } from "../shared/member-session.js";
import { readOpenPlayToken } from "../score-app/open-play-session.js";

const ROUND_RETURN_KEY = "gvdg_lf_round_return";
const RECENT_ROUNDS_KEY = "gvdg_recent_rounds";
const RECENT_MS = 12 * 3_600_000;

function sessionGet() {
  try { return safeRoundReturn(sessionStorage.getItem(ROUND_RETURN_KEY)); } catch { return ""; }
}
function sessionSet(value) {
  try { if (value) sessionStorage.setItem(ROUND_RETURN_KEY, value); else sessionStorage.removeItem(ROUND_RETURN_KEY); } catch { /* the button still shows */ }
}

async function getJson(path, token, signal) {
  try {
    const response = await fetch(resolveApiBase({ datasetKeys: ["authBase"] }) + path, {
      cache: "no-store", headers: { Accept: "application/json", Authorization: "Bearer " + token }, signal,
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function recentRounds(now = Date.now()) {
  try {
    const rows = JSON.parse(localStorage.getItem(RECENT_ROUNDS_KEY) || "[]");
    return (Array.isArray(rows) ? rows : [])
      .map((row) => ({ code: String(row?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), updatedAt: Number(row?.updatedAt || 0) }))
      .filter((row) => row.code && now - row.updatedAt < RECENT_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** The scorecard you're on right now, as a score.html link, or "". */
export async function findLiveRound(signal) {
  const member = readMemberToken();
  let open = "";
  try { open = readOpenPlayToken() || ""; } catch { /* no open-play scorer here */ }
  const token = member || open;
  if (!token) return "";
  for (const row of recentRounds()) {
    const data = await getJson(`/rounds/${encodeURIComponent(row.code)}/live/mine`, token, signal);
    if (data?.status === "live" && data.cardId != null) return "score.html?round=" + row.code;
  }
  if (member) {
    const data = await getJson("/my-live-rounds", member, signal);
    const event = Array.isArray(data?.rounds) ? data.rounds.find((row) => row && row.id != null) : null;
    if (event) return "score.html?event=" + encodeURIComponent(String(event.id));
  }
  return "";
}

/** [href, clear]: the link from the scoring app (kept for this visit), else a live card found for you. */
export function useRoundReturn(route) {
  const fromScore = route.query.get("from") === "score" ? safeRoundReturn(route.query.get("return")) : "";
  const [found, setFound] = React.useState(() => fromScore || sessionGet());
  React.useEffect(() => {
    if (fromScore) {
      setFound(fromScore);
      sessionSet(fromScore);
    }
  }, [fromScore]);
  const known = Boolean(found);
  React.useEffect(() => {
    if (known) return undefined;
    const controller = new AbortController();
    findLiveRound(controller.signal).then((href) => {
      const safe = safeRoundReturn(href);
      if (!controller.signal.aborted && safe) {
        setFound(safe);
        sessionSet(safe);
      }
    });
    return () => controller.abort();
  }, [known]);
  return [found, () => sessionSet("")];
}
