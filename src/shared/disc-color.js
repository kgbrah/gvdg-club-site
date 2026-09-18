import React from "react";

import { resolveApiBase } from "./api-base.js";
import { PDGA_KEY, TOKEN_KEY, readMemberSessionValue, readMemberToken } from "./member-session.js";
import { SCORE_AUTH_EVENT, themeMemberIds } from "./player-theme-session.js";

export const DISC_COLOR_EVENT = "gvdg:disc-color";
export const DEFAULT_DISC_COLOR = "orange";

export const DISC_COLORS = [
  { id: "orange", label: "Orange", token: "--disc-orange" },
  { id: "blue", label: "Blue", token: "--disc-blue" },
  { id: "gold", label: "Gold", token: "--disc-gold" },
  { id: "forest", label: "Forest", token: "--disc-forest" },
  { id: "white", label: "White", token: "--disc-white" },
  { id: "ink", label: "Ink", token: "--disc-ink" },
  { id: "fire", label: "Fire", token: "--disc-fire" },
  { id: "pink", label: "Pink", token: "--disc-pink" },
  { id: "teal", label: "Teal", token: "--disc-teal" },
  { id: "purple", label: "Purple", token: "--disc-purple" },
];

const DISC_IDS = new Set(DISC_COLORS.map((row) => row.id));
const AUTH_EVENTS = [SCORE_AUTH_EVENT, "gvdg:member-dashboard-opened"];

export function sanitizeDiscColor(value) {
  const id = String(value || "").trim().toLowerCase();
  return DISC_IDS.has(id) ? id : DEFAULT_DISC_COLOR;
}

export function discColorToken(id) {
  const row = DISC_COLORS.find((item) => item.id === sanitizeDiscColor(id));
  return "var(" + (row ? row.token : "--disc-orange") + ")";
}

export function discColorStorageKey(memberId) {
  return "gvdg-disc-color:" + String(memberId || "me");
}

export function readStoredDiscColor(storage, memberId) {
  try {
    const raw = storage && storage.getItem(discColorStorageKey(memberId));
    return raw ? sanitizeDiscColor(raw) : null;
  } catch {
    return null;
  }
}

export function writeStoredDiscColor(storage, memberId, id) {
  try {
    if (!storage) return;
    const key = discColorStorageKey(memberId);
    if (!id) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, sanitizeDiscColor(id));
  } catch {
    // ignore quota
  }
}

export function applyDiscColor(id, root) {
  const color = sanitizeDiscColor(id);
  const token = discColorToken(color);
  const nodes = [root, typeof document !== "undefined" ? document.documentElement : null, typeof document !== "undefined" ? document.body : null];
  nodes.forEach((node) => {
    if (!node || !node.style) return;
    node.style.setProperty("--disc-plate", token);
    node.setAttribute("data-disc-color", color);
  });
  return color;
}

export function notifyDiscColorChanged(id) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(DISC_COLOR_EVENT, { detail: { discColor: sanitizeDiscColor(id) } }));
  } catch {
    // ignore
  }
}

export function loadLocalDiscColor({
  token,
  pdgaNo,
  storage = globalThis.localStorage,
  sessionStorage: sessions = globalThis.sessionStorage,
} = {}) {
  const sessionToken = token ?? readMemberToken({ persistent: storage, session: sessions });
  const sessionPdga = pdgaNo ?? readMemberSessionValue(PDGA_KEY, { persistent: storage, session: sessions });
  const ids = themeMemberIds({ token: sessionToken, pdgaNo: sessionPdga });
  const memberId = ids[0] || "me";
  for (const cacheId of ids) {
    const color = readStoredDiscColor(storage, cacheId);
    if (color) return { discColor: color, memberId, token: sessionToken || "" };
  }
  return { discColor: DEFAULT_DISC_COLOR, memberId, token: sessionToken || "" };
}

async function defaultRequest(path, { token, signal, method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(resolveApiBase() + path, {
    cache: "no-store",
    headers,
    method,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function fetchRemoteDiscColor({ token, signal, requestImpl } = {}) {
  if (!token) return undefined;
  const request = requestImpl || defaultRequest;
  const response = await request("/me/disc-color", { token, signal });
  if (!response?.ok) return undefined;
  const data = await response.json().catch(() => null);
  if (!data || !Object.prototype.hasOwnProperty.call(data, "discColor")) return undefined;
  if (!data.discColor) return undefined;
  return sanitizeDiscColor(data.discColor);
}

export async function persistDiscColor(id, { token, signal, requestImpl } = {}) {
  if (!token) return false;
  const request = requestImpl || defaultRequest;
  try {
    const color = sanitizeDiscColor(id);
    const response = await request("/me/disc-color", {
      token,
      signal,
      method: "PUT",
      body: { discColor: color },
    });
    return Boolean(response && response.ok);
  } catch {
    return false;
  }
}

export function useDiscColorSession({ requestImpl } = {}) {
  const local = loadLocalDiscColor();
  const [discColor, setDiscColor] = React.useState(local.discColor || DEFAULT_DISC_COLOR);
  const memberIdRef = React.useRef(local.memberId || "me");

  React.useEffect(() => {
    applyDiscColor(discColor);
  }, [discColor]);

  React.useEffect(() => {
    let active = new AbortController();
    function refresh() {
      active.abort();
      active = new AbortController();
      const next = loadLocalDiscColor();
      memberIdRef.current = next.memberId || "me";
      setDiscColor(next.discColor || DEFAULT_DISC_COLOR);
      applyDiscColor(next.discColor || DEFAULT_DISC_COLOR);
      if (!next.token) return;
      fetchRemoteDiscColor({ token: next.token, signal: active.signal, requestImpl })
        .then((remote) => {
          if (!remote) return;
          writeStoredDiscColor(globalThis.localStorage, memberIdRef.current, remote);
          setDiscColor(remote);
          applyDiscColor(remote);
        })
        .catch(() => {});
    }
    refresh();
    function onColor(event) {
      if (!Object.prototype.hasOwnProperty.call(event.detail || {}, "discColor")) return;
      setDiscColor(sanitizeDiscColor(event.detail.discColor));
    }
    window.addEventListener(DISC_COLOR_EVENT, onColor);
    AUTH_EVENTS.forEach((name) => window.addEventListener(name, refresh));
    return () => {
      active.abort();
      window.removeEventListener(DISC_COLOR_EVENT, onColor);
      AUTH_EVENTS.forEach((name) => window.removeEventListener(name, refresh));
    };
  }, [requestImpl]);

  async function choose(id) {
    const color = sanitizeDiscColor(id);
    setDiscColor(color);
    applyDiscColor(color);
    writeStoredDiscColor(globalThis.localStorage, memberIdRef.current, color);
    notifyDiscColorChanged(color);
    const token = readMemberToken({ persistent: globalThis.localStorage, session: globalThis.sessionStorage })
      || readMemberSessionValue(TOKEN_KEY);
    if (token) await persistDiscColor(color, { token, requestImpl });
    return color;
  }

  return { discColor, choose };
}
