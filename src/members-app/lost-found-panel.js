// Member app entry to Lost & Found: what's waiting on you (possible matches, returns in progress), your karma,
// and links into lost-found.html. Lazy chunk; Lost & Found itself lives on its own page.
import React from "react";
import { ChevronRight, EyeOff, Handshake, HandHeart, PackageSearch, Search, Trophy } from "lucide-react";

import { requestJson } from "./api.js";

const h = React.createElement;
const PAGE = "lost-found.html";

function LinkRow({ href, title, detail, icon: Icon }) {
  return h("a", { className: "member-link-row", href }, [
    h(Icon, { "aria-hidden": true, className: "member-link-icon", key: "icon", size: 19 }),
    h("span", { className: "member-link-copy", key: "copy" }, [
      h("strong", { key: "title" }, title),
      detail ? h("small", { key: "detail" }, detail) : null,
    ]),
    h(ChevronRight, { "aria-hidden": true, className: "member-link-arrow", key: "arrow", size: 17 }),
  ]);
}

function title(post) {
  const parts = [post?.brand, post?.plastic, post?.mold].map((part) => String(part || "").trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : post?.color ? post.color + " disc" : "A disc";
}

function positive(value) {
  return /^\d{1,12}$/.test(String(value ?? "")) ? String(value) : "";
}

export function waitingRows(data) {
  const rows = [];
  for (const match of Array.isArray(data?.matches) ? data.matches : []) {
    const id = positive(match.id);
    if (!id) continue;
    rows.push({ key: "m" + id, href: `${PAGE}#match/${id}`, icon: Search, title: "Is this yours? " + title(match.found),
      detail: match.strength === "strong" ? "Strong match. Take a look" : "Possible match" });
  }
  for (const claim of Array.isArray(data?.claims) ? data.claims : []) {
    const id = positive(claim.id);
    if (!id || (claim.status !== "open" && claim.status !== "returned")) continue;
    const finder = claim.role === "finder";
    const detail = finder
      ? (claim.status === "open" ? `${claim.owner?.name || "The owner"} claimed it. Arrange the return` : "Waiting for the owner to confirm")
      : (claim.status === "returned" ? "The finder marked it returned. Confirm you got it back" : `${claim.finder?.name || "The finder"} has it. Arrange the return`);
    rows.push({ key: "c" + id, href: `${PAGE}#claim/${id}`, icon: Handshake, title: (finder ? "Return " : "Get back ") + title(claim.found), detail });
  }
  // Your own photos the club's private read flagged (only you ever see this; never what was read).
  for (const photo of Array.isArray(data?.nudges) ? data.nudges : []) {
    const id = positive(photo.id);
    if (!id) continue;
    const postId = positive(photo.postId);
    rows.push({ key: "n" + id, href: postId ? `${PAGE}#post/${postId}` : `${PAGE}#mine`, icon: EyeOff, title: "Check your photo of the " + title(photo),
      detail: "It may show a name or phone number. Replace it or keep it" });
  }
  return rows;
}

function karmaText(karma) {
  const points = Number(karma?.karma) || 0;
  const returned = Number(karma?.returned) || 0;
  return points > 0 || returned > 0 ? `Karma ${points} · ${returned} ${returned === 1 ? "disc" : "discs"} returned` : "";
}

export function MemberLostFoundPage({ token }) {
  const [state, setState] = React.useState({ status: "loading", data: null });
  React.useEffect(() => {
    const controller = new AbortController();
    requestJson("/lost-found/me", { signal: controller.signal, token })
      .then((data) => setState({ status: "ready", data }))
      .catch((error) => { if (error?.name !== "AbortError") setState({ status: "error", data: null }); });
    return () => controller.abort();
  }, [token]);
  const rows = waitingRows(state.data);
  const karma = karmaText(state.data?.karma);
  return h("div", { className: "member-subpage member-lost-found", "data-member-lost-found": state.status === "loading" ? "loading" : "ready" }, [
    h("section", { className: "member-link-section", "aria-label": "Waiting on you", key: "waiting" }, [
      h("h2", { key: "title" }, "Waiting on you"),
      state.status === "loading" ? h("p", { className: "dash-note", key: "loading", role: "status" }, "Checking Lost & Found…") : null,
      state.status === "error" ? h("p", { className: "dash-note", key: "error", role: "status" }, "Lost & Found couldn't load. Open it to see your posts.") : null,
      state.status === "ready" && !rows.length ? h("p", { className: "dash-note", key: "none" }, "Nothing is waiting on you.") : null,
      rows.length ? h("div", { className: "member-link-list", key: "rows" }, rows.map((row) => h(LinkRow, { ...row, key: row.key }))) : null,
      karma ? h("p", { className: "dash-note member-lost-found-karma", key: "karma" }, "Your " + karma.charAt(0).toLowerCase() + karma.slice(1)) : null,
    ]),
    h("section", { className: "member-link-section", "aria-label": "Lost & Found", key: "links" }, [
      h("h2", { key: "title" }, "Lost & Found"),
      h("div", { className: "member-link-list", key: "rows" }, [
        h(LinkRow, { detail: "Discs people found on our courses", href: `${PAGE}#found`, icon: Search, key: "found", title: "Found discs" }),
        h(LinkRow, { detail: "Discs people are looking for", href: `${PAGE}#lost`, icon: PackageSearch, key: "lost", title: "Lost discs" }),
        h(LinkRow, { detail: "Returned discs and Top finders", href: `${PAGE}#returned`, icon: Trophy, key: "returned", title: "Returned" }),
        h(LinkRow, { detail: "Photos are public, so cover any name or phone number", href: `${PAGE}#new/found`, icon: HandHeart, key: "post-found", title: "Post a found disc" }),
        h(LinkRow, { detail: "What's written on it stays private", href: `${PAGE}#new/lost`, icon: PackageSearch, key: "post-lost", title: "Post a lost disc" }),
        h(LinkRow, { detail: "Posts, matches and returns", href: `${PAGE}#mine`, icon: Handshake, key: "mine", title: "My posts" }),
      ]),
    ]),
  ]);
}
