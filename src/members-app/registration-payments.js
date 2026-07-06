import React from "react";

import { request } from "./api.js";

const h = React.createElement;
let paypalSdkPromise = null;

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

export function PayPalButtons({ eventId, token, paymentsConfig, onReload }) {
  const hostRef = React.useRef(null);
  const [fallback, setFallback] = React.useState("");

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !paymentsConfig?.enabled) return undefined;
    let active = true;
    host.replaceChildren();
    loadPaypalSdk(paymentsConfig)
      .then(() => {
        if (!active || !window.paypal) return;
        window.paypal.Buttons({
          style: { layout: "horizontal", height: 36 },
          createOrder: async () => {
            const response = await request(`/events/${encodeURIComponent(eventId)}/pay/create-order`, { method: "POST", token });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.orderId) {
              const message = data.error === "already_paid"
                ? "You're already paid for this event."
                : data.error === "nothing_owed"
                  ? "There's nothing left to pay."
                  : "We couldn't start the payment. Please try again or pay at the event.";
              window.alert(message);
              throw new Error(data.error || "create_order_failed");
            }
            return data.orderId;
          },
          onApprove: (data) => request(`/events/${encodeURIComponent(eventId)}/pay/capture`, {
            method: "POST",
            token,
            body: { orderId: data.orderID },
          }).then((response) => {
            if (response.ok) onReload();
            else window.alert("We could not confirm your payment. Please contact the club.");
          }),
          onError: () => window.alert("Payment could not be completed. Please try again, or pay at the event."),
        }).render(host);
      })
      .catch(() => setFallback("Online payment is temporarily unavailable - pay at the event."));
    return () => {
      active = false;
      host.replaceChildren();
    };
  }, [eventId, onReload, paymentsConfig, token]);

  return h("div", { className: "paypal-buttons", ref: hostRef }, fallback);
}
