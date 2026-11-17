// Member app entry to the used-disc marketplace in the Pro Shop: what's waiting on you, and links into it.
// Lazy chunk; the marketplace itself lives on pro-shop.html.
import React from "react";
import { ChevronRight, Disc3, Handshake, PackageSearch, Store, Tag } from "lucide-react";

import { requestJson } from "./api.js";

const h = React.createElement;
const SHOP = "pro-shop.html";

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

function list(data, key) {
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function name(trader) {
  return trader && typeof trader.name === "string" && trader.name ? trader.name : "Someone";
}

export function waitingRows(data) {
  const rows = [];
  for (const deal of list(data, "selling")) {
    rows.push({ key: "sell-" + deal.id, href: `${SHOP}#market/listing/${deal.listingId}`,
      title: `${name(deal.buyer)} is ${deal.kind === "trade" ? "trading for" : "buying"} ${deal.listingTitle || "your disc"}`,
      detail: deal.kind === "trade" ? "Mark it traded or release it" : "Mark it sold once you're paid, or release it" });
  }
  for (const offer of list(data, "offersIn")) {
    rows.push({ key: "offer-" + offer.id, href: `${SHOP}#market/listing/${offer.listingId}`,
      title: `Trade offer on ${offer.listingTitle || "your disc"}`, detail: `From ${name(offer.buyer)}. Accept or decline` });
  }
  for (const deal of list(data, "feedbackToLeave")) {
    rows.push({ key: "fb-" + deal.id, href: `${SHOP}#my-market`,
      title: `Leave feedback for ${deal.listingTitle || "a deal"}`, detail: deal.role === "seller" ? "You sold it" : "You bought it" });
  }
  return rows;
}

export function MemberMarketplacePage({ token }) {
  const [state, setState] = React.useState({ status: "loading", data: null });
  React.useEffect(() => {
    const controller = new AbortController();
    requestJson("/market/me", { signal: controller.signal, token })
      .then((data) => setState({ status: "ready", data }))
      .catch((error) => { if (error?.name !== "AbortError") setState({ status: "error", data: null }); });
    return () => controller.abort();
  }, [token]);

  const rows = waitingRows(state.data);
  const buying = list(state.data, "buying");
  return h("div", { className: "member-subpage member-marketplace", "data-member-marketplace": state.status === "loading" ? "loading" : "ready" }, [
    h("section", { className: "member-link-section", "aria-label": "Waiting on you", key: "waiting" }, [
      h("h2", { key: "title" }, "Waiting on you"),
      state.status === "loading" ? h("p", { className: "dash-note", key: "loading", role: "status" }, "Checking your deals…") : null,
      state.status === "error" ? h("p", { className: "dash-note", key: "error", role: "status" }, "Your marketplace deals couldn't load. Open the marketplace to see them.") : null,
      state.status === "ready" && !rows.length ? h("p", { className: "dash-note", key: "none" }, "Nothing is waiting on you.") : null,
      rows.length ? h("div", { className: "member-link-list", key: "rows" }, rows.map((row) => h(LinkRow, { ...row, icon: Handshake, key: row.key }))) : null,
    ]),
    buying.length ? h("section", { className: "member-link-section", "aria-label": "Buying", key: "buying" }, [
      h("h2", { key: "title" }, "Buying"),
      h("div", { className: "member-link-list", key: "rows" }, buying.map((deal) => h(LinkRow, {
        detail: `From ${name(deal.seller)}. Pay them and arrange pickup`, href: `${SHOP}#market/listing/${deal.listingId}`, icon: Tag,
        key: deal.id, title: deal.listingTitle || "A disc",
      }))),
    ]) : null,
    h("section", { className: "member-link-section", "aria-label": "Marketplace", key: "links" }, [
      h("h2", { key: "title" }, "Used discs"),
      h("div", { className: "member-link-list", key: "rows" }, [
        h(LinkRow, { detail: "Discs from club members", href: `${SHOP}#market`, icon: Store, key: "browse", title: "Browse marketplace", }),
        h(LinkRow, { detail: "Discs people are looking for", href: `${SHOP}#wanted`, icon: PackageSearch, key: "wanted", title: "WANTED" }),
        h(LinkRow, { detail: "List a disc for sale or trade", href: `${SHOP}#market/sell`, icon: Disc3, key: "sell", title: "Sell a disc" }),
        h(LinkRow, { detail: "Listings, deals, feedback and payment settings", href: `${SHOP}#my-market`, icon: Handshake, key: "mine", title: "My marketplace" }),
      ]),
    ]),
  ]);
}
