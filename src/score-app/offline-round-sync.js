import { offlineOwner, parseOfflineRound } from "../shared/offline-round.js";
import { resolveApiBase } from "../shared/api-base.js";
import { NAME_KEY, readMemberSessionValue, readMemberToken } from "../shared/member-session.js";
import { readOfflineOpenToken, readOpenPlayName, readOpenPlayToken, writeOpenPlaySession } from "./open-play-session.js";
import { SCORE_AUTH_EVENT } from "../shared/player-theme-session.js";
import { recoveryResult, retryDelay } from "./round-recovery.js";
import { sameOfflineOwner } from "./offline-round-store.js";
export { sameOfflineOwner };

function claims(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[2]) return null;
    const bytes = Uint8Array.from(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

function validTime(claim, now) { return Number.isSafeInteger(claim?.exp) && claim.exp * 1000 > now; }

export function offlineAccount(now = Date.now()) {
  const memberToken = readMemberToken();
  const member = claims(memberToken);
  const memberOwner = offlineOwner({ kind: "member", id: member?.sub });
  if (memberOwner && !member.play && !member.offlinePlay) {
    return { ...memberOwner, name: readMemberSessionValue(NAME_KEY) || "Club member", token: memberToken,
      active: validTime(member, now) && !member.mustChangePin, openArchive: false };
  }
  const openToken = readOpenPlayToken();
  const open = claims(openToken);
  const archiveToken = readOfflineOpenToken();
  const archive = claims(archiveToken);
  const regularId = open?.play && String(open.sub).startsWith("op_") ? open.sub : null;
  const archiveMatches = Boolean(archive?.offlinePlay && String(archive.sub).startsWith("op_") && (!regularId || regularId === archive.sub));
  const owner = offlineOwner({ kind: "open", id: regularId || (archiveMatches ? archive.sub : null) });
  if (!owner) return null;
  const withArchive = archiveMatches && validTime(archive, now);
  return { ...owner, name: readOpenPlayName() || open?.name || "Open play", token: withArchive ? archiveToken : openToken,
    active: withArchive || validTime(open, now), openArchive: withArchive };
}

export async function offlineRequest(path, token, { method = "GET", body, raw = false, fetcher = fetch, signal, anonymous = false } = {}) {
  if (!token && !anonymous) return { ok: false, status: 401, data: { error: "unauthorized" } };
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["Content-Type"] = raw ? body.type || "application/octet-stream" : "application/json";
  try {
    const response = await fetcher(resolveApiBase({ datasetKeys: ["apiBase"] }) + path, {
      method, headers, body: raw || body === undefined ? body : JSON.stringify(body), cache: "no-store", signal,
      redirect: "error",
    });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => null), retryAfter: response.headers.get("Retry-After") };
  } catch { return { ok: false, status: 0, data: { error: "network" } }; }
}

export async function extendOpenArchive(account) {
  if (account?.kind !== "open" || account.openArchive || !account.active || !navigator.onLine) return null;
  const result = await offlineRequest("/offline-rounds/open-session", account.token, { method: "POST" });
  if (!result.ok || result.data?.playerId !== account.id || !result.data?.offlineToken || !sameOfflineOwner(account, offlineAccount())) return null;
  writeOpenPlaySession({ offlineToken: result.data.offlineToken });
  return offlineAccount();
}

/** The edit becomes immutable before the first network attempt, including when that acknowledgement is lost. */
export async function syncOfflineRound(store, round, account, { send = offlineRequest, now = Date.now } = {}) {
  if (!sameOfflineOwner(round.owner, account)) throw Object.assign(new Error("offline_owner_mismatch"), { code: "offline_owner_mismatch" });
  if (!round.finishedAt || round.receipt) return round;
  if (!account.active) return store.update(round.localId, null, account, (current) => ({ ...current, uploadError: "unauthorized", retryAt: null }));
  const sealed = await store.update(round.localId, null, account, (current) => {
    if (current.receipt || current.sealedAt || !current.finishedAt) return current;
    if (!parseOfflineRound(current)) return { ...current, uploadError: "invalid_offline_round", retryAt: null };
    return { ...current, sealedAt: new Date(now()).toISOString() };
  });
  if (sealed.receipt || !sealed.sealedAt) return sealed;
  const payload = parseOfflineRound(sealed);
  if (!payload) return store.update(sealed.localId, null, account, (current) => ({ ...current, uploadError: "invalid_offline_round", retryAt: null }));
  const attempt = await send("/offline-rounds/import", account.token, { method: "POST", body: payload });
  return store.update(sealed.localId, null, account, (current) => {
    if (current.receipt) return current;
    const receipt = attempt.data;
    if (attempt.ok && Number.isSafeInteger(receipt?.id) && receipt.id > 0 && receipt.localId === current.localId) {
      return { ...current, receipt, uploadError: null, retryAt: null };
    }
    const tries = current.attempts + 1;
    const state = recoveryResult(attempt);
    return { ...current, attempts: tries, uploadError: attempt.data?.error || (attempt.ok ? "invalid_receipt" : "upload_failed"),
      retryAt: state === "pending" || state === "saved" ? now() + retryDelay(attempt, tries, now()) : null };
  });
}

export async function uploadOfflineClip(round, account, record) {
  if (!round.receipt || !sameOfflineOwner(round.owner, account) || !account.active) return null;
  const query = new URLSearchParams({ clientId: record.id, hole: record.hole, playerIndex: record.playerIndex,
    highlight: record.highlight ? "1" : "0", moment: record.moment || "" });
  const result = await offlineRequest(`/offline-rounds/${round.receipt.id}/clips?` + query, account.token, {
    method: "POST", raw: true, body: record.blob,
  });
  return result.ok && (result.data?.roundId !== round.receipt.id || result.data?.clientId !== record.id)
    ? { ok: false, status: 502, data: { error: "invalid_clip_receipt" } } : result;
}

export async function openOfflineIdentity(name) {
  const result = await offlineRequest("/rounds/open-play", "", { method: "POST", body: { name }, anonymous: true });
  if (!result.ok) return result;
  if (offlineAccount() || !result.data?.token || !result.data?.offlineToken || !result.data?.name) {
    return { ok: false, status: 409, data: { error: "account_changed" } };
  }
  writeOpenPlaySession({ token: result.data.token, name: result.data.name, offlineToken: result.data.offlineToken });
  window.dispatchEvent(new Event(SCORE_AUTH_EVENT));
  return result;
}

export async function offlineClipUrl(path, token, signal) {
  if (!token || !/^\/offline-rounds\/\d+\/clips\/\d+\/media$/.test(path)) throw new Error("invalid_clip_path");
  const response = await fetch(resolveApiBase({ datasetKeys: ["apiBase"] }) + path, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal,
  });
  if (!response.ok) throw new Error("clip_play_failed");
  return response.blob();
}
