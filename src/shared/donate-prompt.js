// "$1 for the club, or No thanks" (owner: "add a PayPal app link at the end of every 5th completed casual round and on
// the results page of every completed club event giving the user an easy way to donate $1 or dismiss").
//   - Finished casual rounds are counted on this device (by round code, so one round counts once); the prompt shows on
//     the 5th, 10th, 15th…
//   - "No thanks" (or donating) hides it for that round or that event; the next 5th round asks again.
// The PayPal link is a paypal.me link, which the sign-up hand-off sends to the PayPal app (outside-link.js).
import React from "react";
import { resolveApiBase } from "./api-base.js";
import { readMemberToken } from "./member-session.js";
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

// ---- Telling the club about a donation (+10 karma for every dollar once an admin confirms it) ----
// PayPal.me can't tell the app who gave (owner: "Let's make ALL donations reward +10 karma per dollar"; an admin
// confirms each one): after giving, a signed-in member taps "I donated $X" (POST /me/donations).
export const KARMA_PER_DOLLAR = 10;

/** Report a donation: { ok, donation } or { ok: false, error }. */
export async function reportDonation(cents, source, { token = readMemberToken(), base = resolveApiBase(), fetchImpl = globalThis.fetch } = {}) {
  if (!token) return { ok: false, error: "signed_out" };
  try {
    const response = await fetchImpl(`${base}/me/donations`, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: cents, source }),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, donation: data.donation } : { ok: false, error: data.error || "failed" };
  } catch {
    return { ok: false, error: "offline" };
  }
}

const REPORT_ERRORS = {
  signed_out: "Sign in to the club app to earn karma for donations.",
  too_many_pending: "You have 3 donations waiting for the club to confirm. You can add more once they're confirmed.",
  rate_limited: "That's a lot of donations today! Try again tomorrow.",
  invalid_amount: "Enter an amount from $1 to $1,000.",
  default: "Couldn't record it. Try again in a moment.",
};

/** "Sent it? Tell the club": a set amount (the $1 prompts) or one the donor types. */
export function DonationReport({ source, cents = null, onDone }) {
  const [amount, setAmount] = React.useState("");
  const [state, setState] = React.useState(() => ({ status: readMemberToken() ? "idle" : "signed_out", message: "" }));
  async function send() {
    const value = cents ?? Math.round(Number(String(amount).replace(/[^0-9.]/g, "")) * 100);
    if (!Number.isFinite(value) || value < 100 || value > 100_000) {
      setState({ status: "idle", message: REPORT_ERRORS.invalid_amount });
      return;
    }
    setState({ status: "sending", message: "" });
    const result = await reportDonation(value, source);
    if (result.ok) {
      setState({ status: "done", message: `Thanks! +${Math.floor(value / 100) * KARMA_PER_DOLLAR} karma once the club confirms it.` });
      if (onDone) onDone(result.donation);
    } else {
      setState({ status: result.error === "signed_out" ? "signed_out" : "idle", message: REPORT_ERRORS[result.error] || REPORT_ERRORS.default });
    }
  }
  if (state.status === "signed_out") return h("p", { className: "donation-report-note", "data-donation-report": "signed-out" }, REPORT_ERRORS.signed_out);
  if (state.status === "done") return h("p", { className: "donation-report-note done", role: "status", "data-donation-report": "done" }, state.message);
  return h("div", { className: "donation-report", "data-donation-report": source }, [
    h("p", { className: "donation-report-note", key: "how" }, `Sent it? Tell the club for +${KARMA_PER_DOLLAR} karma a dollar once an admin confirms it.`),
    h("div", { className: "donation-report-row", key: "row" }, [
      cents == null ? h("label", { className: "donation-report-amount", key: "amount" }, [
        "Amount ($)",
        h("input", { type: "text", inputMode: "decimal", value: amount, placeholder: "10", key: "input", onChange: (event) => setAmount(event.target.value) }),
      ]) : null,
      h("button", { type: "button", className: "donation-report-send", disabled: state.status === "sending", onClick: send, key: "send" },
        state.status === "sending" ? "Sending…" : cents ? `I donated $${cents / 100}` : "I donated"),
    ]),
    state.message ? h("p", { className: "donation-report-note", role: "status", key: "message" }, state.message) : null,
  ]);
}

/** The prompt: a line, "Donate $1 with PayPal" (to the PayPal app), and "No thanks"; after giving, "I donated $1". */
export function DonateDollar({ promptKey, text, className = "" }) {
  const [state, setState] = React.useState(() => (promptDismissed(promptKey) ? "hidden" : "open"));
  if (state === "hidden") return null;
  if (state === "thanks") {
    return h("div", { className: `donate-prompt thanks ${className}`.trim(), "data-donate-prompt": "thanks" }, [
      h("p", { className: "donate-prompt-text", role: "status", key: "thanks" }, "Thank you for supporting the club!"),
      h(DonationReport, { source: String(promptKey).split(":")[0] === "event" ? "event" : "round", cents: 100, key: "report" }),
    ]);
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
