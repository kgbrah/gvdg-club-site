export const TOKEN_KEY = "gvdg_member_token";
export const NAME_KEY = "gvdg_member_name";
export const PDGA_KEY = "gvdg_member_pdga";
export const MEMBER_SESSION_KEYS = [TOKEN_KEY, NAME_KEY, PDGA_KEY];

function storeGet(store, key) {
  try {
    return store?.getItem?.(key) || "";
  } catch {
    return "";
  }
}

function storeSet(store, key, value) {
  try {
    if (!store) return;
    if (value == null || value === "") store.removeItem?.(key);
    else store.setItem?.(key, String(value));
  } catch {
    /* private mode / quota */
  }
}

function storeRemove(store, key) {
  try {
    store?.removeItem?.(key);
  } catch {
    /* private mode */
  }
}

export function memberSessionStores({ persistent, session } = {}) {
  return {
    persistent: persistent === undefined ? globalThis.localStorage : persistent,
    session: session === undefined ? globalThis.sessionStorage : session,
  };
}

export function readMemberSessionValue(key, stores) {
  const { persistent, session } = memberSessionStores(stores);
  const local = storeGet(persistent, key);
  if (local) return local;
  const fallback = storeGet(session, key);
  if (fallback) {
    storeSet(persistent, key, fallback);
    return fallback;
  }
  return "";
}

export function writeMemberSessionValue(key, value, stores) {
  const { persistent, session } = memberSessionStores(stores);
  storeSet(persistent, key, value);
  storeSet(session, key, value);
}

export function clearMemberSession(stores) {
  const { persistent, session } = memberSessionStores(stores);
  for (const key of MEMBER_SESSION_KEYS) {
    storeRemove(persistent, key);
    storeRemove(session, key);
  }
}

export function readMemberToken(stores) {
  return readMemberSessionValue(TOKEN_KEY, stores);
}

export function writeMemberSession({ token, name, pdgaNo } = {}, stores) {
  if (token != null) writeMemberSessionValue(TOKEN_KEY, token, stores);
  if (name != null) writeMemberSessionValue(NAME_KEY, name, stores);
  if (pdgaNo !== undefined) writeMemberSessionValue(PDGA_KEY, pdgaNo || "", stores);
}

/** A session is renewed once it has used a day of its 30 (the Worker's /me hands back a fresh one), so a member who
 *  opens any of the apps stays signed in and is signed out only after 30 days away. Measured by the time left, so an
 *  older, shorter session is upgraded the first time an app opens. */
export const RENEW_AFTER_SEC = 24 * 60 * 60;
export const SESSION_DAYS = 30;
const RENEW_WHEN_LEFT_UNDER_SEC = SESSION_DAYS * 86400 - RENEW_AFTER_SEC;

function tokenClaims(token) {
  try {
    const part = String(token || "").split(".")[1] || "";
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4))) || {};
  } catch {
    return {};
  }
}

/** The token's issue time (epoch seconds), read without verifying it (the server does that); 0 if unreadable. */
export function memberTokenIssuedAt(token) {
  const iat = tokenClaims(token).iat;
  return Number.isFinite(iat) ? iat : 0;
}

/** Once a day, swap the stored member session for a fresh one. Never signs anyone out (each app answers a 401 its
 *  own way) and never throws. Resolves "none" | "fresh" | "renewed" | "kept". */
export async function renewMemberSession({ apiBase, fetchImpl = globalThis.fetch, nowMs = Date.now(), stores } = {}) {
  const token = readMemberSessionValue(TOKEN_KEY, stores);
  if (!token || !apiBase || typeof fetchImpl !== "function") return "none";
  const exp = tokenClaims(token).exp;
  if (Number.isFinite(exp) && exp - nowMs / 1000 > RENEW_WHEN_LEFT_UNDER_SEC) return "fresh";
  try {
    const response = await fetchImpl(String(apiBase).replace(/\/+$/, "") + "/me", { headers: { Authorization: "Bearer " + token } });
    if (response.status !== 200) return "kept";
    const data = await response.json();
    // Only replace the token this check was made with (another tab may have signed in as someone else meanwhile).
    if (typeof data?.token === "string" && data.token && readMemberSessionValue(TOKEN_KEY, stores) === token) {
      writeMemberSessionValue(TOKEN_KEY, data.token, stores);
      return "renewed";
    }
    return "kept";
  } catch {
    return "kept";
  }
}
