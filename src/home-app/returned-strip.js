// Homepage: a "Recently returned" strip from Lost & Found. It fetches one small public list only when the
// reader scrolls near it, and renders nothing at all when no disc has come home lately.
import React from "react";
import { ChevronRight, Disc3 } from "lucide-react";

import { resolveApiBase } from "../shared/api-base.js";
import { karmaLabel, shortDay } from "../shared/lost-found-model.js";

const h = React.createElement;

function photoSrc(photo) {
  const path = photo?.url;
  return typeof path === "string" && /^\/lost-found\/photos\/\d{1,12}$/.test(path) ? resolveApiBase() + path : "";
}

function useNearViewport(ref) {
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || near) return undefined;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

function ReturnedItem({ item }) {
  const src = photoSrc(item.photo);
  const karma = karmaLabel(item.finder);
  return h("li", { className: "returned-item", "data-home-returned": item.claimId }, [
    src
      ? h("img", { alt: "", className: "returned-photo", key: "photo", loading: "lazy", src })
      : h("span", { "aria-hidden": "true", className: "returned-photo returned-photo-fallback", key: "photo" }, h(Disc3, { size: 34, strokeWidth: 1.5 })),
    h("div", { className: "returned-copy", key: "copy" }, [
      h("p", { className: "returned-disc", key: "disc" }, item.disc),
      item.caption ? h("p", { className: "returned-caption", key: "caption" }, item.caption) : null,
      h("p", { className: "returned-meta", key: "meta" }, ["Returned by " + (item.finder?.name || "a member"), item.course?.name, shortDay(item.returnedAt)].filter(Boolean).join(" · ")),
      karma ? h("p", { className: "returned-karma", key: "karma" }, karma) : null,
    ]),
  ]);
}

export function HomeReturnedStrip() {
  const sentinel = React.useRef(null);
  const near = useNearViewport(sentinel);
  const [items, setItems] = React.useState(null);
  React.useEffect(() => {
    if (!near) return undefined;
    const controller = new AbortController();
    fetch(`${resolveApiBase()}/lost-found/returned?view=strip&limit=6`, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setItems(Array.isArray(data?.recent) ? data.recent.filter((row) => row && typeof row.disc === "string").slice(0, 6) : []))
      .catch((error) => { if (error?.name !== "AbortError") setItems([]); });
    return () => controller.abort();
  }, [near]);
  if (!items) return h("div", { "aria-hidden": "true", className: "returned-sentinel", ref: sentinel });
  if (!items.length) return null;
  return h("section", { "aria-labelledby": "returnedDiscsTitle", className: "section", "data-home-returned-strip": items.length, id: "returned-discs" }, [
    h("h2", { className: "section-title visible", id: "returnedDiscsTitle", key: "title" }, "Recently Returned"),
    h("p", { className: "section-subtitle", key: "subtitle" }, "Lost discs that found their way home, thanks to the members who returned them."),
    h("ul", { className: "returned-list", key: "list" }, items.map((item) => h(ReturnedItem, { item, key: item.claimId }))),
    h("p", { className: "returned-footer", key: "footer" }, h("a", { className: "view-all-link", href: "lost-found.html#returned" }, [
      "Lost a disc, or found one? Lost & Found",
      h(ChevronRight, { "aria-hidden": "true", focusable: "false", key: "icon", size: 15, strokeWidth: 2.4 }),
    ])),
  ]);
}
