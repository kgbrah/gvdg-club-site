export const TOKEN_KEY = "gvdg_member_token";
export const NAME_KEY = "gvdg_member_name";
export const PDGA_KEY = "gvdg_member_pdga";
export const RECENT_ROUNDS_KEY = "gvdg_recent_rounds";

export function storageGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function localStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function authBase() {
  const host = window.location.hostname;
  const localAuthBase = ["127.0.0.1", "localhost"].includes(host) ? "http://127.0.0.1:8788" : "";
  const configured = document.getElementById("loginGate")?.dataset.authBase?.trim() || "";
  const fallback = host === "greenvillediscgolf.com" || host === "www.greenvillediscgolf.com"
    ? "https://auth.greenvillediscgolf.com"
    : "https://auth.gvdgclub.com";
  return (localAuthBase || configured || fallback).replace(/\/+$/, "");
}

export async function request(path, { signal, token = null, method = "GET", body = undefined } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${authBase()}${path}`, {
    cache: "no-store",
    headers,
    method,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function requestJson(path, { signal, token = null, method = "GET", body = undefined } = {}) {
  const response = await request(path, { signal, token, method, body });
  if (!response.ok) {
    const error = new Error(`request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
