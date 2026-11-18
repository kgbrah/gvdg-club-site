// Member Home: a small "Recently returned" card. Its data rides along the inbox summary Home already fetches
// (no extra request), and this code is a lazy chunk loaded only when there is something to show.
import React from "react";
import { Disc3, HandHeart } from "lucide-react";

import { authBase } from "./api.js";

const h = React.createElement;

function photoSrc(path) {
  return typeof path === "string" && /^\/lost-found\/photos\/\d{1,12}$/.test(path) ? authBase() + path : "";
}

function karmaText(finder) {
  const karma = Number(finder?.karma) || 0;
  const returned = Number(finder?.returned) || 0;
  return karma > 0 ? `Karma ${karma} · ${returned} ${returned === 1 ? "disc" : "discs"} returned` : "";
}

export function ReturnedHomeCard({ recent }) {
  const rows = Array.isArray(recent) ? recent.slice(0, 3) : [];
  if (!rows.length) return null;
  return h("section", { className: "player-card member-returned-card", "aria-labelledby": "member-returned-title", "data-member-returned": rows.length }, [
    h("div", { className: "member-returned-head", key: "head" }, [
      h("h3", { id: "member-returned-title", key: "title" }, [h(HandHeart, { "aria-hidden": true, key: "icon", size: 18 }), " Recently returned"]),
      h("a", { className: "member-returned-link", href: "lost-found.html#returned", key: "all" }, "Lost & Found"),
    ]),
    h("ul", { className: "member-returned-list", key: "list" }, rows.map((row, index) => {
      const src = photoSrc(row.photo);
      const karma = karmaText(row.finder);
      return h("li", { className: "member-returned-row", key: row.claimId || index }, [
        src
          ? h("img", { alt: "", className: "member-returned-thumb", key: "img", loading: "lazy", src })
          : h("span", { "aria-hidden": "true", className: "member-returned-thumb member-returned-fallback", key: "img" }, h(Disc3, { size: 20 })),
        h("span", { className: "member-returned-copy", key: "copy" }, [
          h("strong", { key: "what" }, `${row.finder?.name || "A finder"} returned ${/^[aeiou]/i.test(String(row.disc || "")) ? "an" : "a"} ${row.disc}`),
          h("small", { key: "meta" }, [karma, row.course].filter(Boolean).join(" · ")),
        ]),
      ]);
    })),
  ]);
}
