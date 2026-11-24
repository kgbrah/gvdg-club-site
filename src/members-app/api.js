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

// Home's cards and hooks ask for some of the same reads at once (several want /me). Identical GETs that are
// already in flight share one network request; every caller still gets its own Response and its own abort.
const inFlight = new Map();

function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function sharedGet(url, init, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const key = `${url}\n${init.headers.Authorization || ""}`;
  let shared = inFlight.get(key);
  if (!shared) {
    shared = fetch(url, init);
    inFlight.set(key, shared);
    const settled = () => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    };
    shared.then(settled, settled);
  }
  const response = shared.then((value) => value.clone());
  if (!signal) return response;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    response.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function request(path, { signal, token = null, method = "GET", body = undefined } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${authBase()}${path}`;
  if (method === "GET" && body === undefined) return sharedGet(url, { cache: "no-store", headers, method }, signal);
  return fetch(url, {
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
    if (typeof response.json === "function") {
      error.data = await response.json().catch(() => null);
    }
    throw error;
  }
  return response.json();
}
