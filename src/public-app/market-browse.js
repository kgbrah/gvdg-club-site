import React from "react";

import {
  activeFilterCount, clubShareShort, CONDITION_LEGEND, DISC_TYPES, EMPTY_FILTERS, listingHref, listingMeta, listingsQuery, listingTitle, priceLine,
} from "../shared/market-model.js";
import { marketRequest } from "./market-api.js";
import { FeedbackText, GuestBadge, LoadState, MarketPhoto, StatusChip } from "./market-ui.js";
import { AutocompleteInput } from "../shared/autocomplete.js";
import { discSearchSuggestions } from "../shared/disc-catalog.js";

const h = React.createElement;
const DISC_SUGGESTIONS = discSearchSuggestions();

export function ListingCard({ listing, showSeller = true }) {
  const title = listingTitle(listing);
  const href = listingHref(listing.id);
  return h("article", { className: "product-card market-card", "data-market-listing": listing.id, "data-status": listing.status }, [
    h("a", { "aria-hidden": "true", className: "market-card-photo", href, key: "photo", tabIndex: -1 }, [
      h(MarketPhoto, { alt: "", key: "img", photo: listing.photo }),
      listing.status === "pending" ? h("span", { className: "market-chip market-chip-pending market-card-flag", key: "flag" }, "Pending") : null,
    ]),
    h("div", { className: "product-body", key: "body" }, [
      h("a", { className: "product-name market-card-title", href, key: "name" }, title),
      h("div", { className: "product-meta", key: "meta" }, listingMeta(listing)),
      listing.clubShare ? h("div", { className: "product-meta market-club-chip", "data-market-club-share": "true", key: "club" }, clubShareShort(listing.clubShare)) : null,
      listing.location ? h("div", { className: "product-meta", key: "where" }, listing.location) : null,
      showSeller && listing.seller ? h("div", { className: "product-meta market-card-seller", key: "seller" }, [
        h("span", { key: "name" }, listing.seller.name || "Seller"),
        listing.seller.kind === "guest" ? h(GuestBadge, { key: "badge" }) : null,
        " · ", h(FeedbackText, { key: "fb", summary: listing.seller.feedback }),
      ]) : null,
      h(StatusChip, { hidden: listing.hidden, key: "status", status: listing.status === "pending" ? null : listing.status }),
      h("div", { className: "product-bottom", key: "bottom" }, [
        h("div", { className: "product-price", key: "price" }, priceLine(listing)),
        listing.openToTrade && listing.priceCents != null ? h("span", { className: "market-badge", key: "trade" }, "Trades OK") : null,
      ]),
    ]),
  ]);
}

function NumberField({ id, label, value, onChange, min, max, placeholder }) {
  return h("div", { className: "market-field" }, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("input", { id, inputMode: "numeric", key: "input", max, min, onChange: (event) => onChange(event.target.value), placeholder, type: "number", value }),
  ]);
}

const KIND_FILTERS = [["disc", "Discs"], ["bag", "Bags"], ["accessory", "Accessories"]];

function BrowseFilters({ filters, facets, onChange, onReset }) {
  const active = activeFilterCount(filters);
  const gear = filters.kind === "bag" || filters.kind === "accessory";
  const select = (id, label, key, options) => h("div", { className: "market-field", key: id }, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("select", { id, key: "select", onChange: (event) => onChange(key, event.target.value), value: filters[key] }, [
      h("option", { key: "any", value: "" }, "Any"),
      ...options.map(([value, text]) => h("option", { key: value, value }, text)),
    ]),
  ]);
  return h("div", { "aria-label": "Marketplace filters", className: "filters shop-filters market-filters" }, [
    h("div", { className: "shop-search-row", key: "search" }, [
      h("label", { className: "public-sr-only", htmlFor: "marketSearch", key: "search-label" }, "Search marketplace"),
      h(AutocompleteInput, {
        suggestions: DISC_SUGGESTIONS, wrapperClassName: "shop-search-ac",
        id: "marketSearch", key: "search-input", maxLength: 60, onChange: (event) => onChange("q", event.target.value),
        placeholder: "Search used discs and gear", type: "search", value: filters.q,
      }),
      h("label", { className: "public-sr-only", htmlFor: "marketSort", key: "sort-label" }, "Sort listings"),
      h("select", { id: "marketSort", key: "sort", onChange: (event) => onChange("sort", event.target.value), value: filters.sort }, [
        h("option", { key: "newest", value: "newest" }, "Newest first"),
        h("option", { key: "price_asc", value: "price_asc" }, "Price low to high"),
        h("option", { key: "price_desc", value: "price_desc" }, "Price high to low"),
        h("option", { key: "condition", value: "condition" }, "Best condition"),
      ]),
    ]),
    h("details", { className: "shop-filter-details", key: "details" }, [
      h("summary", { key: "summary" }, active ? `Filters (${active} selected)` : "More filters"),
      h("div", { className: "shop-filter-fields market-filter-fields", key: "fields" }, [
        select("marketKind", "What", "kind", KIND_FILTERS),
        // Disc type, plastic and weight only mean something for discs.
        gear ? null : select("marketType", "Disc type", "type", DISC_TYPES),
        select("marketBrand", "Brand", "brand", (facets.brands || []).map((value) => [value, value])),
        gear ? null : select("marketPlastic", "Plastic", "plastic", (facets.plastics || []).map((value) => [value, value])),
        select("marketCondition", "Condition at least", "cond", CONDITION_LEGEND.map(([score, text]) => [String(score), `${score} · ${text}`])),
        gear ? null : h(NumberField, { id: "marketWmin", key: "wmin", label: "Min weight (g)", max: 200, min: 100, onChange: (value) => onChange("wmin", value), value: filters.wmin }),
        gear ? null : h(NumberField, { id: "marketWmax", key: "wmax", label: "Max weight (g)", max: 200, min: 100, onChange: (value) => onChange("wmax", value), value: filters.wmax }),
        h(NumberField, { id: "marketPmin", key: "pmin", label: "Min price ($)", max: 1000, min: 0, onChange: (value) => onChange("pmin", value), value: filters.pmin }),
        h(NumberField, { id: "marketPmax", key: "pmax", label: "Max price ($)", max: 1000, min: 0, onChange: (value) => onChange("pmax", value), value: filters.pmax }),
        h("label", { className: "market-check", key: "trade" }, [
          h("input", { checked: filters.trade, key: "input", onChange: (event) => onChange("trade", event.target.checked), type: "checkbox" }),
          "Open to trade",
        ]),
      ]),
      active ? h("button", { className: "shop-filter-reset", key: "reset", onClick: onReset, type: "button" }, "Clear filters") : null,
    ]),
  ]);
}

function useDebounced(value, delay) {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function MarketBrowse({ route }) {
  const seller = route.query.get("seller") || "";
  const [filters, setFilters] = React.useState(() => ({ ...EMPTY_FILTERS, seller }));
  const [state, setState] = React.useState({ status: "loading", listings: [], more: false, facets: { brands: [], plastics: [] } });
  const [attempt, setAttempt] = React.useState(0);
  const query = useDebounced(listingsQuery({ ...filters, seller }), 250);

  React.useEffect(() => {
    setFilters((current) => (current.seller === seller ? current : { ...current, seller }));
  }, [seller]);

  React.useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: "loading" }));
    marketRequest("/market/listings" + query, { signal: controller.signal }).then(({ ok, data }) => {
      if (!ok || !Array.isArray(data.listings)) {
        setState((current) => ({ ...current, status: "error" }));
        return;
      }
      setState((current) => ({
        status: "ready", listings: data.listings, more: data.more === true,
        facets: data.facets && typeof data.facets === "object" ? data.facets : current.facets,
      }));
    }).catch(() => {});
    return () => controller.abort();
  }, [query, attempt]);

  async function loadMore() {
    const offset = state.listings.length;
    const { ok, data } = await marketRequest("/market/listings" + listingsQuery({ ...filters, seller }, offset));
    if (ok && Array.isArray(data.listings)) {
      setState((current) => ({ ...current, listings: current.listings.concat(data.listings), more: data.more === true }));
    }
  }

  // Bags and accessories: the disc-only filters (hidden for them) are cleared too.
  const change = (key, value) => setFilters((current) => (key === "kind" && (value === "bag" || value === "accessory")
    ? { ...current, kind: value, type: "", plastic: "", wmin: "", wmax: "" }
    : { ...current, [key]: value }));
  const reset = () => setFilters((current) => ({ ...EMPTY_FILTERS, q: current.q, sort: current.sort, seller }));
  const sellerName = seller && state.listings[0]?.seller?.name;

  return h("section", { "data-market-state": state.status, "data-market-view": "browse" }, [
    h("div", { className: "shop-catalog-bar", key: "bar" }, [
      h("h2", { key: "title" }, "Used discs"),
      h("a", { className: "shop-cart-link", href: "#market/sell", key: "sell" }, "Sell a disc"),
    ]),
    seller ? h("p", { className: "market-note market-seller-filter", key: "seller" }, [
      sellerName ? `Showing discs from ${sellerName}. ` : "Showing one seller's discs. ",
      h("a", { className: "market-link", href: "#market", key: "all" }, "Show everyone's discs"),
    ]) : null,
    h(BrowseFilters, { facets: state.facets, filters, key: "filters", onChange: change, onReset: reset }),
    state.status === "error" ? h(LoadState, { key: "error", onRetry: () => setAttempt((value) => value + 1), state: "error" })
      : state.status === "loading" && !state.listings.length ? h(LoadState, { key: "loading", loading: "Loading used discs…", state: "loading" })
        : h("div", { className: "product-grid market-grid", key: "grid" }, state.listings.length
          ? state.listings.map((listing) => h(ListingCard, { key: listing.id, listing }))
          : h("p", { className: "public-state", role: "status" }, activeFilterCount(filters) || filters.q
            ? "No discs match those filters." : "No used discs are listed right now. Members can list one with Sell a disc.")),
    state.more ? h("button", { className: "shop-filter-reset market-more", key: "more", onClick: loadMore, type: "button" }, "Show more") : null,
  ]);
}
