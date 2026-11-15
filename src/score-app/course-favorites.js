import React from "react";
import { resolveApiBase } from "../shared/api-base.js";
import { readMemberToken } from "../shared/member-session.js";
import { decodeJwtPayload, SCORE_AUTH_EVENT } from "../shared/player-theme-session.js";
import { readOpenPlayToken } from "./open-play-session.js";

function deviceStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function favoriteOwner(memberToken, openToken) {
  const memberId = decodeJwtPayload(memberToken)?.sub;
  if (typeof memberId === "string" && memberId) return "member:" + memberId;
  const openId = decodeJwtPayload(openToken)?.sub;
  return typeof openId === "string" && openId.startsWith("op_") ? "open:" + openId : null;
}

function ids(value) {
  return new Set((Array.isArray(value) ? value : []).map(String).filter((id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))));
}

function cacheKey(owner) {
  return "gvdg.course-favorites.v1:" + encodeURIComponent(owner);
}

export function readFavoriteCache(owner, storage = deviceStorage()) {
  if (!owner || !storage) return new Set();
  try { return ids(JSON.parse(storage.getItem(cacheKey(owner)) || "[]")); } catch { return new Set(); }
}

export function writeFavoriteCache(owner, favoriteIds, storage = deviceStorage()) {
  if (!owner || !storage) return false;
  try {
    storage.setItem(cacheKey(owner), JSON.stringify([...favoriteIds]));
    return true;
  } catch { return false; }
}

function favoriteIdentity() {
  let member = null;
  let open = null;
  try { member = readMemberToken(); } catch { /* storage unavailable */ }
  try { open = readOpenPlayToken(); } catch { /* storage unavailable */ }
  return { token: member, owner: favoriteOwner(member, open) };
}

async function favoriteRequest(token, signal, courseId = "", method = "GET") {
  const base = resolveApiBase({ datasetKeys: ["apiBase"] });
  const suffix = courseId ? "/" + encodeURIComponent(courseId) : "";
  const response = await fetch(base + "/me/course-favorites" + suffix, {
    method, signal, cache: "no-store", headers: { Accept: "application/json", Authorization: "Bearer " + token },
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

export function useCourseFavorites() {
  const [identity, setIdentity] = React.useState(favoriteIdentity);
  const { token, owner } = identity;
  const [state, setState] = React.useState(() => ({ owner, ids: readFavoriteCache(owner), loading: Boolean(token), error: "" }));
  const pending = React.useRef(null);
  const [busy, setBusy] = React.useState("");
  React.useEffect(() => {
    const refresh = () => setIdentity(favoriteIdentity());
    window.addEventListener("storage", refresh);
    window.addEventListener(SCORE_AUTH_EVENT, refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(SCORE_AUTH_EVENT, refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);
  React.useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy("");
    setState({ owner, ids: readFavoriteCache(owner), loading: Boolean(token), error: "" });
    if (!owner || !token) return undefined;
    const controller = new AbortController();
    favoriteRequest(token, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      const favorites = ids(response.courseIds);
      writeFavoriteCache(owner, favorites);
      setState({ owner, ids: favorites, loading: false, error: "" });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ owner, ids: readFavoriteCache(owner), loading: false, error: "Could not refresh account favorites." });
    });
    return () => {
      controller.abort();
      pending.current?.abort();
    };
  }, [identity, owner, token]);
  const favorites = state.owner === owner ? state.ids : new Set();
  async function toggle(courseId) {
    const id = String(courseId);
    if (!owner || pending.current || state.loading || !ids([id]).size) return;
    const favorite = !favorites.has(id);
    const next = new Set(favorites);
    if (favorite) next.add(id);
    else next.delete(id);
    if (!token) {
      if (!writeFavoriteCache(owner, next)) {
        setState({ owner, ids: favorites, loading: false, error: "Could not save favorites on this device." });
        return;
      }
      setState({ owner, ids: next, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(id);
    try {
      await favoriteRequest(token, controller.signal, id, favorite ? "PUT" : "DELETE");
      if (controller.signal.aborted) return;
      writeFavoriteCache(owner, next);
      setState({ owner, ids: next, loading: false, error: "" });
    } catch {
      if (!controller.signal.aborted) setState({ owner, ids: favorites, loading: false, error: "Could not change account favorites. Try again when connected." });
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!controller.signal.aborted) setBusy("");
      }
    }
  }
  return { available: Boolean(owner), favorites, toggle, busy, loading: state.owner !== owner || state.loading, error: state.owner === owner ? state.error : "" };
}
