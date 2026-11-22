import React from "react";

import {
  clubShareText, conditionText, flightText, itemKindLabel, listingTitle, money, PENDING_NOTE, priceLine, withdrawnLabel,
} from "../shared/market-model.js";
import { errorMessage, marketRequest } from "./market-api.js";
import {
  GuestGate, IdentityStrip, LoadState, MarketPhoto, Note, PayOptions, ReportControl, SafetyNote, StatusChip, StatusLine,
  TraderLine, useAction, useIdentityGate, useIdentityVersion,
} from "./market-ui.js";

const h = React.createElement;

export function announceMarketChange() {
  window.dispatchEvent(new CustomEvent("gvdg:market-changed"));
}

function Gallery({ listing }) {
  // A withdrawn listing's photos are kept for relisting but are not served while it's down.
  const photos = listing.status !== "withdrawn" && Array.isArray(listing.photos) && listing.photos.length ? listing.photos : [null];
  const [index, setIndex] = React.useState(0);
  const current = photos[Math.min(index, photos.length - 1)];
  const title = listingTitle(listing);
  return h("div", { className: "market-gallery", key: "gallery" }, [
    h(MarketPhoto, { alt: title + (photos.length > 1 ? `, photo ${index + 1} of ${photos.length}` : ""), className: "product-img market-gallery-main", key: "main", photo: current }),
    photos.length > 1 ? h("div", { className: "market-thumbs", key: "thumbs" }, photos.map((photo, position) => h("button", {
      "aria-label": `Show photo ${position + 1}`,
      "aria-pressed": position === index ? "true" : "false",
      className: "market-thumb",
      key: photo?.id || position,
      onClick: () => setIndex(position),
      type: "button",
    }, h(MarketPhoto, { alt: "", className: "market-thumb-img", photo })))) : null,
  ]);
}

function Facts({ listing }) {
  const rows = [
    ["Type", itemKindLabel(listing)],
    ["Brand", listing.brand],
    ["Plastic", listing.plastic],
    ["Weight", listing.weightG ? listing.weightG + "g" : ""],
    ["Color", listing.color],
    ["Flight", flightText(listing.flight)],
    ["Condition", conditionText(listing.condition, listing.itemKind)],
    ["For the club", clubShareText(listing.clubShare)],
    ["Condition notes", listing.conditionNotes],
    ["Quantity", listing.quantity > 1 ? String(listing.quantity) : ""],
    ["Pickup", listing.location],
    ["Would trade for", listing.openToTrade ? listing.tradeFor || "Open to offers" : ""],
  ].filter(([, value]) => value);
  return h("dl", { className: "market-facts" }, rows.map(([label, value]) => h("div", { className: "market-fact", key: label }, [
    h("dt", { key: "dt" }, label), h("dd", { key: "dd" }, value),
  ])));
}

function OfferedList({ offered }) {
  if (!Array.isArray(offered) || !offered.length) return null;
  return h("ul", { className: "market-offered" }, offered.map((item) => h("li", { key: item.id }, h("a", { className: "market-link", href: "#market/listing/" + item.id }, item.title))));
}

export function SellerDealPanel({ deal, onDone }) {
  const action = useAction();
  async function act(path, body, success) {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/deals/${deal.id}/${path}`, { body: body || {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: success, tone: "success" });
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h("div", { className: "market-deal", "data-market-deal": deal.id, "data-deal-role": "seller" }, [
    h("p", { className: "market-deal-who", key: "who" }, [
      deal.kind === "trade" ? "Trade with " : "Buyer: ",
      h(TraderLine, { key: "buyer", trader: deal.buyer }),
    ]),
    h("p", { className: "market-note", key: "what" }, deal.kind === "trade"
      ? "You accepted this trade. Mark it traded once you've swapped."
      : `Committed to buy ${deal.listingTitle || "this disc"} for ${money(deal.priceCents)}. Mark it sold once you're paid.`),
    deal.offerText ? h("p", { className: "market-quote", key: "text" }, deal.offerText) : null,
    h(OfferedList, { key: "offered", offered: deal.offered }),
    h("div", { className: "market-actions", key: "actions" }, [
      h("button", { className: "shop-btn", disabled: action.busy, key: "sold", onClick: () => act("complete", { outcome: "sold" }, "Marked sold. Leave feedback (and send any club donation) in My marketplace."), type: "button" }, "Mark sold"),
      h("button", { className: "shop-btn secondary", disabled: action.busy, key: "traded", onClick: () => act("complete", { outcome: "traded" }, "Marked traded. Leave feedback in My marketplace."), type: "button" }, "Mark traded"),
      h("button", { className: "shop-filter-reset", disabled: action.busy, key: "release", onClick: () => act("release", {}, "Released. The listing is active again."), type: "button" }, "Release"),
    ]),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function BuyerDealPanel({ deal, onDone, showTitle = false }) {
  const action = useAction();
  const [confirming, setConfirming] = React.useState(false);
  async function cancel() {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/deals/${deal.id}/cancel`, { body: {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: "Purchase cancelled.", tone: "success" });
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h("div", { className: "market-deal market-deal-buyer", "data-market-deal": deal.id, "data-deal-role": "buyer" }, [
    h("h3", { className: "market-subhead", key: "title" }, showTitle ? "Buying " + (deal.listingTitle || "a disc") : "You're buying this"),
    h("p", { className: "market-deal-who", key: "who" }, ["Seller: ", h(TraderLine, { key: "seller", trader: deal.seller })]),
    deal.kind === "trade"
      ? h(Note, { key: "trade" }, "The seller accepted your trade. Arrange the swap with them.")
      : h(PayOptions, { key: "pay", pay: deal.pay }),
    h(Note, { key: "pickup" }, "Arrange pickup or shipping with the seller. The seller marks it done once they're paid."),
    confirming
      ? h("div", { className: "market-actions", key: "confirm" }, [
        h("button", { className: "shop-btn secondary", disabled: action.busy, key: "yes", onClick: cancel, type: "button" }, "Yes, cancel"),
        h("button", { className: "shop-filter-reset", key: "no", onClick: () => setConfirming(false), type: "button" }, "Keep it"),
      ])
      : h("button", { className: "shop-filter-reset", key: "cancel", onClick: () => setConfirming(true), type: "button" }, "Cancel my purchase"),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function OfferRow({ offer, onDone, role = "seller" }) {
  const action = useAction();
  async function act(path, success) {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/offers/${offer.id}/${path}`, { body: {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: success, tone: "success" });
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h("li", { className: "market-offer", "data-market-offer": offer.id, "data-offer-status": offer.status }, [
    h("p", { className: "market-deal-who", key: "who" }, role === "seller"
      ? ["Trade offer from ", h(TraderLine, { key: "buyer", trader: offer.buyer })]
      : ["Your offer on ", h("a", { className: "market-link", href: "#market/listing/" + offer.listingId, key: "link" }, offer.listingTitle || "a disc")]),
    offer.text ? h("p", { className: "market-quote", key: "text" }, offer.text) : null,
    h(OfferedList, { key: "offered", offered: offer.offered }),
    offer.status !== "open" ? h("p", { className: "market-note", key: "status" }, "Offer " + offer.status) : null,
    offer.status === "open" ? h("div", { className: "market-actions", key: "actions" }, role === "seller" ? [
      h("button", { className: "shop-btn", disabled: action.busy, key: "accept", onClick: () => act("accept", "Trade accepted. The listing is pending."), type: "button" }, "Accept trade"),
      h("button", { className: "shop-filter-reset", disabled: action.busy, key: "decline", onClick: () => act("decline", "Offer declined."), type: "button" }, "Decline"),
    ] : [
      h("button", { className: "shop-filter-reset", disabled: action.busy, key: "withdraw", onClick: () => act("withdraw", "Offer withdrawn."), type: "button" }, "Withdraw offer"),
    ]) : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

function TradeOfferForm({ listing, viewer, onSent, onClose }) {
  const [mine, setMine] = React.useState([]);
  const [picked, setPicked] = React.useState([]);
  const [text, setText] = React.useState("");
  const action = useAction();

  React.useEffect(() => {
    if (viewer?.kind !== "member") return undefined;
    const controller = new AbortController();
    marketRequest("/market/me", { signal: controller.signal }).then(({ ok, data }) => {
      if (ok && Array.isArray(data.listings)) {
        setMine(data.listings.filter((row) => row.status === "active" && !row.hidden && row.id !== listing.id));
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [listing.id, viewer?.kind]);

  async function send(event) {
    event.preventDefault();
    if (!picked.length && !text.trim()) {
      action.setMessage({ text: "Pick one of your discs or describe what you'd offer.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/listings/${listing.id}/offers`, { body: { listingIds: picked, text: text.trim() }, method: "POST" });
      if (ok) {
        announceMarketChange();
        onSent?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }

  function toggle(id, on) {
    setPicked((current) => (on ? [...new Set([...current, id])].slice(0, 4) : current.filter((value) => value !== id)));
  }

  return h("form", { "aria-label": "Propose a trade", className: "market-form market-trade-form", noValidate: true, onSubmit: send }, [
    h("h3", { className: "market-subhead", key: "title" }, "Propose a trade"),
    listing.tradeFor ? h(Note, { key: "wants" }, "The seller would trade for: " + listing.tradeFor) : null,
    mine.length ? h("fieldset", { className: "market-fieldset", key: "mine" }, [
      h("legend", { key: "legend" }, "Offer your listed discs"),
      ...mine.slice(0, 12).map((row) => h("label", { className: "market-check", key: row.id }, [
        h("input", { checked: picked.includes(row.id), key: "input", onChange: (event) => toggle(row.id, event.target.checked), type: "checkbox" }),
        listingTitle(row),
      ])),
    ]) : null,
    h("label", { key: "text" }, ["What you'd offer", h("textarea", {
      key: "input", maxLength: 300, onChange: (event) => setText(event.target.value), placeholder: "e.g. A 174g Champion Thunderbird plus $5", rows: 3, value: text,
    })]),
    h("div", { className: "market-actions", key: "actions" }, [
      h("button", { className: "shop-btn", disabled: action.busy, key: "send", type: "submit" }, action.busy ? "Sending…" : "Send trade offer"),
      h("button", { className: "shop-filter-reset", key: "close", onClick: onClose, type: "button" }, "Cancel"),
    ]),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function RelistControl({ listing, onDone }) {
  const action = useAction();
  const label = withdrawnLabel(listing);
  async function relist() {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/listings/${listing.id}/relist`, { body: {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: "Relisted. It's back on the marketplace.", tone: "success" });
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h("div", { className: "market-relist", "data-market-relist": listing.id }, [
    h("p", { className: "market-note", key: "label" }, label),
    listing.withdrawal === "pending_final" && label !== "Withdrawn"
      ? h("button", { className: "shop-btn secondary", disabled: action.busy, key: "relist", onClick: relist, type: "button" }, action.busy ? "Relisting…" : "Relist")
      : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

function SellerTools({ listing, onChange }) {
  const action = useAction();
  const [confirming, setConfirming] = React.useState(false);
  async function withdraw() {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/listings/${listing.id}/withdraw`, { body: {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: "Listing withdrawn. You can relist it within 24 hours.", tone: "success" });
        announceMarketChange();
        onChange?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h("div", { className: "market-seller-tools", "data-market-seller-tools": "true" }, [
    h("h3", { className: "market-subhead", key: "title" }, "Your listing"),
    listing.pendingDeal ? h(SellerDealPanel, { deal: listing.pendingDeal, key: "deal", onDone: onChange }) : null,
    Array.isArray(listing.offers) && listing.offers.length ? h("ul", { className: "market-offers", key: "offers" },
      listing.offers.map((offer) => h(OfferRow, { key: offer.id, offer, onDone: onChange }))) : null,
    !listing.pendingDeal && listing.status === "active" && !(listing.offers || []).length
      ? h(Note, { key: "idle" }, "No buyers yet. Buyers who tap Buy show up here and in My marketplace.") : null,
    listing.status === "withdrawn" ? h(RelistControl, { key: "relist", listing, onDone: onChange }) : null,
    listing.canEdit ? h("div", { className: "market-actions", key: "edit" }, confirming ? [
      h("button", { className: "shop-btn secondary", disabled: action.busy, key: "yes", onClick: withdraw, type: "button" }, "Yes, withdraw"),
      h("button", { className: "shop-filter-reset", key: "no", onClick: () => setConfirming(false), type: "button" }, "Keep it listed"),
    ] : [
      h("a", { className: "shop-btn secondary", href: "#market/edit/" + listing.id, key: "edit" }, "Edit listing"),
      h("button", { className: "shop-filter-reset", key: "withdraw", onClick: () => setConfirming(true), type: "button" }, "Withdraw listing"),
    ]) : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

function BuyerTools({ listing, viewer, onChange }) {
  const action = useAction();
  const identity = useIdentityGate(viewer);
  const [trading, setTrading] = React.useState(false);
  const [unlocking, setUnlocking] = React.useState(false);
  const publicViewer = viewer?.kind === "public";
  const canBuy = listing.canBuy || (publicViewer && listing.status === "active" && listing.priceCents != null);
  const canOffer = listing.canOffer || (publicViewer && listing.status === "active" && listing.openToTrade);

  async function buy() {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/listings/${listing.id}/buy`, { body: {}, method: "POST" });
      if (ok) {
        action.setMessage({ text: "You're the buyer. Pay the seller below and arrange pickup.", tone: "success" });
        announceMarketChange();
        onChange?.();
      } else {
        action.setMessage({ text: errorMessage(data), tone: "error" });
        if (data.error === "not_available") onChange?.();
      }
    });
  }

  if (listing.myDeal) {
    return h(BuyerDealPanel, { deal: listing.myDeal, onDone: onChange });
  }
  return h("div", { className: "market-buyer-tools" }, [
    listing.status === "pending" ? h("p", { className: "market-pending", key: "pending", role: "status" }, PENDING_NOTE) : null,
    canBuy ? h("button", {
      className: "shop-btn market-buy", disabled: action.busy, key: "buy", type: "button",
      onClick: () => identity.require("Verify your email to buy as a guest", buy),
    }, action.busy ? "Holding it for you…" : "Buy for " + money(listing.priceCents)) : null,
    identity.gate,
    listing.pay && listing.status === "active" ? h("div", { className: "market-pay-preview", key: "pay" }, [
      h(Note, { key: "lead" }, "Tap Buy first so the seller holds it for you, then pay."),
      h(PayOptions, { key: "options", pay: listing.pay, primary: false }),
    ]) : null,
    listing.payLocked && !identity.gate && listing.status === "active" && listing.priceCents != null ? h("div", { className: "market-pay-locked", key: "locked" }, [
      h(Note, { key: "note" }, "Sign in or verify your email to see payment options."),
      unlocking
        ? h(GuestGate, { key: "gate", onCancel: () => setUnlocking(false), onVerified: () => { setUnlocking(false); onChange?.(); }, title: "Verify your email" })
        : h("div", { className: "market-actions", key: "actions" }, [
          h("button", { className: "shop-filter-reset", key: "verify", onClick: () => setUnlocking(true), type: "button" }, "Verify as a guest"),
          h("a", { className: "market-link", href: "gvdg-members.html", key: "members" }, "Members sign in"),
        ]),
    ]) : null,
    listing.myOffer ? h("ul", { className: "market-offers", key: "my-offer" }, h(OfferRow, { offer: listing.myOffer, onDone: onChange, role: "buyer" })) : null,
    !listing.myOffer && canOffer ? (trading
      ? h(TradeOfferForm, { key: "trade", listing, onClose: () => setTrading(false), onSent: () => { setTrading(false); onChange?.(); }, viewer })
      : h("button", {
        className: "shop-btn secondary", key: "trade-open", type: "button",
        onClick: () => identity.require("Verify your email to propose a trade", () => setTrading(true)),
      }, "Propose a trade")) : null,
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function MarketListing({ id }) {
  const [state, setState] = React.useState({ status: "loading", listing: null, viewer: null });
  const [attempt, setAttempt] = React.useState(0);
  const identity = useIdentityVersion();

  React.useEffect(() => {
    const controller = new AbortController();
    marketRequest("/market/listings/" + id, { signal: controller.signal }).then(({ ok, status, data }) => {
      if (ok && data.listing) setState({ status: "ready", listing: data.listing, viewer: data.viewer || null });
      else setState({ status: status === 404 ? "missing" : "error", listing: null, viewer: null });
    }).catch(() => {});
    return () => controller.abort();
  }, [id, attempt, identity]);

  const reload = React.useCallback(() => setAttempt((value) => value + 1), []);
  const listing = state.listing;
  const viewer = state.viewer || { kind: "public" };

  return h("section", { "data-market-state": state.status, "data-market-view": "listing" }, [
    h("a", { className: "market-back", href: "#market", key: "back" }, "← All used discs"),
    state.status === "missing" ? h("p", { className: "public-state", key: "missing", role: "status" }, "This listing is no longer available.") : null,
    state.status === "loading" || state.status === "error" ? h(LoadState, { key: "load", onRetry: reload, state: state.status, loading: "Loading listing…" }) : null,
    listing ? h("div", { className: "market-detail", key: "detail" }, [
      h(Gallery, { key: "gallery", listing }),
      h("div", { className: "my-orders-panel market-panel market-info", key: "info" }, [
        h(StatusChip, { hidden: listing.hidden, key: "chip", status: listing.status }),
        h("h2", { className: "market-title", key: "title" }, listingTitle(listing)),
        h("p", { className: "product-price market-price", key: "price" }, [
          priceLine(listing),
          listing.openToTrade && listing.priceCents != null ? h("span", { className: "market-badge", key: "trade" }, "Open to trades") : null,
        ]),
        h(Facts, { key: "facts", listing }),
        h("p", { className: "market-deal-who", key: "seller" }, ["Seller: ", h(TraderLine, { key: "trader", showPhoto: true, trader: listing.seller })]),
        h(IdentityStrip, { key: "identity", viewer }),
        listing.mine
          ? h(SellerTools, { key: "seller-tools", listing, onChange: reload })
          : h(BuyerTools, { key: "buyer-tools", listing, onChange: reload, viewer }),
        h(SafetyNote, { key: "safety" }),
        !listing.mine && listing.canReport !== false ? h(ReportControl, { id: listing.id, key: "report", kind: "listing", label: "Report this listing", viewer }) : null,
      ]),
    ]) : null,
  ]);
}
