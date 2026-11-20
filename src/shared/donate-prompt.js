// "$1 for the club, or No thanks" (owner: "add a PayPal app link at the end of every 5th completed casual round and on
// the results page of every completed club event giving the user an easy way to donate $1 or dismiss").
//   - Finished casual rounds are counted on this device (by round code, so one round counts once); the prompt shows on
//     the 5th, 10th, 15th…
//   - "No thanks" (or donating) hides it for that round or that event; the next 5th round asks again.
// The PayPal link is a paypal.me link, which the sign-up hand-off sends to the PayPal app (outside-link.js).
import React from "react";
import { SIGNUP_LINK } from "./outside-link.js";

const h = React.createElement;

export const CLUB_PAYPAL_ME = "https://paypal.me/greenvillediscgolf";
export const DONATE_EVERY = 5;
const ROUNDS_KEY = "gvdg_finished_casual_rounds";
const DISMISS_PREFIX = "gvdg_donate_dismissed:";
const KEEP_RECENT = 60;

/** The club's PayPal.me link, with an amount in dollars (none: the person picks). */
export function clubPaypalUrl(dollars) {
  return Number(dollars) > 0 ? `${CLUB_PAYPAL_ME}/${Number(dollars)}` : CLUB_PAYPAL_ME;
}

function local() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

function readRounds(storage) {
  try {
    const data = JSON.parse(storage?.getItem(ROUNDS_KEY) || "null");
    if (data && Number.isInteger(data.count) && Array.isArray(data.recent)) return data;
  } catch { /* start over */ }
  return { count: 0, recent: [], asked: [] };
}

/**
 * Count a finished casual round (once per round code) and say whether to ask for $1 here: the round that made the
 * count a multiple of DONATE_EVERY. Returns { count, ask }.
 */
export function recordFinishedCasualRound(code, storage = local()) {
  const key = String(code || "").trim().toUpperCase();
  const data = readRounds(storage);
  data.asked = Array.isArray(data.asked) ? data.asked : [];
  if (key && !data.recent.includes(key)) {
    data.count += 1;
    data.recent = [...data.recent, key].slice(-KEEP_RECENT);
    if (data.count % DONATE_EVERY === 0) data.asked = [...data.asked, key].slice(-KEEP_RECENT);
    try { storage?.setItem(ROUNDS_KEY, JSON.stringify(data)); } catch { /* private mode: no prompt */ }
  }
  return { count: data.count, ask: Boolean(key) && data.asked.includes(key) && !promptDismissed("round:" + key, storage) };
}

export function promptDismissed(promptKey, storage = local()) {
  try { return Boolean(storage?.getItem(DISMISS_PREFIX + promptKey)); } catch { return false; }
}

export function dismissPrompt(promptKey, storage = local()) {
  try { storage?.setItem(DISMISS_PREFIX + promptKey, String(Date.now())); } catch { /* harmless */ }
}

/** The prompt: a line, "Donate $1 with PayPal" (to the PayPal app), and "No thanks". */
export function DonateDollar({ promptKey, text, className = "" }) {
  const [state, setState] = React.useState(() => (promptDismissed(promptKey) ? "hidden" : "open"));
  if (state === "hidden") return null;
  if (state === "thanks") {
    return h("p", { className: `donate-prompt thanks ${className}`.trim(), role: "status", "data-donate-prompt": "thanks" }, "Thank you for supporting the club!");
  }
  return h("div", { className: `donate-prompt ${className}`.trim(), "data-donate-prompt": promptKey }, [
    h("p", { className: "donate-prompt-text", key: "text" }, text),
    h("div", { className: "donate-prompt-actions", key: "actions" }, [
      h("a", {
        className: "donate-prompt-give", href: clubPaypalUrl(1), key: "give", ...SIGNUP_LINK,
        onClick: () => { dismissPrompt(promptKey); setState("thanks"); },
      }, "Donate $1 with PayPal"),
      h("button", { className: "donate-prompt-dismiss", type: "button", key: "dismiss", onClick: () => { dismissPrompt(promptKey); setState("hidden"); } }, "No thanks"),
    ]),
  ]);
}

/** After a finished casual round: count it, and on every 5th ask for $1. */
export function RoundDonatePrompt({ roundCode }) {
  const [ask, setAsk] = React.useState(false);
  React.useEffect(() => {
    if (roundCode) setAsk(recordFinishedCasualRound(roundCode).ask);
  }, [roundCode]);
  if (!ask) return null;
  return h(DonateDollar, {
    promptKey: "round:" + String(roundCode).toUpperCase(),
    text: "Nice round! Chip in $1 to help the club keep this app running?",
    className: "round-donate",
  });
}
