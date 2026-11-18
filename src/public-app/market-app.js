// The used-disc marketplace inside the Pro Shop. Loaded on demand from pro-shop-app.js, so the club shop
// and the other public pages never download it.
import React from "react";

import { parseShopRoute } from "../shared/market-model.js";
import { clearGuest, marketRequest } from "./market-api.js";
import { MarketBrowse } from "./market-browse.js";
import { MarketListing } from "./market-listing.js";
import { MarketMine } from "./market-mine.js";
import { MarketSell } from "./market-sell.js";
import { MarketTrader } from "./market-trader.js";
import { GuestBadge, useIdentityVersion, useMarketConfig, canList } from "./market-ui.js";
import { MarketWantedDetail, MarketWantedList, MarketWantedNew } from "./market-wanted.js";

const h = React.createElement;

function useWaiting(kind) {
  const [waiting, setWaiting] = React.useState(null);
  const [attempt, setAttempt] = React.useState(0);
  const identity = useIdentityVersion();
  React.useEffect(() => {
    const refresh = () => setAttempt((value) => value + 1);
    window.addEventListener("gvdg:market-changed", refresh);
    return () => window.removeEventListener("gvdg:market-changed", refresh);
  }, []);
  React.useEffect(() => {
    if (kind !== "member" && kind !== "guest") {
      setWaiting(null);
      return undefined;
    }
    const controller = new AbortController();
    marketRequest("/market/me/summary", { signal: controller.signal }).then(({ ok, data }) => {
      setWaiting(ok && Number.isFinite(Number(data.waiting)) ? Number(data.waiting) : null);
    }).catch(() => {});
    return () => controller.abort();
  }, [kind, attempt, identity]);
  return waiting;
}

export function MarketIdentityPanel() {
  const config = useMarketConfig();
  const viewer = config.viewer;
  const waiting = useWaiting(viewer.kind);
  if (viewer.kind === "member" || viewer.kind === "guest") {
    const guest = viewer.kind === "guest";
    return h("aside", { className: "wallet-panel market-identity-panel", "data-market-identity-panel": viewer.kind }, [
      h("div", { className: "wallet-label", key: "label" }, guest ? "Buying as a guest" : "Your marketplace"),
      h("div", { className: "wallet-balance", key: "value" }, waiting ? `${waiting} waiting on you` : guest ? viewer.name || "Guest" : "All caught up"),
      h("p", { className: "wallet-note", key: "note" }, guest
        ? [h(GuestBadge, { key: "badge" }), waiting ? " " + (viewer.name || "Guest") : "", " · ", h("button", { className: "market-text-btn", key: "out", onClick: clearGuest, type: "button" }, "Not you?")]
        : canList(viewer) ? [h("a", { href: "#market/sell", key: "sell" }, "Sell a disc"), " · ", h("a", { href: "#my-market", key: "mine" }, "My marketplace")]
          : [h("a", { href: "#my-market", key: "mine" }, "My marketplace")]),
    ]);
  }
  return h("aside", { className: "wallet-panel market-identity-panel", "data-market-identity-panel": "public" }, [
    h("div", { className: "wallet-label", key: "label" }, "Marketplace"),
    h("div", { className: "wallet-balance", key: "value" }, "Browse freely"),
    h("p", { className: "wallet-note", key: "note" }, [
      h("a", { href: "gvdg-members.html", key: "sign-in" }, "Members sign in"),
      " to sell. Not a member? You can buy or post WANTED after a quick email check.",
    ]),
  ]);
}

export function MarketplaceView({ hash }) {
  const route = parseShopRoute(hash);
  const { section, view, id, key } = route;
  let body;
  if (section === "wanted") {
    body = view === "new" ? h(MarketWantedNew, { key: "wanted-new" })
      : view === "detail" ? h(MarketWantedDetail, { id, key: "wanted-" + id })
        : h(MarketWantedList, { key: "wanted", route });
  } else if (section === "mine") {
    body = h(MarketMine, { key: "mine" });
  } else if (view === "listing") {
    body = h(MarketListing, { id, key: "listing-" + id });
  } else if (view === "sell") {
    body = h(MarketSell, { fromBag: route.query.get("from") === "bag", key: "sell" });
  } else if (view === "edit") {
    body = h(MarketSell, { editId: id, key: "edit-" + id });
  } else if (view === "trader") {
    body = h(MarketTrader, { key: "trader-" + key, traderKey: key });
  } else {
    body = h(MarketBrowse, { key: "browse-" + (route.query.get("seller") || ""), route });
  }
  return h("div", { className: "market-root", "data-react-market": "ready" }, body);
}
