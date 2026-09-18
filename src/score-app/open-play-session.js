export const OPEN_PLAY_TOKEN_KEY = "gvdg_open_play_token";
export const OPEN_PLAY_NAME_KEY = "gvdg_open_play_name";

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

export function readOpenPlayToken(storage = globalThis.localStorage) {
  return storeGet(storage, OPEN_PLAY_TOKEN_KEY);
}

export function readOpenPlayName(storage = globalThis.localStorage) {
  return storeGet(storage, OPEN_PLAY_NAME_KEY);
}

export function writeOpenPlaySession({ token, name } = {}, storage = globalThis.localStorage) {
  if (token != null) storeSet(storage, OPEN_PLAY_TOKEN_KEY, token);
  if (name != null) storeSet(storage, OPEN_PLAY_NAME_KEY, name);
}

export function clearOpenPlaySession(storage = globalThis.localStorage) {
  storeRemove(storage, OPEN_PLAY_TOKEN_KEY);
  storeRemove(storage, OPEN_PLAY_NAME_KEY);
}
