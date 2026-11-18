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

/**
 * A sign-in link from one of our emails to a guest (?gl=…): exchanged once for a guest session in this browser, then
 * dropped from the address. Getting the email proved the inbox, so no second code. Resolves true when signed in.
 */
export async function consumeGuestLink(location = window.location, history = window.history) {
  let url;
  try { url = new URL(location.href); } catch { return false; }
  const link = url.searchParams.get("gl");
  if (!link) return false;
  url.searchParams.delete("gl");
  try { history.replaceState(history.state, "", url.pathname + url.search + url.hash); } catch { /* address stays */ }
  if (readMemberToken() || link.length > 2000) return false;
  try {
    const response = await fetch(marketBase() + "/market/guest/link", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ token: link }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.token !== "string") return false;
    writeGuest({ token: data.token, key: data.guest?.key || "", name: data.guest?.name || "Guest" });
    return true;
  } catch {
    return false;
  }
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
    guests_cannot_list: "Guest accounts can buy, trade and post WANTED. Listing discs is for club members.",
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
    seller_email_required: "Add an email for buyer alerts before you list a disc.",
    relist_expired: "The 24-hour relist window has closed. List the disc again instead.",
    not_withdrawn: "This listing is already back on the marketplace.",
    storage_unavailable: "Photo uploads are unavailable right now.",
    guest_unavailable: "Guest checkout is unavailable right now. Members can sign in.",
    invalid_code: "That code didn't match or has expired. Request a new one.",
    unauthorized: "Your session ended. Sign in or verify again.",
    not_found: "That item is no longer available.",
    request_too_large: "Those photos are too large. Try fewer or smaller photos.",
    invalid_amount: "The donation is at least $1 and no more than the sale price.",
    already_confirmed: "The club already confirmed this donation. Thank you!",
    not_a_sale: "Only a completed sale can carry a club donation.",
  };
  return messages[code] || fallback;
}
