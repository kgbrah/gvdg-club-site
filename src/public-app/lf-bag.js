// "I lost this disc" from My Bag: the member app leaves the disc's details in this tab's sessionStorage (never in the
// address, since what's written on it is private) and opens the lost-post form, which fills itself in. The bag's
// photos are private; each one goes on the post only if the owner ticks it (a photo on a post is public).
import React from "react";

import { resolveApiBase } from "../shared/api-base.js";
import { readMemberToken } from "../shared/member-session.js";

const h = React.createElement;
export const LF_BAG_HANDOFF_KEY = "gvdg_lf_bag_handoff";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);

/** The bag disc handed over by My Bag, or null. */
export function readBagHandoff() {
  try {
    const data = JSON.parse(sessionStorage.getItem(LF_BAG_HANDOFF_KEY) || "null");
    if (!data || !UUID.test(String(data.discId || ""))) return null;
    const weight = Number(data.weightG);
    return {
      discId: data.discId, brand: clean(data.brand, 40), mold: clean(data.mold, 40), plastic: clean(data.plastic, 40), color: clean(data.color, 40),
      weightG: Number.isInteger(weight) && weight >= 100 && weight <= 200 ? String(weight) : "", ink: clean(data.ink, 120),
      photos: (Array.isArray(data.photos) ? data.photos : []).filter((id) => Number.isInteger(id) && id > 0).slice(0, 3),
    };
  } catch {
    return null;
  }
}

export function clearBagHandoff() {
  try { sessionStorage.removeItem(LF_BAG_HANDOFF_KEY); } catch { /* nothing kept */ }
}

/** One of the signed-in member's private bag photos, fetched with their sign-in (never a public link). */
export function BagPhoto({ id, alt }) {
  const [src, setSrc] = React.useState("");
  React.useEffect(() => {
    let live = true;
    let url = "";
    const token = readMemberToken();
    if (!token) return undefined;
    fetch(resolveApiBase({ datasetKeys: ["authBase"] }) + "/me/bag/photos/" + id, { cache: "no-store", headers: { Authorization: "Bearer " + token } })
      .then(async (response) => {
        if (!response.ok || !live) return;
        url = URL.createObjectURL(await response.blob());
        if (live) setSrc(url); else URL.revokeObjectURL(url);
      }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src ? h("img", { alt, className: "market-photo-thumb", src }) : h("span", { "aria-label": alt, className: "market-photo-thumb lf-bag-photo-loading", role: "img" });
}

/** The bag's photos, each with "Show on the post" (on until unticked). `room`: how many more the post can take. */
export function BagPhotoChooser({ photos, chosen, setChosen, room }) {
  if (!photos.length) return null;
  return h("fieldset", { className: "market-fieldset lf-bag-photos", "data-lf-bag-photos": photos.length }, [
    h("legend", { key: "legend" }, "Photos from your bag"),
    h("p", { className: "market-hint", key: "why" }, "Ticked photos go on the post, where anyone can see them. Untick any you'd rather keep private."),
    h("ul", { className: "market-photo-list", key: "list" }, photos.map((id, index) => {
      const on = chosen.includes(id);
      return h("li", { className: "market-photo-item", key: id }, [
        h(BagPhoto, { alt: "Bag photo " + (index + 1), id, key: "img" }),
        h("label", { className: "market-check", key: "pick" }, [
          h("input", {
            checked: on, disabled: !on && room <= 0, key: "input", type: "checkbox",
            onChange: (event) => setChosen((current) => (event.target.checked ? current.concat(id) : current.filter((value) => value !== id))),
          }),
          "Show on the post",
        ]),
      ]);
    })),
  ]);
}

/** "Innova Destroyer · Star · Orange · 175 g" for a bag disc record. */
export function bagDiscLabel(record) {
  const name = [record?.brand, record?.model].filter(Boolean).join(" ") || "Disc";
  const weight = Number(record?.weightGrams);
  return [name, record?.plastic, record?.color, Number.isFinite(weight) && weight > 0 ? `${Math.round(weight)} g` : ""].filter(Boolean).join(" · ");
}

/**
 * The signed-in member's bag discs to pick from on "Lost a disc" (the owner's request: choose one from your bag OR
 * enter it, to speed it up). Discs in the bag first, then the rest; archived ones and discs already reported lost
 * (still up) are left out. { status: "loading" | "ready" | "none", discs: [{ discId, label, inBag, handoff }] }.
 */
export function bagPickChoices(practice, bag) {
  const lostOpen = new Set((Array.isArray(bag?.lost) ? bag.lost : []).filter((row) => row && row.status !== "closed" && row.status !== "expired").map((row) => String(row.discId)));
  const photosOf = new Map();
  for (const photo of Array.isArray(bag?.photos) ? bag.photos : []) {
    if (!photo || !Number.isInteger(photo.id)) continue;
    photosOf.set(String(photo.discId), [...(photosOf.get(String(photo.discId)) || []), photo.id]);
  }
  return (Array.isArray(practice?.discs) ? practice.discs : [])
    .filter((row) => row && UUID.test(String(row.id || "")) && row.record && !row.record.archived && !lostOpen.has(String(row.id)))
    .map((row) => {
      const record = row.record;
      const weight = Number(record.weightGrams);
      return {
        discId: row.id, label: bagDiscLabel(record), inBag: record.inBag === true,
        handoff: {
          discId: row.id, brand: clean(record.brand, 40), mold: clean(record.model, 40), plastic: clean(record.plastic, 40), color: clean(record.color, 40),
          weightG: Number.isInteger(Math.round(weight)) && weight >= 100 && weight <= 200 ? String(Math.round(weight)) : "", ink: clean(record.ink, 120),
          photos: (photosOf.get(String(row.id)) || []).slice(0, 3),
        },
      };
    })
    .sort((a, b) => Number(b.inBag) - Number(a.inBag) || a.label.localeCompare(b.label));
}

async function memberGet(path, token, signal) {
  const response = await fetch(resolveApiBase({ datasetKeys: ["authBase"] }) + path, { cache: "no-store", headers: { Authorization: "Bearer " + token }, signal });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/** Load the bag choices for the signed-in member (nothing for anyone else, or when offline). */
export function useBagChoices(enabled) {
  const [state, setState] = React.useState({ status: enabled ? "loading" : "none", discs: [] });
  React.useEffect(() => {
    const token = readMemberToken();
    if (!enabled || !token) { setState({ status: "none", discs: [] }); return undefined; }
    const controller = new AbortController();
    Promise.all([memberGet("/me/practice", token, controller.signal), memberGet("/me/bag", token, controller.signal).catch(() => null)])
      .then(([practice, bag]) => {
        const discs = bagPickChoices(practice, bag);
        setState({ status: discs.length ? "ready" : "none", discs });
      })
      .catch((error) => { if (error?.name !== "AbortError") setState({ status: "none", discs: [] }); });
    return () => controller.abort();
  }, [enabled]);
  return state;
}

/** "Which disc did you lose?": one tap fills the post from the bag (with its photos to tick), or enter it yourself. */
export function BagPicker({ choices, onPick, onSkip }) {
  const inBag = choices.filter((disc) => disc.inBag);
  const others = choices.filter((disc) => !disc.inBag);
  const list = (discs, key) => h("ul", { className: "lf-bag-pick-list", key }, discs.map((disc) => h("li", { key: disc.discId },
    h("button", { className: "lf-bag-pick", "data-lf-bag-pick": disc.discId, onClick: () => onPick(disc.handoff), type: "button" }, [
      disc.handoff.photos[0] ? h(BagPhoto, { alt: "", id: disc.handoff.photos[0], key: "photo" }) : h("span", { "aria-hidden": "true", className: "market-photo-thumb lf-bag-pick-blank", key: "photo" }),
      h("span", { className: "lf-bag-pick-label", key: "label" }, disc.label),
    ]))));
  return h("section", { className: "market-fieldset lf-bag-picker", "data-lf-bag-picker": choices.length }, [
    h("h3", { className: "market-subhead", key: "title" }, "Which disc did you lose?"),
    h("p", { className: "market-hint", key: "hint" }, "Pick it from your bag to fill this in, or enter it yourself."),
    inBag.length ? list(inBag, "bag") : null,
    others.length ? h("p", { className: "market-hint", key: "others-title" }, inBag.length ? "Other discs you've saved" : "Discs you've saved") : null,
    others.length ? list(others, "others") : null,
    h("button", { className: "shop-btn secondary", "data-lf-bag-skip": "true", key: "skip", onClick: onSkip, type: "button" }, "Enter it myself"),
  ]);
}
