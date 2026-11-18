// Shared pieces for Lost & Found (lazy chunk). Requests reuse the marketplace's credential handling, so a member
// session or the club's verified-guest token (one identity for both surfaces) is sent automatically.
import React from "react";
import { Disc3, ShieldCheck } from "lucide-react";

import { karmaLabel, LF_REPORT_REASONS, lfErrorMessage, personHref } from "../shared/lost-found-model.js";
import { IDENTITY_EVENT, marketBase, marketRequest } from "./market-api.js";
import { GuestBadge, Note, StatusLine, useAction, useIdentityGate } from "./market-ui.js";

const h = React.createElement;
const EMPTY_VIEWER = { kind: "public", key: null, name: null, isAdmin: false };

export const lfRequest = marketRequest;

export function announceLfChange() {
  window.dispatchEvent(new CustomEvent("gvdg:lf-changed"));
}

/** Only "/lost-found/photos/<id>" (always a redacted copy) becomes an image URL. */
export function lfPhotoSrc(photo) {
  const path = typeof photo === "string" ? photo : photo?.url;
  return typeof path === "string" && /^\/lost-found\/photos\/\d{1,12}$/.test(path) ? marketBase() + path : "";
}

// ---- One /lost-found/config read per identity ----

let configState = { status: "loading", guestVerify: false, viewer: EMPTY_VIEWER };
let configPending = null;
const listeners = new Set();

export function reloadLfConfig() {
  const request = lfRequest("/lost-found/config").then(({ ok, data }) => {
    if (configPending !== request) return;
    configPending = null;
    const viewer = data.viewer && typeof data.viewer === "object" ? { ...EMPTY_VIEWER, ...data.viewer } : EMPTY_VIEWER;
    configState = ok ? { status: "ready", guestVerify: data.guestVerify === true, viewer } : { status: "error", guestVerify: false, viewer };
    listeners.forEach((listener) => listener(configState));
  });
  configPending = request;
  return request;
}

if (typeof window !== "undefined") window.addEventListener(IDENTITY_EVENT, () => { void reloadLfConfig(); });

export function useLfConfig() {
  const [state, setState] = React.useState(configState);
  React.useEffect(() => {
    listeners.add(setState);
    setState(configState);
    if (configState.status === "loading" && !configPending) void reloadLfConfig();
    return () => listeners.delete(setState);
  }, []);
  return state;
}

export function useLfVersion() {
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    window.addEventListener(IDENTITY_EVENT, bump);
    window.addEventListener("gvdg:lf-changed", bump);
    return () => {
      window.removeEventListener(IDENTITY_EVENT, bump);
      window.removeEventListener("gvdg:lf-changed", bump);
    };
  }, []);
  return version;
}

/** The marketplace's guest gate, pointed at Lost & Found's endpoints and wording (same identity). */
export function useLfIdentityGate(viewer) {
  const config = useLfConfig();
  return useIdentityGate(viewer, {
    available: config.status === "ready" ? config.guestVerify : null,
    startPath: "/lost-found/guest/start",
    verifyPath: "/lost-found/guest/verify",
    intro: "Not a club member? Verify your email to post or claim a disc. Your email is never shown; people see only your display name.",
    unavailableTitle: "Email check",
    unavailableText: "Email checks are unavailable right now. Members can sign in.",
  });
}

/** GET a Lost & Found resource and re-run on identity or data changes. */
export function useLfResource(path) {
  const [state, setState] = React.useState({ status: "loading", data: null, code: 0 });
  const [attempt, setAttempt] = React.useState(0);
  const version = useLfVersion();
  React.useEffect(() => {
    if (!path) return undefined;
    const controller = new AbortController();
    lfRequest(path, { signal: controller.signal }).then(({ ok, status, data }) => {
      setState(ok ? { status: "ready", data, code: status } : { status: "error", data, code: status });
    }).catch(() => {});
    return () => controller.abort();
  }, [path, attempt, version]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}

export function LfPhoto({ photo, alt, className = "product-img", pending = false }) {
  const src = lfPhotoSrc(photo);
  const [failed, setFailed] = React.useState("");
  if (src && failed !== src) return h("img", { alt: alt || "", className, loading: "lazy", onError: () => setFailed(src), src });
  return h("div", { "aria-hidden": pending ? undefined : "true", className: "product-fallback lf-photo-fallback" + (pending ? " is-pending" : ""), role: pending ? "img" : undefined,
    "aria-label": pending ? "Photo being checked" : undefined }, [
    h(Disc3, { key: "icon", size: 44, strokeWidth: 1.45 }),
    pending ? h("span", { className: "lf-photo-pending", key: "text" }, "Photo being checked") : null,
  ]);
}

export function KarmaBadge({ person }) {
  const label = karmaLabel(person);
  return label ? h("span", { className: "market-badge lf-karma", "data-lf-karma": person.karma }, label) : null;
}

export function PersonLine({ person, prefix = "", link = true }) {
  if (!person) return null;
  return h("span", { className: "market-trader lf-person" }, [
    prefix ? h("span", { className: "market-feedback", key: "prefix" }, prefix) : null,
    link && person.key
      ? h("a", { className: "market-trader-name", href: personHref(person.key), key: "name" }, person.name || "Someone")
      : h("strong", { className: "market-trader-name", key: "name" }, person.name || "Someone"),
    person.kind === "guest" ? h(GuestBadge, { key: "guest" }) : null,
    h(KarmaBadge, { key: "karma", person }),
  ]);
}

export function PrivacyNote({ children }) {
  return h("p", { className: "market-safety lf-privacy", "data-lf-privacy": "true" }, [
    h(ShieldCheck, { "aria-hidden": true, className: "lf-privacy-icon", key: "icon", size: 18 }),
    h("span", { key: "text" }, children),
  ]);
}

export function LfReportControl({ kind, id, viewer, label = "Report" }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [details, setDetails] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const action = useAction();
  const identity = useLfIdentityGate(viewer);
  const fieldId = React.useId();

  async function send() {
    if (!reason) {
      action.setMessage({ text: "Choose a reason.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, data } = await lfRequest("/lost-found/reports", { body: { details: details.trim(), id, kind, reason }, method: "POST" });
      if (ok) {
        setSent(true);
        action.setMessage({ text: "Thanks. A club admin will take a look.", tone: "success" });
      } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }

  if (sent) return h(StatusLine, { message: action.message });
  if (!open) return h("button", { className: "market-text-btn market-report-toggle", onClick: () => setOpen(true), type: "button" }, label);
  return h("div", { className: "market-report", "data-lf-report": kind }, [
    h("form", {
      className: "market-form", key: "form", noValidate: true,
      onSubmit: (event) => { event.preventDefault(); identity.require("Verify your email to send a report", send); },
    }, [
      h("label", { htmlFor: fieldId + "-reason", key: "reason-label" }, "Why are you reporting this?"),
      h("select", { id: fieldId + "-reason", key: "reason", onChange: (event) => setReason(event.target.value), value: reason }, [
        h("option", { key: "none", value: "" }, "Choose a reason"),
        ...LF_REPORT_REASONS.map(([value, text]) => h("option", { key: value, value }, text)),
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

export function LfLoad({ state, onRetry, loading = "Loading…", missing = "That's no longer available." }) {
  if (state.status === "loading") return h("p", { className: "public-state", role: "status" }, loading);
  if (state.status === "error") {
    return h("div", { className: "public-state", role: "status" }, [
      h("p", { key: "message" }, state.code === 404 ? missing : "This couldn't load."),
      state.code !== 404 && onRetry ? h("button", { className: "shop-filter-reset", key: "retry", onClick: onRetry, type: "button" }, "Try again") : null,
    ]);
  }
  return null;
}

export function SignInPrompt({ viewer, text }) {
  const identity = useLfIdentityGate(viewer);
  return h("section", { className: "market-panel", "data-lf-signin": "true" }, [
    h(Note, { key: "note" }, text),
    h("div", { className: "market-actions", key: "actions" }, [
      h("a", { className: "shop-btn", href: "gvdg-members.html", key: "members" }, "Members sign in"),
      h("button", { className: "shop-btn secondary", key: "guest", onClick: () => identity.require("Verify your email", () => announceLfChange()), type: "button" },
        "Verify my email"),
    ]),
    identity.gate,
  ]);
}
