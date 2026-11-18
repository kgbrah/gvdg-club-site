import React from "react";

import {
  CONDITION_LEGEND, DISC_TYPES, LIMITS, listingTitle, shortDate, wantedHref, wantedMeta, wantedPayload,
} from "../shared/market-model.js";
import { errorMessage, marketRequest } from "./market-api.js";
import {
  IdentityStrip, LoadState, Note, ReportControl, StatusLine, TraderLine, useAction, useIdentityGate, useIdentityVersion, useMarketConfig,
} from "./market-ui.js";
import { announceMarketChange } from "./market-listing.js";
import { BrandPick, MoldInput, PlasticPick, VoiceDiscButton, WeightPick } from "./disc-fields.js";

const h = React.createElement;

const WANTED_STATUS = { open: "Open", closed: "Closed", expired: "Expired" };

function wantedTitle(wanted) {
  return wanted?.title || [wanted?.brand, wanted?.plastic, wanted?.mold].filter(Boolean).join(" ") || "Disc";
}

export function WantedCard({ wanted }) {
  return h("article", { className: "product-card market-wanted-card", "data-market-wanted": wanted.id }, [
    h("div", { className: "product-body", key: "body" }, [
      h("span", { className: "market-kicker", key: "kicker" }, "WANTED"),
      h("a", { className: "product-name market-card-title", href: wantedHref(wanted.id), key: "title" }, wantedTitle(wanted)),
      wantedMeta(wanted) ? h("div", { className: "product-meta", key: "meta" }, wantedMeta(wanted)) : null,
      wanted.openToTrade ? h("span", { className: "market-badge", key: "trade" }, "Open to trades") : null,
      wanted.notes ? h("p", { className: "product-meta market-clamp", key: "notes" }, wanted.notes) : null,
      h("div", { className: "product-meta market-card-seller", key: "poster" }, h(TraderLine, { link: false, trader: wanted.poster })),
      h("div", { className: "product-meta", key: "when" }, [
        "Posted " + shortDate(wanted.createdAt),
        wanted.status !== "open" ? " · " + (WANTED_STATUS[wanted.status] || wanted.status) : "",
        wanted.mine && wanted.replyCount ? ` · ${wanted.replyCount} ${wanted.replyCount === 1 ? "reply" : "replies"}` : "",
      ]),
    ]),
  ]);
}

export function MarketWantedList({ route }) {
  const [q, setQ] = React.useState(route.query.get("q") || "");
  const [type, setType] = React.useState("");
  const [state, setState] = React.useState({ status: "loading", wanted: [], more: false });
  const [attempt, setAttempt] = React.useState(0);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim().slice(0, 60));
      if (type) params.set("type", type);
      setQuery(params.size ? "?" + params : "");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, type]);

  React.useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: "loading" }));
    marketRequest("/market/wanted" + query, { signal: controller.signal }).then(({ ok, data }) => {
      if (ok && Array.isArray(data.wanted)) setState({ status: "ready", wanted: data.wanted, more: data.more === true });
      else setState((current) => ({ ...current, status: "error" }));
    }).catch(() => {});
    return () => controller.abort();
  }, [query, attempt]);

  async function loadMore() {
    const params = new URLSearchParams(query.slice(1));
    params.set("offset", String(state.wanted.length));
    const { ok, data } = await marketRequest("/market/wanted?" + params);
    if (ok && Array.isArray(data.wanted)) setState((current) => ({ ...current, wanted: current.wanted.concat(data.wanted), more: data.more === true }));
  }

  return h("section", { "data-market-state": state.status, "data-market-view": "wanted" }, [
    h("div", { className: "shop-catalog-bar", key: "bar" }, [
      h("h2", { key: "title" }, "WANTED"),
      h("a", { className: "shop-cart-link", href: "#wanted/new", key: "new" }, "Post a WANTED"),
    ]),
    h(Note, { key: "intro" }, "Looking for a certain mold, plastic or weight? Post it here. Sellers who have one reply with \"I have one\"."),
    h("div", { "aria-label": "WANTED filters", className: "filters shop-filters", key: "filters" }, h("div", { className: "shop-search-row" }, [
      h("label", { className: "public-sr-only", htmlFor: "wantedSearch", key: "search-label" }, "Search WANTED posts"),
      h("input", { id: "wantedSearch", key: "search", maxLength: 60, onChange: (event) => setQ(event.target.value), placeholder: "Search WANTED", type: "search", value: q }),
      h("label", { className: "public-sr-only", htmlFor: "wantedType", key: "type-label" }, "Disc type"),
      h("select", { id: "wantedType", key: "type", onChange: (event) => setType(event.target.value), value: type }, [
        h("option", { key: "any", value: "" }, "All types"),
        ...DISC_TYPES.map(([value, text]) => h("option", { key: value, value }, text)),
      ]),
    ])),
    state.status === "error" ? h(LoadState, { key: "error", onRetry: () => setAttempt((value) => value + 1), state: "error" })
      : state.status === "loading" && !state.wanted.length ? h(LoadState, { key: "loading", loading: "Loading WANTED posts…", state: "loading" })
        : h("div", { className: "product-grid market-grid", key: "grid" }, state.wanted.length
          ? state.wanted.map((wanted) => h(WantedCard, { key: wanted.id, wanted }))
          : h("p", { className: "public-state", role: "status" }, q || type ? "No WANTED posts match." : "No WANTED posts right now.")),
    state.more ? h("button", { className: "shop-filter-reset market-more", key: "more", onClick: loadMore, type: "button" }, "Show more") : null,
  ]);
}

function ReplyForm({ wanted, onSent, onClose }) {
  const [mine, setMine] = React.useState([]);
  const [listingId, setListingId] = React.useState("");
  const [body, setBody] = React.useState("");
  const action = useAction();
  const fieldId = React.useId();

  React.useEffect(() => {
    const controller = new AbortController();
    marketRequest("/market/me", { signal: controller.signal }).then(({ ok, data }) => {
      if (ok && Array.isArray(data.listings)) setMine(data.listings.filter((row) => row.status === "active" && !row.hidden));
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  async function send(event) {
    event.preventDefault();
    if (!body.trim()) {
      action.setMessage({ text: "Add a short message for the poster.", tone: "error" });
      return;
    }
    await action.run(async () => {
      const payload = { body: body.trim(), ...(listingId ? { listingId: Number(listingId) } : {}) };
      const { ok, data } = await marketRequest(`/market/wanted/${wanted.id}/replies`, { body: payload, method: "POST" });
      if (ok) {
        setBody("");
        setListingId("");
        action.setMessage({ text: "Sent. The poster will get your message.", tone: "success" });
        onSent?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }

  return h("form", { "aria-label": "I have one", className: "market-form market-reply-form", noValidate: true, onSubmit: send }, [
    h("h3", { className: "market-subhead", key: "title" }, "I have one"),
    mine.length ? h("div", { className: "market-field", key: "listing" }, [
      h("label", { htmlFor: fieldId, key: "label" }, "Link one of your listings (optional)"),
      h("select", { id: fieldId, key: "select", onChange: (event) => setListingId(event.target.value), value: listingId }, [
        h("option", { key: "none", value: "" }, "No listing"),
        ...mine.map((row) => h("option", { key: row.id, value: String(row.id) }, listingTitle(row))),
      ]),
    ]) : h(Note, { key: "none" }, ["Tip: ", h("a", { className: "market-link", href: "#market/sell", key: "sell" }, "list the disc"), " first so the poster can buy it here."]),
    h("label", { key: "body" }, ["Message", h("textarea", {
      key: "input", maxLength: LIMITS.reply, onChange: (event) => setBody(event.target.value), placeholder: "I have a 175g Star Destroyer, 8/10.", rows: 3, value: body,
    })]),
    h("div", { className: "market-actions", key: "actions" }, [
      h("button", { className: "shop-btn", disabled: action.busy, key: "send", type: "submit" }, action.busy ? "Sending…" : "Send reply"),
      onClose ? h("button", { className: "shop-filter-reset", key: "cancel", onClick: onClose, type: "button" }, "Cancel") : null,
    ]),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

function HaveOne({ wanted, onSent }) {
  const [open, setOpen] = React.useState(false);
  if (!open) return h("button", { className: "shop-btn market-have-one", onClick: () => setOpen(true), type: "button" }, "I have one");
  return h(ReplyForm, { onClose: () => setOpen(false), onSent, wanted });
}

export function WantedReplies({ replies }) {
  if (!Array.isArray(replies) || !replies.length) return h(Note, null, "No replies yet.");
  return h("ul", { className: "market-replies" }, replies.map((reply) => h("li", { className: "market-reply", "data-market-reply": reply.id, key: reply.id }, [
    h("p", { className: "market-deal-who", key: "from" }, [h(TraderLine, { key: "who", trader: reply.from }), " · " + shortDate(reply.createdAt)]),
    h("p", { className: "market-quote", key: "body" }, reply.body),
    reply.listing ? h("a", { className: "shop-btn secondary", href: "#market/listing/" + reply.listing.id, key: "listing" }, "See " + (reply.listing.title || "the listing")) : null,
  ])));
}

export function CloseWantedButton({ wanted, onDone }) {
  const action = useAction();
  async function close() {
    await action.run(async () => {
      const { ok, data } = await marketRequest(`/market/wanted/${wanted.id}/close`, { body: {}, method: "POST" });
      if (ok) {
        announceMarketChange();
        onDone?.();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }
  return h(React.Fragment, null, [
    h("button", { className: "shop-filter-reset", disabled: action.busy, key: "close", onClick: close, type: "button" }, "Close this post"),
    h(StatusLine, { key: "status", message: action.message }),
  ]);
}

export function MarketWantedDetail({ id }) {
  const [state, setState] = React.useState({ status: "loading", wanted: null, viewer: null });
  const [attempt, setAttempt] = React.useState(0);
  const identity = useIdentityVersion();
  React.useEffect(() => {
    const controller = new AbortController();
    marketRequest("/market/wanted/" + id, { signal: controller.signal }).then(({ ok, status, data }) => {
      if (ok && data.wanted) setState({ status: "ready", wanted: data.wanted, viewer: data.viewer || null });
      else setState({ status: status === 404 ? "missing" : "error", wanted: null, viewer: null });
    }).catch(() => {});
    return () => controller.abort();
  }, [id, attempt, identity]);
  const reload = () => setAttempt((value) => value + 1);
  const wanted = state.wanted;
  const viewer = state.viewer || { kind: "public" };
  return h("section", { "data-market-state": state.status, "data-market-view": "wanted-detail" }, [
    h("a", { className: "market-back", href: "#wanted", key: "back" }, "← All WANTED posts"),
    state.status === "missing" ? h("p", { className: "public-state", key: "missing", role: "status" }, "This WANTED post is no longer up.") : null,
    state.status === "loading" || state.status === "error" ? h(LoadState, { key: "load", onRetry: reload, state: state.status }) : null,
    wanted ? h("div", { className: "my-orders-panel market-panel market-wanted-detail", key: "panel" }, [
      h("span", { className: "market-kicker", key: "kicker" }, "WANTED"),
      h("h2", { className: "market-title", key: "title" }, wantedTitle(wanted)),
      wanted.status !== "open" ? h("span", { className: "market-chip", key: "status" }, WANTED_STATUS[wanted.status] || wanted.status) : null,
      wanted.hidden ? h("span", { className: "market-chip market-chip-hidden", key: "hidden" }, "Hidden by admin") : null,
      h("dl", { className: "market-facts", key: "facts" }, [
        ["Brand", wanted.brand], ["Mold", wanted.mold], ["Plastic", wanted.plastic],
        ["Looking for", wantedMeta(wanted)], ["Trades", wanted.openToTrade ? "Open to trades" : ""], ["Notes", wanted.notes],
        ["Posted", shortDate(wanted.createdAt)], ["Expires", wanted.status === "open" ? shortDate(wanted.expiresAt) : ""],
      ].filter(([, value]) => value).map(([label, value]) => h("div", { className: "market-fact", key: label }, [h("dt", { key: "dt" }, label), h("dd", { key: "dd" }, value)]))),
      h("p", { className: "market-deal-who", key: "poster" }, ["Posted by ", h(TraderLine, { key: "who", trader: wanted.poster })]),
      h(IdentityStrip, { key: "identity", viewer }),
      wanted.mine ? h("div", { className: "market-owner", key: "owner" }, [
        h("h3", { className: "market-subhead", key: "title" }, "Replies"),
        h(WantedReplies, { key: "replies", replies: wanted.replies }),
        wanted.status === "open" ? h(CloseWantedButton, { key: "close", onDone: reload, wanted }) : null,
      ]) : wanted.status === "open"
        ? (viewer.kind === "member"
          ? h(HaveOne, { key: "reply", onSent: reload, wanted })
          : h("div", { className: "market-reply-locked", key: "locked" }, [
            h(Note, { key: "note" }, "Have one? Club members can reply with a listed disc. Members can sign in."),
            h("a", { className: "shop-btn secondary", href: "gvdg-members.html", key: "sign-in" }, "Members sign in"),
          ]))
        : null,
      !wanted.mine ? h(ReportControl, { id: wanted.id, key: "report", kind: "wanted", label: "Report this post", viewer }) : null,
    ]) : null,
  ]);
}

const EMPTY_WANTED = { brand: "", mold: "", plastic: "", discType: "", weightMin: "", weightMax: "", conditionMin: "", maxPrice: "", openToTrade: false, notes: "" };

export function MarketWantedNew() {
  const config = useMarketConfig();
  const [draft, setDraft] = React.useState(EMPTY_WANTED);
  const action = useAction();
  const identity = useIdentityGate(config.viewer);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const heard = (fields) => setDraft((current) => {
    const next = { ...current };
    for (const key of ["brand", "mold", "plastic"]) if (fields[key]) next[key] = fields[key];
    return next;
  });

  async function post() {
    const parsed = wantedPayload(draft);
    if (!parsed.ok) {
      action.setMessage({ text: parsed.message, tone: "error" });
      document.getElementById("wanted-" + parsed.field)?.focus();
      return;
    }
    await action.run(async () => {
      const { ok, data } = await marketRequest("/market/wanted", { body: parsed.value, method: "POST" });
      if (ok && data.wanted) {
        announceMarketChange();
        window.location.hash = "wanted/" + data.wanted.id;
      } else action.setMessage({ text: data.error === "invalid_wanted" ? "Check the " + (data.field || "form") + " field." : errorMessage(data), tone: "error" });
    });
  }

  const field = (key, label, input) => h("div", { className: "market-field", key }, [h("label", { htmlFor: "wanted-" + key, key: "label" }, label), input]);
  const text = (key, extra = {}) => h("input", { id: "wanted-" + key, key: "input", maxLength: LIMITS[key] || 40, onChange: (event) => set(key, event.target.value), type: "text", value: draft[key], ...extra });

  return h("section", { "data-market-state": config.status === "loading" ? "loading" : "ready", "data-market-view": "wanted-new" }, [
    h("a", { className: "market-back", href: "#wanted", key: "back" }, "← All WANTED posts"),
    h("div", { className: "shop-catalog-bar", key: "bar" }, h("h2", null, "Post a WANTED")),
    h(IdentityStrip, { key: "identity", viewer: config.viewer }),
    h("form", {
      "aria-label": "Post a WANTED", className: "my-orders-panel market-panel market-form", key: "form", noValidate: true,
      onSubmit: (event) => { event.preventDefault(); identity.require("Verify your email to post a WANTED", post); },
    }, [
      h(VoiceDiscButton, { example: "Try: “Champion Teebird3.”", key: "voice", onFields: heard }),
      h("div", { className: "market-grid-2", key: "names" }, [
        h(BrandPick, { id: "wanted-brand", key: "brand", maxLength: LIMITS.brand, onChange: (value) => set("brand", value), placeholder: "Any brand", value: draft.brand }),
        h(MoldInput, { brand: draft.brand, id: "wanted-mold", key: "mold", maxLength: LIMITS.mold, onChange: (value) => set("mold", value), placeholder: "Destroyer", value: draft.mold }),
        h(PlasticPick, { brand: draft.brand, id: "wanted-plastic", key: "plastic", maxLength: LIMITS.plastic, onChange: (value) => set("plastic", value), placeholder: "Any plastic", value: draft.plastic }),
        field("discType", "Disc type", h("select", { id: "wanted-discType", key: "input", onChange: (event) => set("discType", event.target.value), value: draft.discType }, [
          h("option", { key: "any", value: "" }, "Any"), ...DISC_TYPES.map(([value, label]) => h("option", { key: value, value }, label)),
        ])),
        h(WeightPick, { id: "wanted-weightMin", key: "weightMin", label: "Min weight (g)", onChange: (value) => set("weightMin", value), placeholder: "Any", value: draft.weightMin }),
        h(WeightPick, { id: "wanted-weightMax", key: "weightMax", label: "Max weight (g)", onChange: (value) => set("weightMax", value), placeholder: "Any", value: draft.weightMax }),
        field("conditionMin", "Condition at least", h("select", { id: "wanted-conditionMin", key: "input", onChange: (event) => set("conditionMin", event.target.value), value: draft.conditionMin }, [
          h("option", { key: "any", value: "" }, "Any"), ...CONDITION_LEGEND.map(([score, label]) => h("option", { key: score, value: String(score) }, `${score} · ${label}`)),
        ])),
        field("maxPrice", "Max price (USD)", h("input", { id: "wanted-maxPrice", inputMode: "decimal", key: "input", onChange: (event) => set("maxPrice", event.target.value), placeholder: "20", type: "text", value: draft.maxPrice })),
      ]),
      h("label", { className: "market-check", key: "trade" }, [
        h("input", { checked: draft.openToTrade, key: "input", onChange: (event) => set("openToTrade", event.target.checked), type: "checkbox" }), "Open to trades",
      ]),
      field("notes", "Notes", h("textarea", { id: "wanted-notes", key: "input", maxLength: LIMITS.notes, onChange: (event) => set("notes", event.target.value), rows: 3, value: draft.notes })),
      h(Note, { key: "expiry" }, "Posts stay up for 60 days. You can close yours any time."),
      h("button", { className: "shop-btn", disabled: action.busy, key: "submit", type: "submit" }, action.busy ? "Posting…" : "Post WANTED"),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
    identity.gate,
  ]);
}
