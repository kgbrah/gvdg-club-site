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
