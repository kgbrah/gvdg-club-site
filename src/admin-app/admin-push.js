import React from "react";

import { adminJson, adminRequest } from "./admin-api.js";
import { currentAdminAuthGateState } from "./admin-shell-state.js";

const h = React.createElement;

function keyBytes(base64) {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function remember(subscription) {
  const json = subscription.toJSON();
  await adminRequest("/admin/push", {
    method: "POST",
    body: { endpoint: json.endpoint, keys: json.keys },
  });
}

export function AdminPushCard() {
  const [state, setState] = React.useState("loading");
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (currentAdminAuthGateState().status !== "panel") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
      setState("unsupported");
      return;
    }
    try {
      const info = await adminJson("/admin/push");
      if (!info.configured || !info.publicKey) {
        setState("unconfigured");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        remember(subscription).catch(() => {});
        setState("on");
        return;
      }
      setState("off");
    } catch {
      setState("off");
    }
  }, []);

  React.useEffect(() => {
    function maybe() { refresh(); }
    window.addEventListener("gvdg:admin-auth-gate", maybe);
    refresh();
    return () => window.removeEventListener("gvdg:admin-auth-gate", maybe);
  }, [refresh]);

  async function turnOn() {
    setBusy(true);
    try {
      const info = await adminJson("/admin/push");
      if (!info.configured || !info.publicKey) {
        setState("unconfigured");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(info.publicKey),
      });
      const response = await adminRequest("/admin/push", {
        method: "POST",
        body: { endpoint: subscription.endpoint, keys: subscription.toJSON().keys },
      });
      if (!response.ok) throw new Error("subscribe failed");
      setState("on");
    } catch {
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await adminRequest("/admin/push", { method: "DELETE", body: { endpoint } });
      }
      setState("off");
    } catch {
      setState("on");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return null;

  const note = state === "on"
    ? "Alerts are on for this phone."
    : state === "denied"
      ? "Notifications are blocked for this site. Allow them in the browser, then come back."
      : state === "unconfigured"
        ? "Alerts are not turned on for the club yet."
        : state === "unsupported"
          ? "This browser cannot show admin alerts."
          : "This phone can ping you when a tag, order, application, or tee sign is waiting.";

  return h("div", { className: "admin-today-card", "data-admin-push": state }, [
    h("div", { className: "ev-name", key: "title" }, "Alerts"),
    h("p", { className: "admin-event-meta", key: "note" }, note),
    state === "off" ? h("button", {
      className: "admin-btn",
      disabled: busy,
      key: "on",
      onClick: turnOn,
      type: "button",
    }, "Turn on alerts") : null,
    state === "on" ? h("button", {
      className: "admin-btn secondary",
      disabled: busy,
      key: "off",
      onClick: turnOff,
      type: "button",
    }, "Turn off alerts") : null,
  ]);
}
