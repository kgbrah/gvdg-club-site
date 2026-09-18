import { resolveApiBase } from "../shared/api-base.js";
import { readMemberSessionValue } from "../shared/member-session.js";

export { NAME_KEY, PDGA_KEY, TOKEN_KEY } from "../shared/member-session.js";

export const RECENT_ROUNDS_KEY = "gvdg_recent_rounds";

export function storageGet(key) {
  return readMemberSessionValue(key) || null;
}

export function localStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function authBase() {
  return resolveApiBase({ datasetKeys: ["authBase"] });
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
