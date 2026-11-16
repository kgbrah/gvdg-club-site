import React from "react";
import { BellRing, CheckCircle2 } from "lucide-react";

import { request } from "./api.js";
import { dollars } from "./format.js";
import { loadPaypalSdk } from "./registration-payments.js";

const h = React.createElement;

function keyBytes(base64) {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function duesPath(info, step) {
  return `/membership/apply/${encodeURIComponent(info.id)}/dues/${step}`;
}

async function post(path, body) {
  const response = await request(path, { method: "POST", body });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function DuesButtons({ info, onPaid, onError }) {
  const hostRef = React.useRef(null);
  const infoRef = React.useRef(info);
  const [fallback, setFallback] = React.useState("");
  const clientId = info.paypalClientId;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !clientId) return undefined;
    let active = true;
    loadPaypalSdk({ clientId })
      .then(() => {
        if (!active || !window.paypal) return;
        window.paypal.Buttons({
          style: { layout: "vertical", height: 40 },
          createOrder: async () => {
            const { ok, data } = await post(duesPath(infoRef.current, "create-order"), { payToken: infoRef.current.payToken });
            if (!ok || !data.orderId) {
              onError(data.error === "already_paid" ? "Your dues are already paid." : "We couldn't start the payment. You can choose the other option below.");
              throw new Error(data.error || "create_order_failed");
            }
            return data.orderId;
          },
          onApprove: async (order) => {
            const { ok, data } = await post(duesPath(infoRef.current, "capture"), { payToken: infoRef.current.payToken, orderId: order.orderID });
            if (ok) onPaid();
            else onError(data.error === "payment_incomplete"
              ? "PayPal hasn't confirmed that payment yet. Please contact the club."
              : "We could not confirm your payment. Please contact the club.");
          },
          onError: () => onError("Payment could not be completed. You can try again or choose the other option below."),
        }).render(host);
      })
      .catch(() => setFallback("Online payment is temporarily unavailable. Choose the other option below."));
    return () => {
      active = false;
    };
  }, [clientId, onPaid, onError]);

  return h("div", { className: "paypal-buttons", "data-react-apply-paypal": "ready" }, [
    fallback ? h("div", { className: "form-hint", role: "status", key: "fallback" }, fallback) : null,
    h("div", { "data-paypal-button-host": "true", ref: hostRef, key: "host" }),
  ]);
}

function pushInitial(info) {
  if (!info.pushPublicKey) return "none";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return "none";
  return Notification.permission === "denied" ? "none" : "off";
}

export function ApplySubmitted({ active, info }) {
  const [dues, setDues] = React.useState("due"); // due | paid | other
  const [message, setMessage] = React.useState("");
  const [pushState, setPushState] = React.useState(() => pushInitial(info));
  const [busy, setBusy] = React.useState(false);
  const onPaid = React.useCallback(() => { setMessage(""); setDues("paid"); }, []);
  const onError = React.useCallback((text) => setMessage(text), []);

  async function payAnotherWay() {
    setBusy(true);
    const { ok } = await post(duesPath(info, "other"), { payToken: info.payToken }).catch(() => ({ ok: false }));
    setBusy(false);
    if (ok) { setMessage(""); setDues("other"); }
    else setMessage("Could not save that. Please try again.");
  }

  async function turnOnPush() {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setPushState("none"); return; }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(info.pushPublicKey),
      });
      const json = subscription.toJSON();
      const { ok } = await post(`/membership/apply/${encodeURIComponent(info.id)}/push`, { payToken: info.payToken, endpoint: json.endpoint, keys: json.keys });
      setPushState(ok ? "on" : "off");
    } catch {
      setPushState("off");
    } finally {
      setBusy(false);
    }
  }

  const cents = info.duesCents || 1500;
  return h("div", { className: "login-form apply-submitted", id: "applySubmitted", style: { display: active ? "grid" : "none", gap: "0.85rem" }, hidden: !active, "data-react-apply-submitted": "ready" }, [
    h("p", { className: "login-subtitle", key: "copy" }, "Application sent. An admin will review it and approve you. Log in with the PIN you just chose once you are approved."),
    info.duesOnline ? h("div", { className: "form-group", style: { display: "grid", gap: "0.65rem" }, "data-react-apply-dues": dues, key: "dues" }, [
      h("h2", { className: "form-label", key: "title" }, `Pay ${dollars(cents)} dues`),
      dues === "paid"
        ? h("p", { className: "form-hint", role: "status", key: "paid" }, [h(CheckCircle2, { size: 16, "aria-hidden": true, key: "icon" }), ` Dues paid - thank you! We'll let the admins know.`])
        : dues === "other"
          ? h("p", { className: "form-hint", role: "status", key: "other" }, "Got it. An admin will confirm your payment when they review your application.")
          : [
            h("p", { className: "form-hint", key: "hint" }, "Pay your annual club dues online with PayPal. You can also pay another way and an admin will confirm it."),
            h(DuesButtons, { info, onPaid, onError, key: "buttons" }),
            h("button", { type: "button", className: "login-btn login-btn-secondary", disabled: busy, onClick: payAnotherWay, key: "other" }, "I already paid / paying another way"),
          ],
      message ? h("div", { className: "login-error show", role: "alert", key: "message" }, `Error: ${message}`) : null,
    ]) : null,
    pushState !== "none" ? h("div", { className: "form-group", key: "push" }, pushState === "on"
      ? h("p", { className: "form-hint", role: "status" }, [h(BellRing, { size: 16, "aria-hidden": true, key: "icon" }), " We'll send a notification on this device when you're approved."])
      : h("button", { type: "button", className: "login-btn login-btn-secondary", disabled: busy, onClick: turnOnPush, "data-react-apply-push": "off" }, "Notify me when I'm approved")) : null,
    h("button", { type: "button", className: "login-btn", key: "done", onClick: () => window.dispatchEvent(new CustomEvent("gvdg:member-apply-finish")) }, "Continue to log in"),
  ]);
}
