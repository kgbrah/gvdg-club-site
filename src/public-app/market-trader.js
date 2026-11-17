import React from "react";

import { feedbackLabel } from "../shared/market-model.js";
import { marketRequest } from "./market-api.js";
import { ListingCard } from "./market-browse.js";
import { FeedbackList } from "./market-feedback.js";
import { GuestBadge, LoadState, TraderLine, useIdentityVersion } from "./market-ui.js";

const h = React.createElement;

export function MarketTrader({ traderKey }) {
  const [state, setState] = React.useState({ status: "loading", data: null });
  const [attempt, setAttempt] = React.useState(0);
  const identity = useIdentityVersion();

  React.useEffect(() => {
    const controller = new AbortController();
    marketRequest("/market/traders/" + encodeURIComponent(traderKey), { signal: controller.signal }).then(({ ok, status, data }) => {
      if (ok && data.trader) setState({ status: "ready", data });
      else setState({ status: status === 404 ? "missing" : "error", data: null });
    }).catch(() => {});
    return () => controller.abort();
  }, [traderKey, attempt, identity]);

  const reload = () => setAttempt((value) => value + 1);
  const data = state.data;
  const trader = data?.trader;
  const summary = trader?.feedback || {};
  const listings = Array.isArray(data?.listings) ? data.listings : [];

  return h("section", { "data-market-state": state.status, "data-market-view": "trader" }, [
    h("a", { className: "market-back", href: "#market", key: "back" }, "← All used discs"),
    state.status === "missing" ? h("p", { className: "public-state", key: "missing", role: "status" }, "We couldn't find that trader.") : null,
    state.status === "loading" || state.status === "error" ? h(LoadState, { key: "load", onRetry: reload, state: state.status }) : null,
    trader ? h("div", { className: "my-orders-panel market-panel market-trader-head", key: "head" }, [
      h("h2", { className: "market-title", key: "name" }, [h(TraderLine, { key: "line", link: false, showPhoto: true, trader: { ...trader, feedback: null } })]),
      trader.kind === "guest" ? h("p", { className: "market-note", key: "guest" }, [h(GuestBadge, { key: "badge" }), " Verified by email, not a club member."]) : null,
      h("p", { className: "market-score", "data-market-score": "true", key: "score" }, feedbackLabel(summary)),
      h("p", { className: "product-meta", key: "counts" }, `Positive ${summary.positive || 0} · Neutral ${summary.neutral || 0} · Negative ${summary.negative || 0}`),
    ]) : null,
    trader ? h("section", { "aria-label": "Feedback as a seller", className: "my-orders-panel market-panel", key: "as-seller" }, [
      h("h3", { className: "my-orders-title", key: "title" }, "Feedback as a seller"),
      h(FeedbackList, { empty: "No feedback as a seller yet.", items: data.asSeller, key: "list", onChange: reload, viewer: data.viewer }),
    ]) : null,
    trader ? h("section", { "aria-label": "Feedback as a buyer", className: "my-orders-panel market-panel", key: "as-buyer" }, [
      h("h3", { className: "my-orders-title", key: "title" }, "Feedback as a buyer"),
      h(FeedbackList, { empty: "No feedback as a buyer yet.", items: data.asBuyer, key: "list", onChange: reload, viewer: data.viewer }),
    ]) : null,
    trader && listings.length ? h("section", { "aria-label": "Discs for sale", key: "listings" }, [
      h("div", { className: "shop-catalog-bar", key: "bar" }, [
        h("h3", { className: "market-subhead", key: "title" }, "Discs for sale"),
        h("a", { className: "shop-cart-link", href: "#market?seller=" + encodeURIComponent(trader.key), key: "all" }, "See all"),
      ]),
      h("div", { className: "product-grid market-grid", key: "grid" }, listings.map((listing) => h(ListingCard, { key: listing.id, listing, showSeller: false }))),
    ]) : null,
  ]);
}
