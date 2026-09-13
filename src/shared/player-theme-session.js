import { resolveApiBase } from "./api-base.js";
import {
  applyDashboardTheme,
  HEX,
  readStoredTheme,
  sanitizeTheme,
  writeStoredTheme,
} from "./dashboard-theme-model.js";

export const TOKEN_KEY = "gvdg_member_token";
export const PDGA_KEY = "gvdg_member_pdga";
export const SCORE_AUTH_EVENT = "gvdg:score-auth";
export const THEME_EVENT = "gvdg:player-theme";
export const CLUB_STATUS_COLOR = "#1A1A2E";
export const CLUB_STATUS_COLOR_DARK = "#0F0F1E";

export function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    const json = decodeURIComponent(Array.from(atob(padded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function themeMemberIds({ token, pdgaNo } = {}) {
  const ids = [];
  const sub = String(decodeJwtPayload(token)?.sub || "").trim();
  const pdga = String(pdgaNo || "").trim();
  if (sub) ids.push(sub);
  if (pdga && !ids.includes(pdga)) ids.push(pdga);
  if (!ids.includes("me")) ids.push("me");
  return ids;
}

export function readSessionValue(key, storage = globalThis.sessionStorage) {
  try {
    return storage?.getItem?.(key) || "";
  } catch {
    return "";
  }
}

export function loadLocalPlayerTheme({
  token,
  pdgaNo,
  storage = globalThis.localStorage,
  sessionStorage: sessions = globalThis.sessionStorage,
} = {}) {
  const sessionToken = token ?? readSessionValue(TOKEN_KEY, sessions);
  if (!sessionToken) return { theme: null, memberId: "me", token: "" };
  const sessionPdga = pdgaNo ?? readSessionValue(PDGA_KEY, sessions);
  const ids = themeMemberIds({ token: sessionToken, pdgaNo: sessionPdga });
  const memberId = ids[0] || "me";
  for (const cacheId of ids) {
    const theme = readStoredTheme(storage, cacheId);
    if (theme) return { theme, memberId, token: sessionToken };
  }
  return { theme: null, memberId, token: sessionToken };
}

export function paintPlayerTheme(theme, root) {
  if (!root?.style) return theme || null;
  const safe = sanitizeTheme(theme);
  applyDashboardTheme(safe, root);
  if (safe) root.classList?.add?.("player-theme-page");
  syncDocumentTheme(safe);
  notifyPlayerThemeChanged(safe);
  return safe;
}

export function themeWithMode(theme, mode) {
  const safe = sanitizeTheme(theme);
  if (!safe) return null;
  const nextMode = mode === "light" || mode === "dark" ? mode : safe.mode;
  if (nextMode === safe.mode) return safe;
  return sanitizeTheme({ ...safe, mode: nextMode });
}

function persistClubMode(mode) {
  try {
    globalThis.localStorage?.setItem?.("theme", mode);
  } catch {
    // ignore
  }
}

export function storedClubMode() {
  try {
    const theme = globalThis.localStorage?.getItem?.("theme");
    if (theme === "dark" || theme === "light") return theme;
  } catch {
    // ignore
  }
  return globalThis.document?.documentElement?.getAttribute?.("data-theme") === "dark" ? "dark" : "light";
}

export function statusBarColor(theme, mode) {
  const token = theme?.tokens?.["bg-secondary"];
  if (HEX.test(String(token || ""))) return token;
  return (theme?.mode || mode) === "dark" ? CLUB_STATUS_COLOR_DARK : CLUB_STATUS_COLOR;
}

export function paintStatusBar(theme, mode) {
  const color = statusBarColor(theme, mode || storedClubMode());
  const doc = globalThis.document;
  if (!doc) return color;
  const metas = doc.querySelectorAll?.('meta[name="theme-color"]') || [];
  for (const node of metas) {
    if (typeof node.remove === "function") node.remove();
    else node.parentNode?.removeChild?.(node);
  }
  if (!doc.head || typeof doc.createElement !== "function") {
    const leftover = doc.querySelector?.('meta[name="theme-color"]');
    leftover?.setAttribute?.("content", color);
    return color;
  }
  const meta = doc.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", color);
  doc.head.insertBefore(meta, doc.head.firstChild);
  return color;
}

function syncDocumentTheme(theme) {
  const root = globalThis.document?.documentElement;
  const mode = theme?.mode === "dark" || theme?.mode === "light" ? theme.mode : null;
  if (root) {
    if (mode === "dark") root.setAttribute("data-theme", "dark");
    else if (mode === "light") root.removeAttribute("data-theme");
  }
  if (mode) persistClubMode(mode);
  paintStatusBar(theme, mode);
}

export function notifyPlayerThemeChanged(theme) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(THEME_EVENT, { detail: { theme: theme || null } }));
  } catch {
    // ignore
  }
}

export async function fetchRemotePlayerTheme({ token, signal, requestImpl } = {}) {
  if (!token) return undefined;
  const request = requestImpl || defaultThemeRequest;
  const response = await request("/me/dashboard-theme", { token, signal });
  if (!response?.ok) return undefined;
  const data = await response.json().catch(() => null);
  if (!data || !Object.prototype.hasOwnProperty.call(data, "theme")) return undefined;
  return sanitizeTheme(data.theme);
}

export async function defaultThemeRequest(path, { token, signal, method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${resolveApiBase()}${path}`, {
    cache: "no-store",
    headers,
    method,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function persistPlayerTheme(theme, { token, signal, requestImpl } = {}) {
  if (!token) return false;
  const request = requestImpl || defaultThemeRequest;
  try {
    const response = await request("/me/dashboard-theme", {
      token,
      signal,
      method: theme ? "PUT" : "DELETE",
      body: theme ? { theme } : undefined,
    });
    return Boolean(response && response.ok);
  } catch {
    return false;
  }
}

export async function syncPlayerTheme({
  root,
  storage = globalThis.localStorage,
  sessionStorage: sessions = globalThis.sessionStorage,
  token,
  pdgaNo,
  signal,
  requestImpl,
  onTheme,
} = {}) {
  const local = loadLocalPlayerTheme({ token, pdgaNo, storage, sessionStorage: sessions });
  paintPlayerTheme(local.theme, root);
  onTheme?.(local.theme, local.memberId);
  if (!local.token) return local;
  const remote = await fetchRemotePlayerTheme({ token: local.token, signal, requestImpl });
  if (signal?.aborted) return local;
  const currentToken = token ?? readSessionValue(TOKEN_KEY, sessions);
  if (currentToken !== local.token) return local;
  if (remote === undefined) return local;
  writeStoredTheme(storage, local.memberId, remote);
  paintPlayerTheme(remote, root);
  onTheme?.(remote, local.memberId);
  return { ...local, theme: remote };
}

export function togglePlayerThemeMode(theme, { root, storage = globalThis.localStorage, memberId, token, requestImpl } = {}) {
  const next = themeWithMode(theme, theme?.mode === "light" ? "dark" : "light");
  if (!next) return null;
  if (memberId) writeStoredTheme(storage, memberId, next);
  paintPlayerTheme(next, root);
  if (token) persistPlayerTheme(next, { token, requestImpl }).catch(() => {});
  return next;
}

export function notifyScoreAuthChanged() {
  try {
    globalThis.dispatchEvent?.(new Event(SCORE_AUTH_EVENT));
  } catch {
    // ignore
  }
}
