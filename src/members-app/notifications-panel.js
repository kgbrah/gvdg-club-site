import React from "react";
import { Bell, Mail, Tag } from "lucide-react";

import { TOKEN_KEY, request, storageGet } from "./api.js";

const h = React.createElement;

function keyBytes(base64) {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function supported() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

async function api(token, path, method, body) {
  const response = await request(path, { token, method, body });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function Switch({ on, busy, label, detail, icon: Icon, onToggle, id }) {
  const descriptionId = React.useId();
  return h("button", {
    className: "member-link-row member-switch-row", type: "button", role: "switch", "aria-checked": on ? "true" : "false",
    "aria-label": label, "aria-describedby": detail ? descriptionId : undefined, disabled: busy, onClick: onToggle, "data-member-switch": id,
  }, [
    h(Icon, { className: "member-link-icon", size: 19, "aria-hidden": true, key: "icon" }),
    h("span", { className: "member-link-copy", key: "copy" }, [
      h("strong", { key: "title" }, label),
      detail ? h("small", { id: descriptionId, key: "detail" }, detail) : null,
    ]),
    h("span", { className: "member-switch" + (on ? " is-on" : ""), "aria-hidden": true, key: "switch" }, h("span", { className: "member-switch-knob" })),
  ]);
}

/** Account > Notifications: opt this device in to push, then pick categories. */
export function MemberNotificationsPanel() {
  const token = storageGet(TOKEN_KEY);
  // loading | unsupported | unconfigured | denied | off | on
  const [state, setState] = React.useState("loading");
  const [bagTags, setBagTags] = React.useState(true);
  const [messages, setMessages] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const publicKey = React.useRef(null);

  const refresh = React.useCallback(async () => {
    if (!token) return;
    if (!supported()) { setState("unsupported"); return; }
    try {
      const info = await api(token, "/me/push-subscription", "GET");
      if (!info.ok) { setState("off"); return; }
      if (!info.data.configured || !info.data.publicKey) { setState("unconfigured"); return; }
      publicKey.current = info.data.publicKey;
      setBagTags(info.data.prefs?.bagTags !== false);
      setMessages(info.data.prefs?.messages !== false);
      if (typeof Notification !== "undefined" && Notification.permission === "denied") { setState("denied"); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription && Notification.permission === "granted") {
        const json = subscription.toJSON();
        // Re-register quietly: another sign-in on this phone may have swapped the subscription.
        api(token, "/me/push-subscription", "PUT", { endpoint: json.endpoint, keys: json.keys }).catch(() => {});
        setState("on");
        return;
      }
      setState("off");
    } catch {
      setState("off");
    }
  }, [token]);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function turnOn() {
    setBusy(true);
    setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState(permission === "denied" ? "denied" : "off"); return; }
      const registration = await navigator.serviceWorker.ready;
      // Reuse an existing subscription (the admin alerts share it); only subscribe when there is none.
      const subscription = (await registration.pushManager.getSubscription())
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey.current) });
      const json = subscription.toJSON();
      const saved = await api(token, "/me/push-subscription", "PUT", { endpoint: json.endpoint, keys: json.keys, prefs: { bagTags, messages } });
      if (!saved.ok) throw new Error("subscribe failed");
      setBagTags(saved.data.prefs?.bagTags !== false);
      setMessages(saved.data.prefs?.messages !== false);
      setState("on");
    } catch {
      setMessage("Could not turn notifications on. Try again.");
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const removed = await api(token, "/me/push-subscription", "DELETE", { endpoint: subscription.endpoint });
        if (!removed.ok) throw new Error("unsubscribe failed");
      }
      setState("off");
    } catch {
      setMessage("Could not turn notifications off. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePref(id, current, setCurrent) {
    const next = !current;
    setCurrent(next);
    setBusy(true);
    setMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const json = subscription && subscription.toJSON();
      if (!json?.endpoint) throw new Error("missing subscription");
      const saved = await api(token, "/me/push-subscription", "PUT", {
        endpoint: json.endpoint,
        keys: json.keys,
        prefs: { [id]: next },
      });
      if (!saved.ok) throw new Error("save failed");
    } catch {
      setCurrent(!next);
      setMessage("Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!token || state === "loading") return null;

  const detail = state === "on" ? "On for this phone"
    : state === "denied" ? "Blocked in your browser settings. Allow notifications for this site, then come back."
      : state === "unsupported" ? "This browser cannot show notifications. Install the app to your home screen."
        : state === "unconfigured" ? "Not turned on for the club yet."
          : "Get a ping for messages and bag tag updates";

  return h("div", { className: "member-notifications", "data-member-notifications": state }, [
    h(Switch, {
      key: "master", id: "notifications", icon: Bell, label: "Notifications", detail, on: state === "on",
      busy: busy || !["on", "off"].includes(state), onToggle: state === "on" ? turnOff : turnOn,
    }),
    state === "on" ? h(Switch, {
      key: "messages", id: "messages", icon: Mail, label: "Messages", detail: "A ping when a member writes you",
      on: messages, busy, onToggle: () => togglePref("messages", messages, setMessages),
    }) : null,
    state === "on" ? h(Switch, {
      key: "bag-tags", id: "bag-tags", icon: Tag, label: "Bag tag challenges", detail: "Challenges, results and ladder resets",
      on: bagTags, busy, onToggle: () => togglePref("bagTags", bagTags, setBagTags),
    }) : null,
    message ? h("p", { className: "player-card-meta member-notifications-note", role: "status", key: "message" }, message) : null,
  ]);
}
