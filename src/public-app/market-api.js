// Marketplace requests from the Pro Shop page. A member's session wins; otherwise a verified guest's
// marketplace token (kept in localStorage) is sent. The Worker decides who the caller is.
import { resolveApiBase } from "../shared/api-base.js";
import { readMemberToken } from "../shared/member-session.js";

export const GUEST_KEY = "gvdg_market_guest";
export const IDENTITY_EVENT = "gvdg:market-identity";

export function marketBase() {
  return resolveApiBase({ datasetKeys: ["authBase"] });
}

export function readGuest() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GUEST_KEY) || "null");
    if (!parsed || typeof parsed.token !== "string" || !parsed.token || parsed.token.length > 4000) return null;
    return {
      token: parsed.token,
      key: typeof parsed.key === "string" ? parsed.key.slice(0, 64) : "",
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 60) : "Guest",
    };
  } catch {
    return null;
  }
}

function announce() {
  window.dispatchEvent(new CustomEvent(IDENTITY_EVENT));
}

export function writeGuest(guest) {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify({ token: guest.token, key: guest.key || "", name: guest.name || "Guest" }));
  } catch {
    /* private mode: the guest verifies again next visit */
  }
  announce();
}

export function clearGuest() {
  try {
    localStorage.removeItem(GUEST_KEY);
  } catch {
    /* ignore */
  }
  announce();
}

export function currentCredential() {
  const member = readMemberToken();
  if (member) return { token: member, kind: "member" };
  const guest = readGuest();
  if (guest) return { token: guest.token, kind: "guest" };
  return { token: "", kind: "public" };
}

/** Resolves to { ok, status, data } and never throws for HTTP errors (network errors give status 0). */
export async function marketRequest(path, { method = "GET", body, signal } = {}) {
  const credential = currentCredential();
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (credential.token) headers.Authorization = "Bearer " + credential.token;
  let response;
  try {
    response = await fetch(marketBase() + path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      headers,
      method,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { ok: false, status: 0, data: { error: "network" } };
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && credential.kind === "guest") clearGuest();
  return { ok: response.ok, status: response.status, data: data && typeof data === "object" ? data : {} };
}

/** Photo paths come from the Worker as "/market/photos/<id>"; only those are turned into image URLs. */
export function photoSrc(photo) {
  const path = typeof photo === "string" ? photo : photo?.url;
  return typeof path === "string" && /^\/market\/photos\/\d{1,12}$/.test(path) ? marketBase() + path : "";
}

export function errorMessage(data, fallback = "That didn't work. Please try again.") {
  const code = data?.error;
  const messages = {
    network: "Couldn't reach the shop. Check your connection and try again.",
    rate_limited: "Too many tries. Wait a few minutes and try again.",
    members_only: "Only club members can do that. Members can sign in.",
    suspended: "Your marketplace access is paused. Contact a club admin.",
    own_listing: "That's your own listing.",
    not_available: "Someone else is already buying this disc.",
    no_price: "This disc is trade only.",
    trade_not_open: "This seller isn't taking trades on this disc.",
    offer_exists: "You already have a trade offer waiting on this disc.",
    not_active: "This listing can't be changed right now.",
    already_left: "You already left feedback for this deal.",
    window_closed: "The 60-day feedback window has closed.",
    deal_not_complete: "Feedback opens once the seller marks the deal done.",
    edit_used: "Feedback can only be edited once.",
    edit_window_closed: "Feedback can only be edited within 7 days.",
    reply_exists: "You already replied to this feedback.",
    already_reported: "You already reported this. An admin will take a look.",
    invalid_photo: "That photo couldn't be used. Try a JPEG or PNG under 1.5 MB.",
    storage_unavailable: "Photo uploads are unavailable right now.",
    guest_unavailable: "Guest checkout is unavailable right now. Members can sign in.",
    invalid_code: "That code didn't match or has expired. Request a new one.",
    unauthorized: "Your session ended. Sign in or verify again.",
    not_found: "That item is no longer available.",
    request_too_large: "Those photos are too large. Try fewer or smaller photos.",
  };
  return messages[code] || fallback;
}
