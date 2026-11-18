// A guest's sign-in link (the owner's rule: a guest who reports a found disc verifies their email once). Every email we
// send a guest carries one, so opening it in the mail app, on another phone or a laptop signs them in without a second
// code: getting the email is the proof. The page exchanges ?gl= once (POST /market/guest/link) and drops it from the
// address. Links last GUEST_LINK_TTL_SEC; they are never a session themselves (jwt.ts: glink).
import type { Env } from "./env.js";
import { signGuestLink } from "./jwt.js";

export const GUEST_LINK_TTL_SEC = 14 * 24 * 60 * 60;

/** `page` ("https://gvdgclub.com/lost-found.html#post/12") with this guest's sign-in link on it. */
export async function guestLinkUrl(env: Env, guestId: string, page: string): Promise<string> {
  const token = await signGuestLink(guestId, env.JWT_SECRET, GUEST_LINK_TTL_SEC);
  const [path = "", hash = ""] = page.split("#");
  return path + (path.includes("?") ? "&" : "?") + "gl=" + encodeURIComponent(token) + (hash ? "#" + hash : "");
}
