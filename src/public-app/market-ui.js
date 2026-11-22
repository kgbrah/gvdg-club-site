import React from "react";
import { Disc3 } from "lucide-react";
import { KarmaChip } from "../shared/karma.js";

import { safeExternalUrl } from "../shared/safe-url.js";
import {
  feedbackLabel, GUEST_UNAVAILABLE, LISTING_STATUS_LABELS, money, payMethodLabel, REPORT_REASONS, SAFETY_NOTE,
  safePayUrl, traderHref, validEmail,
} from "../shared/market-model.js";
import { clearGuest, errorMessage, IDENTITY_EVENT, marketRequest, photoSrc, readGuest, writeGuest } from "./market-api.js";
import { shownProfilePhoto } from "../shared/profile-photo.js";

const h = React.createElement;
const EMPTY_VIEWER = { kind: "public", key: null, name: null, isAdmin: false };

// ---- One shared /market/config read per identity ----

let configState = { status: "loading", guestCheckout: false, viewer: EMPTY_VIEWER };
let configPending = null;
const configListeners = new Set();

function publishConfig(next) {
  configState = next;
  configListeners.forEach((listener) => listener(next));
}

export function reloadMarketConfig() {
  const request = marketRequest("/market/config").then(({ ok, data }) => {
    if (configPending !== request) return;
    configPending = null;
    const viewer = data.viewer && typeof data.viewer === "object" ? { ...EMPTY_VIEWER, ...data.viewer } : EMPTY_VIEWER;
    publishConfig(ok
      ? { status: "ready", guestCheckout: data.guestCheckout === true, viewer }
      : { status: "error", guestCheckout: false, viewer });
  });
  configPending = request;
  return request;
}

if (typeof window !== "undefined") {
  window.addEventListener(IDENTITY_EVENT, () => { void reloadMarketConfig(); });
}

export function useMarketConfig() {
  const [state, setState] = React.useState(configState);
  React.useEffect(() => {
    configListeners.add(setState);
    setState(configState);
    if ((configState.status === "loading" || configState.status === "error") && !configPending) void reloadMarketConfig();
    return () => configListeners.delete(setState);
  }, []);
  return state;
}

/** Re-run a loader whenever the marketplace identity changes (guest verified or signed out). */
export function useIdentityVersion() {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    window.addEventListener(IDENTITY_EVENT, bump);
    return () => window.removeEventListener(IDENTITY_EVENT, bump);
  }, []);
  return version;
}

// ---- Small shared pieces ----

export function Note({ children, tone = "", ...rest }) {
  return h("p", { className: "market-note" + (tone ? " " + tone : ""), ...rest }, children);
}

export function StatusLine({ message }) {
  return h("p", {
    "aria-live": "polite",
    className: "shop-status" + (message?.tone ? " " + message.tone : ""),
    role: "status",
  }, message?.text || "");
}

export function GuestBadge() {
  return h("span", { className: "market-badge market-guest-badge" }, "Guest buyer");
}

export function StatusChip({ status, hidden }) {
  if (hidden) return h("span", { className: "market-chip market-chip-hidden" }, "Hidden by admin");
  if (!status || status === "active") return null;
  return h("span", { className: "market-chip market-chip-" + status }, LISTING_STATUS_LABELS[status] || status);
}

export function SafetyNote() {
  return h("p", { className: "market-safety", "data-market-safety": "true" }, SAFETY_NOTE);
}

function traderPhoto(photo) {
  if (typeof photo !== "string") return "";
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return photo;
  const safe = safeExternalUrl(photo);
  return safe.startsWith("https://") ? shownProfilePhoto(safe) : "";
}

export function FeedbackText({ summary }) {
  return h("span", { className: "market-feedback" }, feedbackLabel(summary));
}

export function TraderLine({ trader, link = true, showPhoto = false }) {
  if (!trader) return null;
  const photo = showPhoto ? traderPhoto(trader.photo) : "";
  return h("span", { className: "market-trader" }, [
    photo ? h("img", { alt: "", className: "market-trader-photo", key: "photo", src: photo }) : null,
    link && trader.key
      ? h("a", { className: "market-trader-name", href: traderHref(trader.key), key: "name" }, trader.name || "Trader")
      : h("strong", { className: "market-trader-name", key: "name" }, trader.name || "Trader"),
    trader.kind === "guest" ? h(GuestBadge, { key: "guest" }) : null,
    h(KarmaChip, { key: "karma", traderKey: trader.key }),
    trader.feedback ? h(FeedbackText, { key: "feedback", summary: trader.feedback }) : null,
  ]);
}

export function MarketPhoto({ photo, alt, className = "product-img" }) {
  const src = photoSrc(photo);
  const [failed, setFailed] = React.useState("");
  if (src && failed !== src) {
    return h("img", { alt: alt || "", className, loading: "lazy", onError: () => setFailed(src), src });
  }
  return h("div", { "aria-hidden": "true", className: "product-fallback" }, h(Disc3, { size: 44, strokeWidth: 1.45 }));
}

export function useAction() {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(null);
  const run = React.useCallback(async (job) => {
    if (busy) return null;
    setBusy(true);
    setMessage(null);
    try {
      return await job();
    } finally {
      setBusy(false);
    }
  }, [busy]);
  return { busy, message, setMessage, run };
}

// ---- Pay options ----

function CopyButton({ text, label }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return h("button", { "aria-label": label, className: "shop-filter-reset market-copy", onClick: copy, type: "button" }, copied ? "Copied" : "Copy");
}

export function PayOptions({ pay, primary = true }) {
  if (!pay) return null;
  const methods = Array.isArray(pay.methods) ? pay.methods : [];
  const amount = money(pay.amountCents);
  return h("div", { className: "market-pay", "data-market-pay": "true" }, [
    h("h3", { className: "market-subhead", key: "title" }, "Pay the seller" + (amount ? " " + amount : "")),
    methods.length
      ? h("ul", { className: "market-pay-list", key: "list" }, methods.map((method) => {
        const label = payMethodLabel(method.method) || method.label || "Pay";
        if (method.method === "zelle") {
          return h("li", { className: "market-pay-row", "data-pay-method": "zelle", key: "zelle" }, [
            h("strong", { key: "label" }, "Zelle"),
            h("span", { className: "market-pay-instruction", key: "instruction" }, method.instruction || ""),
            h("span", { className: "market-pay-handle", key: "handle" }, [
              h("code", { key: "code" }, method.handle || ""),
              method.handle ? h(CopyButton, { key: "copy", label: "Copy Zelle handle", text: method.handle }) : null,
            ]),
          ]);
        }
        const url = safePayUrl(method.method, method.url);
        return h("li", { className: "market-pay-row", "data-pay-method": method.method, key: method.method }, [
          url
            ? h("a", { className: "shop-btn market-pay-link" + (primary ? "" : " secondary"), href: url, key: "link", rel: "noopener noreferrer", target: "_blank" },
              `Pay ${amount} with ${label}`)
            : h("strong", { key: "label" }, label),
          h("span", { className: "market-pay-handle", key: "handle" }, method.method === "cashapp" ? method.handle : method.handle ? "paypal.me/" + method.handle : ""),
        ]);
      }))
      : h(Note, { key: "none" }, "The seller hasn't added payment options yet. Arrange payment with them when you meet."),
  ]);
}

// ---- Guest identity ----

const MARKET_GUEST_INTRO = "Not a club member? Buy or post WANTED as a guest. Your email stays private; sellers see only your display name.";

/** The club's guest check (the same identity on the marketplace and Lost & Found). */
export function GuestGate(props) {
  const config = useMarketConfig();
  return h(GuestGateView, { ...props, available: config.status === "ready" ? config.guestCheckout : null });
}

export function GuestGateView({
  onVerified, onCancel, title = "Verify your email to continue", available = null, intro = MARKET_GUEST_INTRO,
  startPath = "/market/guest/start", verifyPath = "/market/guest/verify", unavailableTitle = "Guest checkout", unavailableText = GUEST_UNAVAILABLE,
}) {
  const [step, setStep] = React.useState("start");
  const [name, setName] = React.useState(() => readGuest()?.name || "");
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [unavailable, setUnavailable] = React.useState(false);
  const action = useAction();
  const headingId = React.useId();

  if (available === false) {
    return h("section", { "aria-labelledby": headingId, className: "market-guest-gate", "data-market-guest-gate": "unavailable" }, [
      h("h3", { className: "market-subhead", id: headingId, key: "title" }, unavailableTitle),
      h(Note, { key: "note", tone: "error" }, unavailableText),
      h("div", { className: "market-actions", key: "actions" }, [
        h("a", { className: "shop-btn", href: "gvdg-members.html", key: "sign-in" }, "Members sign in"),
        onCancel ? h("button", { className: "shop-filter-reset", key: "cancel", onClick: onCancel, type: "button" }, "Not now") : null,
      ]),
    ]);
  }

  async function start(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 40 || /@|:\/\//.test(trimmed)) {
      action.setMessage({ text: "Enter a display name of 2–40 characters (no email or links).", tone: "error" });
      return;
    }
    if (!validEmail(email)) {
      action.setMessage({ text: "Enter a valid email address.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, status, data } = await marketRequest(startPath, { body: { email: email.trim(), name: trimmed }, method: "POST" });
      if (ok) {
        setStep("code");
        action.setMessage({ text: "We emailed you a 6-digit code. It expires in 10 minutes.", tone: "success" });
      } else if (status === 503 || data.error === "guest_unavailable") {
        setUnavailable(true);
        action.setMessage({ text: unavailableText, tone: "error" });
      } else {
        action.setMessage({ text: data.error === "invalid_name" ? "Choose a different display name." : data.error === "invalid_email"
          ? "Enter a valid email address." : errorMessage(data), tone: "error" });
      }
    });
  }

  async function verify(event) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      action.setMessage({ text: "Enter the 6-digit code from the email.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, data } = await marketRequest(verifyPath, { body: { code: code.trim(), email: email.trim() }, method: "POST" });
      if (ok && typeof data.token === "string") {
        writeGuest({ token: data.token, key: data.guest?.key || "", name: data.guest?.name || name.trim() });
        action.setMessage({ text: "You're verified.", tone: "success" });
        onVerified?.();
      } else {
        action.setMessage({ text: errorMessage(data, "That code didn't work. Try again."), tone: "error" });
      }
    });
  }

  return h("section", { "aria-labelledby": headingId, className: "market-guest-gate", "data-market-guest-gate": step }, [
    h("h3", { className: "market-subhead", id: headingId, key: "title" }, title),
    h(Note, { key: "why" }, intro),
    step === "start"
      ? h("form", { className: "market-form", key: "start", noValidate: true, onSubmit: start }, [
        h("label", { key: "name" }, ["Display name", h("input", {
          autoComplete: "nickname", key: "input", maxLength: 40, onChange: (event) => setName(event.target.value), required: true, type: "text", value: name,
        })]),
        h("label", { key: "email" }, ["Email (never shown)", h("input", {
          autoComplete: "email", inputMode: "email", key: "input", maxLength: 120, onChange: (event) => setEmail(event.target.value), required: true, type: "email", value: email,
        })]),
        h("button", { className: "shop-btn", disabled: action.busy || unavailable, key: "submit", type: "submit" }, action.busy ? "Sending…" : "Email me a code"),
      ])
      : h("form", { className: "market-form", key: "code", noValidate: true, onSubmit: verify }, [
        h("label", { key: "code" }, ["6-digit code", h("input", {
          autoComplete: "one-time-code", inputMode: "numeric", key: "input", maxLength: 6, onChange: (event) => setCode(event.target.value.replace(/\D/g, "")),
          pattern: "\\d{6}", required: true, type: "text", value: code,
        })]),
        h("button", { className: "shop-btn", disabled: action.busy, key: "submit", type: "submit" }, action.busy ? "Checking…" : "Verify code"),
        h("button", { className: "shop-filter-reset", key: "restart", onClick: () => { setStep("start"); setCode(""); action.setMessage(null); }, type: "button" }, "Use a different email"),
      ]),
    h(StatusLine, { key: "status", message: action.message }),
    h("div", { className: "market-actions", key: "actions" }, [
      h("a", { className: "market-link", href: "gvdg-members.html", key: "members" }, "Members can sign in"),
      onCancel ? h("button", { className: "shop-filter-reset", key: "cancel", onClick: onCancel, type: "button" }, "Not now") : null,
    ]),
  ]);
}

/** Wrap an action that needs a member or a verified guest: public viewers get the guest gate first.
 *  `gateOptions` (Lost & Found) swaps in that surface's endpoints and wording. */
export function useIdentityGate(viewer, gateOptions = null) {
  const [pending, setPending] = React.useState(null);
  const pendingRef = React.useRef(null);
  const require = React.useCallback((label, job) => {
    if (viewer?.kind === "member" || viewer?.kind === "guest" || readGuest()) return job();
    pendingRef.current = job;
    setPending(label || "Verify your email to continue");
    return null;
  }, [viewer?.kind]);
  const gate = pending ? h(gateOptions ? GuestGateView : GuestGate, {
    ...(gateOptions || {}),
    key: "gate",
    onCancel: () => { pendingRef.current = null; setPending(null); },
    onVerified: () => {
      const job = pendingRef.current;
      pendingRef.current = null;
      setPending(null);
      if (job) void job();
    },
    title: pending,
  }) : null;
  return { gate, require };
}

/** Club members and admins list discs; the Guest tier buys, trades and posts WANTED. */
export function canList(viewer) {
  return viewer?.kind === "member" && viewer.canList !== false;
}

export const GUEST_TIER_NOTE = "Guest accounts can buy, propose trades and post WANTED. Listing discs is for club members: ask a club admin about membership.";

export function IdentityStrip({ viewer }) {
  if (viewer?.kind === "member") {
    return h("p", { className: "market-identity", "data-market-identity": "member" }, ["Signed in as ", h("strong", { key: "name" }, viewer.name || "Member")]);
  }
  if (viewer?.kind === "guest") {
    return h("p", { className: "market-identity", "data-market-identity": "guest" }, [
      "Buying as ", h("strong", { key: "name" }, viewer.name || readGuest()?.name || "Guest"), " ", h(GuestBadge, { key: "badge" }), " ",
      h("button", { className: "market-text-btn", key: "out", onClick: clearGuest, type: "button" }, "Not you?"),
    ]);
  }
  return null;
}

// ---- Reporting ----

export function ReportControl({ kind, id, viewer, label = "Report" }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [details, setDetails] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const action = useAction();
  const identity = useIdentityGate(viewer);
  const fieldId = React.useId();

  async function send() {
    if (!reason) {
      action.setMessage({ text: "Choose a reason.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, data } = await marketRequest("/market/reports", { body: { details: details.trim(), id, kind, reason }, method: "POST" });
      if (ok) {
        setSent(true);
        action.setMessage({ text: "Thanks. A club admin will take a look.", tone: "success" });
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  const sendRef = React.useRef(send);
  sendRef.current = send;

  if (sent) return h(StatusLine, { message: action.message });
  if (!open) {
    return h("button", { className: "market-text-btn market-report-toggle", onClick: () => setOpen(true), type: "button" }, label);
  }
  return h("div", { className: "market-report", "data-market-report": kind }, [
    h("form", {
      className: "market-form", key: "form", noValidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        if (!reason) {
          action.setMessage({ text: "Choose a reason.", tone: "error" });
          document.getElementById(fieldId + "-reason")?.focus();
          return;
        }
        identity.require("Verify your email to send a report", () => sendRef.current());
      },
    }, [
      h("label", { htmlFor: fieldId + "-reason", key: "reason-label" }, "Why are you reporting this?"),
      h("select", { id: fieldId + "-reason", key: "reason", onChange: (event) => setReason(event.target.value), value: reason }, [
        h("option", { key: "none", value: "" }, "Choose a reason"),
        ...REPORT_REASONS.map(([value, text]) => h("option", { key: value, value }, text)),
      ]),
      h("label", { key: "details" }, ["Anything else (optional)", h("textarea", {
        key: "input", maxLength: 300, onChange: (event) => setDetails(event.target.value), rows: 2, value: details,
      })]),
      h("div", { className: "market-actions", key: "actions" }, [
        h("button", { className: "shop-btn secondary", disabled: action.busy, key: "send", type: "submit" }, action.busy ? "Sending…" : "Send report"),
        h("button", { className: "shop-filter-reset", key: "cancel", onClick: () => setOpen(false), type: "button" }, "Cancel"),
      ]),
    ]),
    identity.gate,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function LoadState({ state, onRetry, loading = "Loading…" }) {
  if (state === "loading") return h("p", { className: "public-state", role: "status" }, loading);
  if (state === "error") {
    return h("div", { className: "public-state", role: "status" }, [
      h("p", { key: "message" }, "This couldn't load."),
      onRetry ? h("button", { className: "shop-filter-reset", key: "retry", onClick: onRetry, type: "button" }, "Try again") : null,
    ]);
  }
  return null;
}
