import React from "react";

import { resizeImageFile } from "../shared/image-resize.js";
import {
  CONDITION_LEGEND, DISC_TYPES, LIMITS, listingDraft, listingHref, listingPayload, MEMBERS_ONLY_LISTING, SELLER_EMAIL_HINT,
  SELLER_EMAIL_LABEL, validEmail,
} from "../shared/market-model.js";
import { errorMessage, marketRequest } from "./market-api.js";
import { LoadState, MarketPhoto, Note, StatusLine, useAction, useMarketConfig } from "./market-ui.js";
import { announceMarketChange } from "./market-listing.js";
import { PhotoAddButtons } from "./photo-add.js";
import { BrandPick, ColorPick, MoldInput, PlasticPick, VoiceDiscButton, WeightPick } from "./disc-fields.js";
import { plasticsFor } from "../shared/disc-catalog.js";

const h = React.createElement;
const MAX_PHOTOS = 4;
const MAX_PHOTO_DATA_URL = 2_000_000; // ~1.5 MB decoded

const EMPTY_DRAFT = {
  brand: "", mold: "", plastic: "", discType: "", speed: "", glide: "", turn: "", fade: "", weightG: "", color: "",
  condition: "", conditionNotes: "", price: "", openToTrade: false, tradeFor: "", quantity: "1", location: "",
};

function Field({ id, label, hint, children }) {
  return h("div", { className: "market-field" }, [
    h("label", { htmlFor: id, key: "label" }, label),
    children,
    hint ? h("small", { className: "market-hint", key: "hint" }, hint) : null,
  ]);
}

function textInput(id, draft, set, key, extra = {}) {
  return h("input", {
    id, key: "input", maxLength: LIMITS[key], onChange: (event) => set(key, event.target.value), type: "text", value: draft[key], ...extra,
  });
}

export function ConditionGuide() {
  return h("details", { className: "shop-filter-details market-condition-guide" }, [
    h("summary", { key: "summary" }, "Condition guide (10 new … 1 beat)"),
    h("ol", { className: "market-legend", key: "list", reversed: true }, CONDITION_LEGEND.map(([score, text]) => h("li", { key: score, value: score }, `${score} · ${text}`))),
  ]);
}

function PhotoPicker({ photos, onAdd, onRemove, busy, existing = false }) {
  const remaining = MAX_PHOTOS - photos.length;
  return h("fieldset", { className: "market-fieldset market-photos" }, [
    h("legend", { key: "legend" }, "Photos (1 to 4)"),
    photos.length ? h("ul", { className: "market-photo-list", key: "list" }, photos.map((photo, index) => h("li", { className: "market-photo-item", key: photo.key }, [
      photo.dataUrl
        ? h("img", { alt: `Photo ${index + 1}`, className: "market-photo-thumb", key: "img", src: photo.dataUrl })
        : h(MarketPhoto, { alt: `Photo ${index + 1}`, className: "market-photo-thumb", key: "img", photo: photo.remote }),
      h("button", {
        "aria-label": `Remove photo ${index + 1}`, className: "shop-filter-reset", disabled: busy || (existing && photos.length <= 1), key: "remove",
        onClick: () => onRemove(photo), type: "button",
      }, "Remove"),
    ]))) : null,
    h(PhotoAddButtons, {
      cameraHint: "The top, the bottom and any ink or rim dents.", disabled: busy, hasPhotos: photos.length > 0, key: "add",
      onFiles: (files) => onAdd(files.slice(0, remaining)), remaining,
    }),
    h("small", { className: "market-hint", key: "hint" }, "Show the top, the bottom and any ink or rim dents. Photos are resized on your phone and location data is removed."),
  ]);
}

/** A new brand clears a plastic that only belonged to the old one. */
function withBrand(current, brand) {
  const key = (value) => String(value).toLowerCase();
  const plastic = current.plastic;
  const belongsToOld = current.brand && plasticsFor(current.brand).some((name) => key(name) === key(plastic));
  const fitsNew = plasticsFor(brand).some((name) => key(name) === key(plastic));
  return { ...current, brand, plastic: plastic && belongsToOld && !fitsNew ? "" : plastic };
}

export function MarketSell({ editId = null }) {
  const config = useMarketConfig();
  const viewer = config.viewer;
  const [draft, setDraft] = React.useState(EMPTY_DRAFT);
  const [photos, setPhotos] = React.useState([]);
  const [loadState, setLoadState] = React.useState(editId ? "loading" : "ready");
  const [settingsMissing, setSettingsMissing] = React.useState(false);
  // A member needs a buyer-alert email before listing; asked for right here when it's missing.
  const [emailNeeded, setEmailNeeded] = React.useState(false);
  const [sellerEmail, setSellerEmail] = React.useState("");
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const action = useAction();
  const editing = editId != null;

  React.useEffect(() => {
    if (viewer.kind !== "member") return undefined;
    const controller = new AbortController();
    marketRequest("/market/settings", { signal: controller.signal }).then(({ ok, data }) => {
      const settings = data.settings || {};
      if (ok) {
        setSettingsMissing(!settings.paypalMe && !settings.cashtag && !settings.zelle);
        setEmailNeeded(!settings.notifyEmail);
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [viewer.kind]);

  React.useEffect(() => {
    if (!editing) return undefined;
    const controller = new AbortController();
    marketRequest("/market/listings/" + editId, { signal: controller.signal }).then(({ ok, data }) => {
      if (!ok || !data.listing || !data.listing.mine) {
        setLoadState("error");
        return;
      }
      setDraft(listingDraft(data.listing));
      setPhotos((data.listing.photos || []).map((photo) => ({ key: "remote-" + photo.id, remote: photo })));
      setLoadState(data.listing.canEdit ? "ready" : "locked");
    }).catch(() => {});
    return () => controller.abort();
  }, [editId, editing]);

  const set = (key, value) => setDraft((current) => (key === "brand" ? withBrand(current, value) : { ...current, [key]: value }));
  const heard = (fields) => setDraft((current) => {
    const next = fields.brand ? withBrand(current, fields.brand) : { ...current };
    for (const key of ["mold", "plastic", "color", "weightG"]) if (fields[key]) next[key] = fields[key];
    return next;
  });

  async function addPhotos(files) {
    setPhotoBusy(true);
    try {
      const added = [];
      for (const file of files) {
        const dataUrl = await resizeImageFile(file, 1280);
        if (!dataUrl || dataUrl.length > MAX_PHOTO_DATA_URL) {
          action.setMessage({ text: "One photo couldn't be used. Try a JPEG or PNG.", tone: "error" });
          continue;
        }
        added.push({ key: "new-" + Math.random().toString(36).slice(2), dataUrl });
      }
      if (!editing) {
        setPhotos((current) => current.concat(added).slice(0, MAX_PHOTOS));
        return;
      }
      for (const photo of added) {
        const { ok, data } = await marketRequest(`/market/listings/${editId}/photos`, { body: { image: photo.dataUrl }, method: "POST" });
        if (ok && data.listing) setPhotos((data.listing.photos || []).map((row) => ({ key: "remote-" + row.id, remote: row })));
        else action.setMessage({ text: errorMessage(data), tone: "error" });
      }
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto(photo) {
    if (!editing || !photo.remote) {
      setPhotos((current) => current.filter((item) => item.key !== photo.key));
      return;
    }
    setPhotoBusy(true);
    const { ok, data } = await marketRequest(`/market/listings/${editId}/photos/${photo.remote.id}`, { method: "DELETE" });
    setPhotoBusy(false);
    if (ok && data.listing) setPhotos((data.listing.photos || []).map((row) => ({ key: "remote-" + row.id, remote: row })));
    else action.setMessage({ text: errorMessage(data, "That photo couldn't be removed."), tone: "error" });
  }

  async function submit(event) {
    event.preventDefault();
    const parsed = listingPayload(draft);
    if (!parsed.ok) {
      action.setMessage({ text: parsed.message, tone: "error" });
      document.getElementById("sell-" + parsed.field)?.focus();
      return;
    }
    if (!photos.length) {
      action.setMessage({ text: "Add at least one photo.", tone: "error" });
      return;
    }
    if (!editing && emailNeeded && !validEmail(sellerEmail)) {
      action.setMessage({ text: "Add an email for buyer alerts so you hear when someone buys.", tone: "error" });
      document.getElementById("sell-sellerEmail")?.focus();
      return;
    }
    await action.run(async () => {
      if (!editing && emailNeeded) {
        const saved = await marketRequest("/market/settings", { body: { notifyEmail: sellerEmail.trim() }, method: "PUT" });
        if (!saved.ok) {
          action.setMessage({ text: saved.data.error === "invalid_settings" ? "Check the email for buyer alerts." : errorMessage(saved.data), tone: "error" });
          document.getElementById("sell-sellerEmail")?.focus();
          return;
        }
        setEmailNeeded(false);
      }
      const body = editing ? parsed.value : { ...parsed.value, photos: photos.map((photo) => photo.dataUrl) };
      const { ok, data } = await marketRequest(editing ? "/market/listings/" + editId : "/market/listings", { body, method: editing ? "PATCH" : "POST" });
      if (ok && data.listing) {
        announceMarketChange();
        window.location.hash = listingHref(data.listing.id).slice(1);
        return;
      }
      if (data.error === "seller_email_required") {
        setEmailNeeded(true);
        action.setMessage({ text: errorMessage(data), tone: "error" });
        return;
      }
      if (data.error === "invalid_listing" && data.field) {
        action.setMessage({ text: "Check the " + data.field.replace(/([A-Z])/g, " $1").toLowerCase() + " field.", tone: "error" });
        document.getElementById("sell-" + data.field)?.focus();
      } else action.setMessage({ text: errorMessage(data), tone: "error" });
    });
  }

  const status = config.status === "loading" ? "loading" : loadState;
  const shell = (children) => h("section", { "data-market-state": status === "ready" ? "ready" : status, "data-market-view": editing ? "edit" : "sell" }, [
    h("a", { className: "market-back", href: editing ? listingHref(editId) : "#market", key: "back" }, editing ? "← Back to listing" : "← All used discs"),
    h("div", { className: "shop-catalog-bar", key: "bar" }, h("h2", null, editing ? "Edit your listing" : "Sell a disc")),
    ...children,
  ]);

  if (config.status === "loading") return shell([h(LoadState, { key: "load", state: "loading" })]);
  if (viewer.kind !== "member") {
    return shell([h("div", { className: "my-orders-panel market-panel", "data-market-members-only": "true", key: "members" }, [
      h(Note, { key: "note" }, MEMBERS_ONLY_LISTING),
      h("a", { className: "shop-btn", href: "gvdg-members.html", key: "sign-in" }, "Members sign in"),
    ])]);
  }
  if (loadState === "loading" || loadState === "error") return shell([h(LoadState, { key: "load", state: loadState })]);
  if (loadState === "locked") return shell([h(Note, { key: "locked" }, "This listing can only be edited while it's active.")]);

  return shell([
    settingsMissing ? h(Note, { key: "settings" }, [
      "Add your PayPal.me, Cash App or Zelle in ",
      h("a", { className: "market-link", href: "#my-market", key: "link" }, "My marketplace"),
      " so buyers can pay you directly.",
    ]) : null,
    h("form", { "aria-label": editing ? "Edit listing" : "Sell a disc", className: "my-orders-panel market-panel market-form market-sell-form", key: "form", noValidate: true, onSubmit: submit }, [
      !editing && emailNeeded ? h("div", { className: "market-seller-email", "data-market-seller-email": "required", key: "seller-email" },
        h(Field, { hint: SELLER_EMAIL_HINT, id: "sell-sellerEmail", label: SELLER_EMAIL_LABEL }, h("input", {
          autoCapitalize: "none", autoComplete: "email", id: "sell-sellerEmail", inputMode: "email", key: "input", maxLength: 120,
          onChange: (event) => setSellerEmail(event.target.value), required: true, type: "email", value: sellerEmail,
        }))) : null,
      h(VoiceDiscButton, { example: "Try: “Orange Star Destroyer, 175 grams.”", key: "voice", onFields: heard }),
      h("div", { className: "market-grid-2", key: "names" }, [
        h(BrandPick, { id: "sell-brand", key: "brand", maxLength: LIMITS.brand, onChange: (value) => set("brand", value), value: draft.brand }),
        h(MoldInput, { brand: draft.brand, id: "sell-mold", key: "mold", maxLength: LIMITS.mold, onChange: (value) => set("mold", value), placeholder: "Destroyer", value: draft.mold }),
        h(PlasticPick, { brand: draft.brand, id: "sell-plastic", key: "plastic", maxLength: LIMITS.plastic, onChange: (value) => set("plastic", value), value: draft.plastic }),
        h(Field, { id: "sell-discType", key: "type", label: "Disc type" }, h("select", {
          id: "sell-discType", key: "input", onChange: (event) => set("discType", event.target.value), required: true, value: draft.discType,
        }, [h("option", { key: "none", value: "" }, "Choose a type"), ...DISC_TYPES.map(([value, text]) => h("option", { key: value, value }, text))])),
      ]),
      h("fieldset", { className: "market-fieldset", key: "flight" }, [
        h("legend", { key: "legend" }, "Flight numbers (optional)"),
        h("div", { className: "market-grid-4", key: "grid" }, [["speed", "Speed"], ["glide", "Glide"], ["turn", "Turn"], ["fade", "Fade"]].map(([key, label]) =>
          h(Field, { id: "sell-" + key, key, label }, h("input", {
            id: "sell-" + key, inputMode: "decimal", key: "input", onChange: (event) => set(key, event.target.value), step: "0.5", type: "number", value: draft[key],
          })))),
      ]),
      h("div", { className: "market-grid-2", key: "physical" }, [
        h(WeightPick, { id: "sell-weightG", key: "weight", label: "Weight (g)", onChange: (value) => set("weightG", value), value: draft.weightG }),
        h(ColorPick, { id: "sell-color", key: "color", label: "Color", maxLength: LIMITS.color, onChange: (value) => set("color", value), value: draft.color }),
        h(Field, { id: "sell-condition", key: "condition", label: "Condition" }, h("select", {
          id: "sell-condition", key: "input", onChange: (event) => set("condition", event.target.value), required: true, value: draft.condition,
        }, [h("option", { key: "none", value: "" }, "Choose 1–10"), ...CONDITION_LEGEND.map(([score, text]) => h("option", { key: score, value: String(score) }, `${score} · ${text}`))])),
        h(Field, { id: "sell-quantity", key: "quantity", label: "Quantity" }, h("input", {
          id: "sell-quantity", inputMode: "numeric", key: "input", max: 20, min: 1, onChange: (event) => set("quantity", event.target.value), type: "number", value: draft.quantity,
        })),
      ]),
      h(ConditionGuide, { key: "guide" }),
      h(Field, { hint: "Ink, rim dents, flat top, anything a buyer should know.", id: "sell-conditionNotes", key: "notes", label: "Condition notes" },
        h("textarea", { id: "sell-conditionNotes", key: "input", maxLength: LIMITS.conditionNotes, onChange: (event) => set("conditionNotes", event.target.value), rows: 2, value: draft.conditionNotes })),
      h("div", { className: "market-grid-2", key: "price" }, [
        h(Field, { hint: "Leave blank for trade only.", id: "sell-price", key: "price", label: "Price (USD)" }, h("input", {
          id: "sell-price", inputMode: "decimal", key: "input", onChange: (event) => set("price", event.target.value), placeholder: "18", type: "text", value: draft.price,
        })),
        h("label", { className: "market-check market-check-block", key: "trade" }, [
          h("input", { checked: draft.openToTrade, key: "input", onChange: (event) => set("openToTrade", event.target.checked), type: "checkbox" }),
          "Open to trades",
        ]),
      ]),
      draft.openToTrade ? h(Field, { id: "sell-tradeFor", key: "trade-for", label: "What I'd trade for" }, h("textarea", {
        id: "sell-tradeFor", key: "input", maxLength: LIMITS.tradeFor, onChange: (event) => set("tradeFor", event.target.value), placeholder: "A stable fairway around 170g", rows: 2, value: draft.tradeFor,
      })) : null,
      h(Field, { id: "sell-location", key: "location", label: "Location or pickup notes" }, textInput("sell-location", draft, set, "location", {
        placeholder: "At Sunday Baggers · Greenville · will ship +$5",
      })),
      h(PhotoPicker, { busy: photoBusy || action.busy, existing: editing, key: "photos", onAdd: addPhotos, onRemove: removePhoto, photos }),
      h("button", { className: "shop-btn market-submit", disabled: action.busy || photoBusy, key: "submit", type: "submit" },
        action.busy ? "Saving…" : editing ? "Save changes" : "Post listing"),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
  ]);
}
