import React from "react";

import { cleanHandleInput, listingHref, listingMeta, listingTitle, priceLine, shortDate, validateSettings, wantedHref, SELLER_EMAIL_LABEL, zelleDisplay } from "../shared/market-model.js";
import { errorMessage, marketRequest } from "./market-api.js";
import { FeedbackForm, FeedbackItem } from "./market-feedback.js";
import { BuyerDealPanel, OfferRow, RelistControl, SellerDealPanel } from "./market-listing.js";
import {
  GuestGate, IdentityStrip, LoadState, MarketPhoto, Note, StatusChip, StatusLine, TraderLine, useAction, useIdentityVersion, useMarketConfig,
} from "./market-ui.js";
import { CloseWantedButton, WantedReplies } from "./market-wanted.js";

const h = React.createElement;

function Panel({ id, title, count, children }) {
  return h("section", { "aria-label": title, className: "my-orders-panel market-panel", "data-market-section": id }, [
    h("h3", { className: "my-orders-title", key: "title" }, count ? `${title} (${count})` : title),
    children,
  ]);
}

function MyListingRow({ listing, onChange }) {
  const withdrawn = listing.status === "withdrawn";
  return h("li", { className: "market-my-listing", "data-market-my-listing": listing.id, "data-status": listing.status }, [
    h(MarketPhoto, { alt: "", className: "market-my-thumb", key: "photo", photo: withdrawn ? null : listing.photo }),
    h("span", { className: "market-my-copy", key: "copy" }, [
      h("a", { className: "market-link", href: listingHref(listing.id), key: "title" }, listingTitle(listing)),
      h("small", { className: "product-meta", key: "meta" }, [priceLine(listing), listingMeta(listing)].filter(Boolean).join(" · ")),
      withdrawn ? h(RelistControl, { key: "relist", listing, onDone: onChange }) : h(StatusChip, { hidden: listing.hidden, key: "status", status: listing.status }),
    ]),
  ]);
}

function DealTitle({ deal }) {
  return h("a", { className: "market-link market-deal-title", href: listingHref(deal.listingId) }, deal.listingTitle || "Listing");
}

function counterpart(deal) {
  return deal.role === "seller" ? deal.buyer : deal.seller;
}

function FeedbackToLeave({ deal, onDone }) {
  return h("li", { className: "market-deal", "data-market-feedback-deal": deal.id }, [
    h("p", { className: "market-deal-who", key: "who" }, [
      h(DealTitle, { deal, key: "title" }),
      ` · ${deal.outcome === "traded" ? "traded" : "sold"} ${deal.role === "seller" ? "to" : "by"} `,
      h(TraderLine, { key: "who", trader: counterpart(deal) }),
    ]),
    deal.feedback?.leaveUntil ? h("small", { className: "market-hint", key: "until" }, "Leave feedback by " + shortDate(deal.feedback.leaveUntil)) : null,
    h(FeedbackForm, { dealId: deal.id, key: "form", onDone }),
  ]);
}

function RecentDeal({ deal, onChange }) {
  const mine = deal.feedback?.mine;
  const theirs = deal.feedback?.theirs;
  return h("li", { className: "market-deal", "data-market-recent-deal": deal.id }, [
    h("p", { className: "market-deal-who", key: "who" }, [
      h(DealTitle, { deal, key: "title" }),
      ` · ${deal.outcome === "traded" ? "Traded" : "Sold"} ${deal.role === "seller" ? "to" : "by"} `,
      h(TraderLine, { key: "who", trader: counterpart(deal) }),
      deal.completedAt ? " · " + shortDate(deal.completedAt) : "",
    ]),
    mine || theirs ? h("ul", { className: "market-feedback-list", key: "feedback" }, [
      mine ? h(FeedbackItem, { feedback: mine, key: "mine", onChange, showSubject: true }) : null,
      theirs ? h(FeedbackItem, { feedback: theirs, key: "theirs", onChange }) : null,
    ]) : null,
  ]);
}

function SettingsForm({ settings, onSaved }) {
  const [draft, setDraft] = React.useState(() => ({
    paypalMe: settings?.paypalMe || "", cashtag: settings?.cashtag || "", zelle: zelleDisplay(settings?.zelle || ""), notifyEmail: settings?.notifyEmail || "",
  }));
  const action = useAction();
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  async function submit(event) {
    event.preventDefault();
    const checked = validateSettings(draft);
    if (!checked.ok) {
      action.setMessage({ text: checked.message, tone: "error" });
      document.getElementById("settings-" + checked.field)?.focus();
      return;
    }
    await action.run(async () => {
      const { ok, data } = await marketRequest("/market/settings", { body: checked.value, method: "PUT" });
      if (ok && data.settings) {
        setDraft({ paypalMe: data.settings.paypalMe || "", cashtag: data.settings.cashtag || "", zelle: zelleDisplay(data.settings.zelle || ""), notifyEmail: data.settings.notifyEmail || "" });
        action.setMessage({ text: "Payment settings saved.", tone: "success" });
        onSaved?.();
      } else if (data.error === "invalid_settings") {
        action.setMessage({ text: "Check the " + ({ paypalMe: "PayPal.me", cashtag: "Cash App", zelle: "Zelle", notifyEmail: "email" }[data.field] || "payment") + " field.", tone: "error" });
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  const field = (key, label, prefix, input) => h("div", { className: "market-field", key }, [
    h("label", { htmlFor: "settings-" + key, key: "label" }, label),
    h("div", { className: "market-prefixed", key: "box" }, [prefix ? h("span", { "aria-hidden": "true", className: "market-prefix", key: "prefix" }, prefix) : null, input]),
  ]);
  return h("form", { "aria-label": "Payment settings", className: "market-form market-settings", noValidate: true, onSubmit: submit }, [
    h(Note, { key: "why" }, "Buyers pay you directly. Only the options you fill in are shown, and only to members and verified guests."),
    field("paypalMe", "PayPal.me username", "paypal.me/", h("input", {
      autoCapitalize: "none", id: "settings-paypalMe", key: "input", maxLength: 60,
      onBlur: (event) => set("paypalMe", cleanHandleInput("paypal", event.target.value)), onChange: (event) => set("paypalMe", event.target.value), type: "text", value: draft.paypalMe,
    })),
    field("cashtag", "Cash App $cashtag", "$", h("input", {
      autoCapitalize: "none", id: "settings-cashtag", key: "input", maxLength: 60,
      onBlur: (event) => set("cashtag", cleanHandleInput("cashapp", event.target.value)), onChange: (event) => set("cashtag", event.target.value), type: "text", value: draft.cashtag,
    })),
    field("zelle", "Zelle email or phone", "", h("input", {
      autoCapitalize: "none", id: "settings-zelle", key: "input", maxLength: 120, onChange: (event) => set("zelle", event.target.value), type: "text", value: draft.zelle,
    })),
    field("notifyEmail", SELLER_EMAIL_LABEL, "", h("input", {
      autoComplete: "email", id: "settings-notifyEmail", inputMode: "email", key: "input", maxLength: 120, onChange: (event) => set("notifyEmail", event.target.value), type: "email", value: draft.notifyEmail,
    })),
    h("small", { className: "market-hint", key: "private" }, "Needed before you list a disc. Buyer alerts go there; it's never shown to anyone."),
    h("button", { className: "shop-btn", disabled: action.busy, key: "save", type: "submit" }, action.busy ? "Saving…" : "Save payment settings"),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function MarketMine() {
  const config = useMarketConfig();
  const viewer = config.viewer;
  const [state, setState] = React.useState({ status: "loading", data: null });
  const [attempt, setAttempt] = React.useState(0);
  const identity = useIdentityVersion();
  const signedIn = viewer.kind === "member" || viewer.kind === "guest";

  React.useEffect(() => {
    if (config.status === "loading") return undefined;
    if (!signedIn) {
      setState({ status: "ready", data: null });
      return undefined;
    }
    const controller = new AbortController();
    marketRequest("/market/me", { signal: controller.signal }).then(({ ok, data }) => {
      setState(ok ? { status: "ready", data } : { status: "error", data: null });
    }).catch(() => {});
    return () => controller.abort();
  }, [attempt, config.status, identity, signedIn]);

  React.useEffect(() => {
    const refresh = () => setAttempt((value) => value + 1);
    window.addEventListener("gvdg:market-changed", refresh);
    return () => window.removeEventListener("gvdg:market-changed", refresh);
  }, []);

  const reload = () => setAttempt((value) => value + 1);
  const data = state.data || {};
  const list = (key) => (Array.isArray(data[key]) ? data[key] : []);
  const head = [
    h("div", { className: "shop-catalog-bar", key: "bar" }, [
      h("h2", { key: "title" }, "My marketplace"),
      viewer.kind === "member" ? h("a", { className: "shop-cart-link", href: "#market/sell", key: "sell" }, "Sell a disc") : null,
    ]),
    h(IdentityStrip, { key: "identity", viewer }),
  ];
  const status = config.status === "loading" ? "loading" : state.status;

  if (config.status !== "loading" && !signedIn) {
    return h("section", { "data-market-state": "ready", "data-market-view": "mine" }, [
      ...head,
      h("div", { className: "my-orders-panel market-panel", key: "gate" }, [
        h(Note, { key: "note" }, "Members: sign in to see your listings, deals and payment settings."),
        h("a", { className: "shop-btn", href: "gvdg-members.html", key: "sign-in" }, "Members sign in"),
        h(GuestGate, { key: "guest", title: "Bought as a guest? Verify your email" }),
      ]),
    ]);
  }

  const selling = list("selling");
  const buying = list("buying");
  const offersIn = list("offersIn");
  const offersOut = list("offersOut");
  const toLeave = list("feedbackToLeave");
  const recent = list("recentDeals");
  const listings = list("listings");
  const wanted = list("wanted");
  const waiting = Number(data.waiting) || 0;

  return h("section", { "data-market-state": status, "data-market-view": "mine" }, [
    ...head,
    status !== "ready" ? h(LoadState, { key: "load", onRetry: reload, state: status, loading: "Loading your marketplace…" }) : null,
    status === "ready" ? h(Note, { "data-market-waiting": String(waiting), key: "waiting" }, waiting
      ? `${waiting} ${waiting === 1 ? "thing is" : "things are"} waiting on you.` : "Nothing is waiting on you right now.") : null,
    status === "ready" && selling.length ? h(Panel, { count: selling.length, id: "selling", key: "selling", title: "Selling: buyers waiting" },
      h("ul", { className: "market-deals" }, selling.map((deal) => h("li", { key: deal.id }, [
        h(DealTitle, { deal, key: "title" }),
        h(SellerDealPanel, { deal, key: "panel", onDone: reload }),
      ])))) : null,
    status === "ready" && offersIn.length ? h(Panel, { count: offersIn.length, id: "offers-in", key: "offers-in", title: "Trade offers on your discs" },
      h("ul", { className: "market-offers" }, offersIn.map((offer) => h(React.Fragment, { key: offer.id }, [
        h("li", { className: "market-offer-title", key: "title" }, h("a", { className: "market-link", href: listingHref(offer.listingId) }, offer.listingTitle || "Listing")),
        h(OfferRow, { key: "row", offer, onDone: reload }),
      ])))) : null,
    status === "ready" && buying.length ? h(Panel, { count: buying.length, id: "buying", key: "buying", title: "Buying" },
      h("ul", { className: "market-deals" }, buying.map((deal) => h("li", { key: deal.id }, h(BuyerDealPanel, { deal, onDone: reload, showTitle: true }))))) : null,
    status === "ready" && offersOut.length ? h(Panel, { id: "offers-out", key: "offers-out", title: "Your trade offers" },
      h("ul", { className: "market-offers" }, offersOut.map((offer) => h(OfferRow, { key: offer.id, offer, onDone: reload, role: "buyer" })))) : null,
    status === "ready" && toLeave.length ? h(Panel, { count: toLeave.length, id: "feedback-to-leave", key: "to-leave", title: "Feedback to leave" },
      h("ul", { className: "market-deals" }, toLeave.map((deal) => h(FeedbackToLeave, { deal, key: deal.id, onDone: reload })))) : null,
    status === "ready" && recent.length ? h(Panel, { id: "recent", key: "recent", title: "Recent deals" },
      h("ul", { className: "market-deals" }, recent.map((deal) => h(RecentDeal, { deal, key: deal.id, onChange: reload })))) : null,
    status === "ready" && viewer.kind === "member" ? h(Panel, { id: "listings", key: "listings", title: "My listings" }, listings.length
      ? h("ul", { className: "market-my-listings" }, listings.map((listing) => h(MyListingRow, { key: listing.id, listing, onChange: reload })))
      : h(Note, null, ["You haven't listed a disc yet. ", h("a", { className: "market-link", href: "#market/sell", key: "sell" }, "Sell a disc")])) : null,
    status === "ready" ? h(Panel, { id: "wanted", key: "wanted", title: "My WANTED posts" }, wanted.length
      ? h("ul", { className: "market-deals" }, wanted.map((post) => h("li", { className: "market-deal", "data-market-my-wanted": post.id, key: post.id }, [
        h("p", { className: "market-deal-who", key: "title" }, [
          h("a", { className: "market-link", href: wantedHref(post.id), key: "link" }, post.title || "WANTED"),
          ` · ${post.status === "open" ? "Open until " + shortDate(post.expiresAt) : post.status === "expired" ? "Expired" : "Closed"}`,
          post.hidden ? " · Hidden by admin" : "",
        ]),
        h(WantedReplies, { key: "replies", replies: post.replies }),
        post.status === "open" ? h(CloseWantedButton, { key: "close", onDone: reload, wanted: post }) : null,
      ])))
      : h(Note, null, ["No WANTED posts. ", h("a", { className: "market-link", href: "#wanted/new", key: "new" }, "Post a WANTED")])) : null,
    status === "ready" && viewer.kind === "member" ? h(Panel, { id: "settings", key: "settings", title: "Payment settings" },
      h(SettingsForm, { onSaved: reload, settings: data.settings })) : null,
    status === "ready" && viewer.kind === "guest" ? h(Note, { key: "guest-note" }, "Guests can buy, propose trades and post WANTED. Only club members can list discs.") : null,
  ]);
}
