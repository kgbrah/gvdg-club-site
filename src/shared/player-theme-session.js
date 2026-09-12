import { resolveApiBase } from "./api-base.js";
import {
  applyDashboardTheme,
  readStoredTheme,
  sanitizeTheme,
  writeStoredTheme,
} from "./dashboard-theme-model.js";

export const TOKEN_KEY = "gvdg_member_token";
export const PDGA_KEY = "gvdg_member_pdga";
export const SCORE_AUTH_EVENT = "gvdg:score-auth";

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

export function readSessionValue(key, storage) {
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
  const sessionPdga = pdgaNo ?? readSessionValue(PDGA_KEY, sessions);
  const ids = themeMemberIds({ token: sessionToken, pdgaNo: sessionPdga });
  for (const memberId of ids) {
    const theme = readStoredTheme(storage, memberId);
    if (theme) return { theme, memberId, token: sessionToken };
  }
  return { theme: null, memberId: ids[0] || "me", token: sessionToken };
}

export function paintPlayerTheme(theme, root) {
  if (!root?.style) return theme || null;
  const safe = sanitizeTheme(theme);
  applyDashboardTheme(safe, root);
  if (safe) root.classList?.add?.("player-theme-page");
  syncDocumentTheme(safe);
  return safe;
}

export function themeWithMode(theme, mode) {
  const safe = sanitizeTheme(theme);
  if (!safe) return null;
  const nextMode = mode === "light" || mode === "dark" ? mode : safe.mode;
  if (nextMode === safe.mode) return safe;
  return sanitizeTheme({ ...safe, mode: nextMode });
}

function syncDocumentTheme(theme) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (!theme) return;
  if (theme.mode === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

export async function fetchRemotePlayerTheme({ token, signal, requestImpl } = {}) {
  if (!token) return null;
  const request = requestImpl || defaultThemeRequest;
  const response = await request("/me/dashboard-theme", { token, signal });
  if (!response?.ok) return undefined;
  const data = await response.json().catch(() => null);
  if (!data || !Object.prototype.hasOwnProperty.call(data, "theme")) return undefined;
  return sanitizeTheme(data.theme);
}

export async function defaultThemeRequest(path, { token, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${resolveApiBase()}${path}`, { cache: "no-store", headers, method: "GET", signal });
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
  if (remote === undefined) return local;
  writeStoredTheme(storage, local.memberId, remote);
  paintPlayerTheme(remote, root);
  onTheme?.(remote, local.memberId);
  return { ...local, theme: remote };
}

export function togglePlayerThemeMode(theme, { root, storage = globalThis.localStorage, memberId } = {}) {
  const next = themeWithMode(theme, theme?.mode === "light" ? "dark" : "light");
  if (!next) return null;
  if (memberId) writeStoredTheme(storage, memberId, next);
  paintPlayerTheme(next, root);
  return next;
}

export function notifyScoreAuthChanged() {
  try {
    globalThis.dispatchEvent?.(new Event(SCORE_AUTH_EVENT));
  } catch {
    // ignore
  }
}
