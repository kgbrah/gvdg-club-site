import React from "react";

import { request, requestJson } from "./api.js";
import { dollars } from "./format.js";
import { memberAlert, memberConfirm } from "./member-dialogs.js";

const h = React.createElement;
let paypalSdkPromise = null;

function useLatest(value) {
  const ref = React.useRef(value);
  React.useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function loadPaypalSdk(config) {
  if (window.paypal) return Promise.resolve();
  if (paypalSdkPromise) return paypalSdkPromise;
  paypalSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=USD&intent=capture`;
    script.onload = resolve;
    script.onerror = () => reject(new Error("paypal_sdk_load_failed"));
    document.head.appendChild(script);
  });
  return paypalSdkPromise;
}

export function announceWalletUpdated() {
  window.dispatchEvent(new CustomEvent("gvdg:wallet-updated"));
}

export async function payEventWithWallet(eventId, token) {
  const response = await request(`/events/${encodeURIComponent(eventId)}/pay/wallet`, {
    method: "POST",
    token,
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

export function walletPayErrorMessage(error) {
  if (error === "already_paid") return "You're already paid for this event.";
  if (error === "nothing_owed") return "There's nothing left to pay.";
  if (error === "insufficient_store_credit") return "Not enough store credit for this entry.";
  if (error === "capture_in_progress") return "Another payment is already in progress. Try again in a moment.";
  if (error === "not_registered") return "Register for the event before paying.";
  return "We couldn't take store credit for this event. Try again or pay at the event.";
}

export function WalletPayButton({ eventId, eventName, owed, token, onReload }) {
  const [wallet, setWallet] = React.useState({ status: "idle", balanceCents: 0 });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!token) {
      setWallet({ status: "idle", balanceCents: 0 });
      return undefined;
    }
    const controller = new AbortController();
    setWallet((current) => ({ ...current, status: "loading" }));
    requestJson("/shop/wallet", { token, signal: controller.signal })
      .then((payload) => setWallet({ status: "ready", balanceCents: Number(payload.balance_cents || 0) }))
      .catch((error) => {
        if (error.name !== "AbortError") setWallet({ status: "ready", balanceCents: 0 });
      });
    return () => controller.abort();
  }, [token]);

  if (!token || owed <= 0) return null;
  const balance = wallet.balanceCents;
  const covers = wallet.status === "ready" && balance >= owed;

  async function pay() {
    const confirmed = await memberConfirm({
      confirmText: "Pay",
      message: `Pay ${dollars(owed)} from store credit${eventName ? ` for ${eventName}` : ""}?`,
      title: "Pay with store credit?",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await payEventWithWallet(eventId, token);
      if (!result.ok) {
        await memberAlert({
          message: walletPayErrorMessage(result.data.error),
          title: "Store credit payment failed",
        });
        return;
      }
      announceWalletUpdated();
      onReload?.();
    } finally {
      setBusy(false);
    }
  }

  return h("div", {
    className: "register-wallet-pay",
    "data-react-wallet-pay": busy ? "busy" : covers ? "due" : wallet.status === "ready" ? "short" : wallet.status,
  }, [
    wallet.status === "loading"
      ? h("p", { className: "register-fee", key: "loading" }, "Checking store credit...")
      : covers
        ? h("button", {
          type: "button",
          className: "player-btn primary",
          disabled: busy,
          key: "pay",
          onClick: pay,
        }, busy ? "Paying..." : `Pay ${dollars(owed)} with store credit`)
        : h("p", { className: "register-fee", key: "short" },
          `Store credit ${dollars(balance)} — need ${dollars(Math.max(0, owed - balance))} more to pay from the wallet.`),
  ]);
}

export function PayPalButtons({ eventId, token, paymentsConfig, onReload }) {
  const hostRef = React.useRef(null);
  const eventIdRef = useLatest(eventId);
  const onReloadRef = useLatest(onReload);
  const tokenRef = useLatest(token);
  const [fallback, setFallback] = React.useState("");
  const hostKey = `${paymentsConfig?.clientId || "paypal-disabled"}:${eventId || "event"}`;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !paymentsConfig?.enabled) return undefined;
    let active = true;
    setFallback("");
    loadPaypalSdk(paymentsConfig)
      .then(() => {
        if (!active || !window.paypal) return;
        window.paypal.Buttons({
          style: { layout: "horizontal", height: 36 },
          createOrder: async () => {
            const response = await request(`/events/${encodeURIComponent(eventIdRef.current)}/pay/create-order`, {
              method: "POST",
              token: tokenRef.current,
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.orderId) {
              const message = data.error === "already_paid"
                ? "You're already paid for this event."
                : data.error === "nothing_owed"
                  ? "There's nothing left to pay."
                  : "We couldn't start the payment. Please try again or pay at the event.";
              await memberAlert({ message, title: "Payment could not start" });
              throw new Error(data.error || "create_order_failed");
            }
            return data.orderId;
          },
          onApprove: (data) => request(`/events/${encodeURIComponent(eventIdRef.current)}/pay/capture`, {
            method: "POST",
            token: tokenRef.current,
            body: { orderId: data.orderID },
          }).then((response) => {
            if (response.ok) onReloadRef.current();
            else void memberAlert({
              message: "We could not confirm your payment. Please contact the club.",
              title: "Payment confirmation failed",
            });
          }),
          onError: () => void memberAlert({
            message: "Payment could not be completed. Please try again, or pay at the event.",
            title: "Payment failed",
          }),
        }).render(host);
      })
      .catch(() => setFallback("Online payment is temporarily unavailable - pay at the event."));
    return () => {
      active = false;
    };
  }, [hostKey, paymentsConfig?.clientId, paymentsConfig?.enabled]);

  return h("div", { className: "paypal-buttons" }, [
    fallback ? h("div", { className: "register-fee", key: "fallback", role: "status" }, fallback) : null,
    paymentsConfig?.enabled
      ? h("div", { "data-paypal-button-host": "true", key: hostKey, ref: hostRef })
      : null,
  ]);
}
