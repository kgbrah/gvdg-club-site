// My Bag meets Lost & Found and the marketplace: private photos of your bag discs (the in-app camera or the photo
// picker), "I lost this disc" (opens a Lost & Found lost post filled in from the bag, with its photos), "Sell this" on
// a disc, the bag or an accessory (opens a marketplace listing filled in from the bag, with its photos), and the switch
// for checking found discs against your bag. Photos are private: fetched with your sign-in, never a public link. Needs a connection (the bag itself works
// offline); without one, these controls just don't show.
import { useMemberContext } from "./member-context.js";
import React from "react";
import { Camera, ImagePlus, Plus, Search, ShieldCheck, Tag, Trash2 } from "lucide-react";

import { authBase, request, requestJson } from "./api.js";
import { resizeImageFile } from "../shared/image-resize.js";
import { openPhotoInput, useCameraCapture, useCameraMode } from "../public-app/photo-add.js";
import { LF_BAG_HANDOFF_KEY } from "../public-app/lf-bag.js";
import { sellFromBag } from "../public-app/market-bag.js";
import { memberTokenSubject, readMemberToken } from "../shared/member-session.js";
import { ACCESSORY_KINDS } from "../shared/market-model.js";
import { memberConfirm } from "./member-dialogs.js";

const h = React.createElement;
export const BAG_PHOTOS_PER_DISC = 3;
export const BAG_PHOTOS_OF_BAG = 6;
export const PHOTOS_PER_ACCESSORY = 3;
export { ACCESSORY_KINDS };
const KIND_LABEL = Object.fromEntries(ACCESSORY_KINDS);
const LISTING_PHOTOS = 4;
const EMPTY = { status: "loading", matchFound: true, photos: [], bagPhotos: [], accessories: [], lost: [], listings: [] };

/** GET /me/bag, refreshed after a change: { status, matchFound, photos: [{ id, discId }], lost: [{ discId, postId, status }],
 *  listings: [{ ref, listingId, status }] (bag items up for sale) }. */
export function useBagExtras(token) {
  const [state, setState] = React.useState(EMPTY);
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    if (!token) { setState({ ...EMPTY, status: "signed-out" }); return undefined; }
    const controller = new AbortController();
    requestJson("/me/bag", { signal: controller.signal, token }).then((data) => {
      setState({
        status: "ready", matchFound: data?.matchFound !== false,
        photos: Array.isArray(data?.photos) ? data.photos : [], lost: Array.isArray(data?.lost) ? data.lost : [],
        bagPhotos: Array.isArray(data?.bagPhotos) ? data.bagPhotos.map((photo) => photo.id) : [],
        accessories: Array.isArray(data?.accessories) ? data.accessories : [],
        listings: Array.isArray(data?.listings) ? data.listings : [],
      });
    }).catch((error) => {
      if (error?.name !== "AbortError") setState((current) => ({ ...current, status: "offline" }));
    });
    return () => controller.abort();
  }, [token, version]);
  const refresh = React.useCallback(() => setVersion((value) => value + 1), []);
  return { ...state, refresh };
}

/** A private bag photo: fetched with the member's token, shown from a blob URL. */
function BagPhoto({ id, token, alt }) {
  const [src, setSrc] = React.useState("");
  React.useEffect(() => {
    let live = true;
    let url = "";
    // A plain fetch (not the shared GET cache): each photo is its own private image.
    fetch(authBase() + "/me/bag/photos/" + id, { cache: "no-store", headers: { Authorization: "Bearer " + token } }).then(async (response) => {
      if (!response.ok || !live) return;
      url = URL.createObjectURL(await response.blob());
      if (live) setSrc(url); else URL.revokeObjectURL(url);
    }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [id, token]);
  return src ? h("img", { alt, className: "bag-photo-img", src }) : h("span", { "aria-label": alt, className: "bag-photo-img bag-photo-loading", role: "img" });
}

/** The photo strip on a bag disc card, with Take photo / Choose photo while there's room. */
export function BagDiscPhotos({ disc, label, token, extras }) {
  const photos = extras.photos.filter((photo) => photo.discId === disc.id).map((photo) => photo.id);
  return h(BagPhotoStrip, {
    attr: { "data-bag-photos": disc.id }, extras, hint: "The top of the disc, and the bottom with any writing.", label, max: BAG_PHOTOS_PER_DISC, photos,
    target: { discId: disc.id }, token,
  });
}

/**
 * Private photos of one thing in the bag. `photos`: photo ids. `target`: what the upload is of ({ discId } |
 * { bag: true } | { accessoryId }). `max`: how many it can have.
 */
export function BagPhotoStrip({ photos, target, label, max, token, extras, hint, attr = {} }) {
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const room = max - photos.length;
  const cameraMode = useCameraMode();
  async function upload(files) {
    setBusy(true);
    setNote("");
    try {
      for (const file of files.slice(0, Math.max(0, room))) {
        const image = await resizeImageFile(file, 1280);
        if (!image) { setNote("That photo couldn't be used. Try a JPEG or PNG."); continue; }
        const response = await request("/me/bag/photos", { body: { ...target, image }, method: "POST", token });
        if (!response.ok) setNote(response.status === 404 ? "Save the disc first, then add photos." : "The photo didn't upload. Try again in a moment.");
      }
    } finally {
      setBusy(false);
      extras.refresh();
    }
  }
  async function remove(photo) {
    setBusy(true);
    try {
      await request("/me/bag/photos/" + photo, { method: "DELETE", token });
    } finally {
      setBusy(false);
      extras.refresh();
    }
  }
  const [takePhoto, cameraSheet] = useCameraCapture({
    chooseFiles: () => openPhotoInput({ multiple: room > 1, onFiles: (files) => { void upload(files); } }),
    hint, max: Math.max(1, room), mode: cameraMode,
    onFiles: (files) => { void upload(files); },
  });
  if (extras.status !== "ready") return null;
  const camera = cameraMode === "live" || cameraMode === "app";
  return h("div", { className: "bag-photos", ...attr }, [
    photos.length ? h("ul", { "aria-label": "Photos of " + label, className: "bag-photo-list", key: "list" }, photos.map((photo, index) => h("li", { key: photo }, [
      h(BagPhoto, { alt: `${label}, photo ${index + 1}`, id: photo, key: "img", token }),
      h("button", { "aria-label": `Delete photo ${index + 1} of ${label}`, className: "bag-photo-delete", disabled: busy, key: "delete", onClick: () => { void remove(photo); }, type: "button" },
        h(Trash2, { "aria-hidden": true, size: 16 })),
    ]))) : null,
    room > 0 ? h("div", { className: "bag-photo-add", key: "add" }, [
      camera ? h("button", { className: "dashboard-action", disabled: busy, key: "camera", onClick: takePhoto, type: "button" }, [
        h(Camera, { "aria-hidden": true, key: "icon", size: 16 }), photos.length ? "Take another" : "Take photo",
      ]) : null,
      h("button", {
        className: "dashboard-action", disabled: busy, key: "choose", type: "button",
        onClick: () => openPhotoInput({ multiple: room > 1, onFiles: (files) => { void upload(files); } }),
      }, [h(ImagePlus, { "aria-hidden": true, key: "icon", size: 16 }), camera ? "Choose photo" : "Add photo"]),
    ]) : null,
    busy ? h("p", { className: "player-card-meta", key: "busy", role: "status" }, "Saving photo…") : null,
    note ? h("p", { className: "dash-note", key: "note", role: "alert" }, note) : null,
    cameraSheet,
  ]);
}

const LOST_STATUS = { open: "Reported lost", claimed: "Someone says they have it", returned: "Returned", closed: "Lost post closed", expired: "Lost post expired" };

/** "I lost this disc", or where its lost post stands (with a link). */
export function BagDiscLost({ disc, record, extras }) {
  const context = useMemberContext();
  if (extras.status !== "ready" || record.archived) return null;
  const lost = extras.lost.find((row) => row.discId === disc.id);
  if (lost && (lost.status === "open" || lost.status === "claimed")) {
    return h("p", { className: "player-card-meta bag-lost-status", "data-bag-lost": lost.status }, [
      h("strong", { key: "status" }, LOST_STATUS[lost.status] || "Reported lost"), " · ",
      h("a", { href: "lost-found.html#post/" + lost.postId, key: "link" }, "View post"),
    ]);
  }
  const ownerSub = context.sub || memberTokenSubject(readMemberToken());
  function report() {
    const photos = extras.photos.filter((photo) => photo.discId === disc.id).map((photo) => photo.id);
    try {
      sessionStorage.setItem(LF_BAG_HANDOFF_KEY, JSON.stringify({
        discId: disc.id, brand: record.brand || "", mold: record.model || "", plastic: record.plastic || "", color: record.color || "",
        weightG: record.weightGrams == null ? "" : String(Math.round(record.weightGrams)), ink: record.ink || "", photos,
        ...(ownerSub ? { ownerSub } : {}),
      }));
    } catch {
      /* the form still opens, just without the bag details */
    }
    window.location.href = "lost-found.html#new/lost?from=bag";
  }
  return h("button", { className: "dashboard-action bag-lost-button", "data-bag-report-lost": disc.id, onClick: report, type: "button" }, [
    h(Search, { "aria-hidden": true, key: "icon", size: 16 }), "I lost this disc",
  ]);
}

/**
 * "Sell this": a marketplace listing filled in from the bag, its photos already on it. Once it's up, where it stands
 * instead (with a link). `item()`: what to fill in ({ ref, brand, mold, … , photos }).
 */
export function BagSell({ itemRef, item, extras, label = "Sell this" }) {
  const context = useMemberContext();
  if (extras.status !== "ready") return null;
  const listing = extras.listings.find((row) => row.ref === itemRef);
  // Guest accounts buy but don't list (they can still see a listing they made before becoming a guest).
  if (!listing && context.membership?.guest) return null;
  if (listing) {
    return h("p", { className: "player-card-meta bag-sale-status", "data-bag-for-sale": itemRef }, [
      h("strong", { key: "status" }, listing.status === "pending" ? "Sale pending" : "For sale"), " · ",
      h("a", { href: "pro-shop.html#market/listing/" + listing.listingId, key: "link" }, "View listing"),
    ]);
  }
  const ownerSub = context.sub || memberTokenSubject(readMemberToken());
  return h("button", {
    className: "dashboard-action bag-sell-button", "data-bag-sell": itemRef,
    onClick: () => sellFromBag({ ref: itemRef, ...item(), ...(ownerSub ? { ownerSub } : {}) }), type: "button",
  }, [
    h(Tag, { "aria-hidden": true, key: "icon", size: 16 }), label,
  ]);
}

/** "Sell this" on a saved bag disc (not while it's reported lost). */
export function BagDiscSell({ disc, record, extras }) {
  const lost = extras.lost.find((row) => row.discId === disc.id);
  if (lost && (lost.status === "open" || lost.status === "claimed")) return null;
  return h(BagSell, {
    extras, itemRef: "disc:" + disc.id,
    item: () => ({
      brand: record.brand || "", mold: record.model || "", plastic: record.plastic || "", color: record.color || "",
      weightG: record.weightGrams == null ? "" : String(Math.round(record.weightGrams)),
      photos: extras.photos.filter((photo) => photo.discId === disc.id).map((photo) => photo.id).slice(0, LISTING_PHOTOS),
    }),
  });
}

/** "Check found discs against my bag" (on unless turned off). */
export function BagMatchSwitch({ token, extras }) {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  // Flips at once; goes back if the save fails.
  const [on, setOn] = React.useState(extras.matchFound);
  React.useEffect(() => { setOn(extras.matchFound); }, [extras.matchFound]);
  if (extras.status !== "ready") return null;
  async function toggle(event) {
    const matchFound = event.target.checked;
    setOn(matchFound);
    setSaving(true);
    setError("");
    try {
      const response = await request("/me/bag/settings", { body: { matchFound }, method: "PUT", token });
      if (!response.ok) { setOn(!matchFound); setError("That didn't save. Try again in a moment."); }
    } catch {
      setOn(!matchFound);
      setError("That didn't save. Check your connection.");
    } finally {
      setSaving(false);
      extras.refresh();
    }
  }
  return h("section", { className: "player-card bag-match-switch", "data-bag-match": on ? "on" : "off" }, [
    h("label", { className: "bag-match-label", key: "label" }, [
      h("input", { checked: on, disabled: saving, key: "input", onChange: (event) => { void toggle(event); }, type: "checkbox" }),
      h(ShieldCheck, { "aria-hidden": true, key: "icon", size: 18 }),
      h("span", { key: "text" }, "Check found discs against my bag"),
    ]),
    h("p", { className: "player-card-meta", key: "why" },
      "When someone posts a found disc, we check it against your bag privately and tell you only if it's very likely yours: your name, number or initials are on it, or it matches your photo. Nobody else sees your bag."),
    error ? h("p", { className: "dash-note", key: "error", role: "alert" }, error) : null,
  ]);
}

/** "Photos of my bag": the whole bag, laid out (up to six). */
export function BagWholePhotos({ token, extras }) {
  if (extras.status !== "ready") return null;
  return h("section", { "aria-label": "Photos of my bag", className: "player-card bag-whole", "data-bag-whole": extras.bagPhotos.length }, [
    h("h3", { key: "title" }, "Photos of my bag"),
    h("p", { className: "player-card-meta", key: "why" }, "The whole bag, open and laid out. Private: only you see them."),
    h(BagPhotoStrip, {
      extras, hint: "Your whole bag, open, with the discs showing.", key: "strip", label: "my bag", max: BAG_PHOTOS_OF_BAG,
      photos: extras.bagPhotos, target: { bag: true }, token,
    }),
    h(BagSell, { extras, item: () => ({ photos: extras.bagPhotos.slice(0, LISTING_PHOTOS) }), itemRef: "bag", key: "sell", label: "Sell my bag" }),
  ]);
}

function accessoryLabel(item) {
  return item.name || KIND_LABEL[item.kind] || "Accessory";
}

function AccessoryForm({ initial, token, onDone, onCancel }) {
  const [form, setForm] = React.useState(() => ({ kind: initial?.kind || "towel", name: initial?.name || "", notes: initial?.notes || "" }));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const id = React.useId();
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await request(initial ? "/me/bag/accessories/" + initial.id : "/me/bag/accessories", {
        body: { kind: form.kind, name: form.name.trim(), notes: form.notes.trim() }, method: initial ? "PATCH" : "POST", token,
      });
      if (!response.ok) { setError(response.status === 409 ? "That's the most accessories for now." : "That didn't save. Try again in a moment."); return; }
      onDone();
    } catch {
      setError("That didn't save. Check your connection.");
    } finally {
      setBusy(false);
    }
  }
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return h("form", { "aria-label": initial ? "Edit accessory" : "Add an accessory", className: "bag-accessory-form", onSubmit: save }, [
    h("label", { className: "member-practice-field", htmlFor: id + "-kind", key: "kind" }, [
      h("span", { key: "label" }, "What is it?"),
      h("select", { className: "form-input", id: id + "-kind", key: "input", onChange: set("kind"), value: form.kind },
        ACCESSORY_KINDS.map(([value, label]) => h("option", { key: value, value }, label))),
    ]),
    h("label", { className: "member-practice-field", htmlFor: id + "-name", key: "name" }, [
      h("span", { key: "label" }, "Name (optional)"),
      h("input", { className: "form-input", id: id + "-name", key: "input", maxLength: 60, onChange: set("name"), placeholder: "Zuca cart, club towel…", type: "text", value: form.name }),
    ]),
    h("label", { className: "member-practice-field", htmlFor: id + "-notes", key: "notes" }, [
      h("span", { key: "label" }, "Notes (optional)"),
      h("input", { className: "form-input", id: id + "-notes", key: "input", maxLength: 200, onChange: set("notes"), placeholder: "Colour, markings, where it lives", type: "text", value: form.notes }),
    ]),
    error ? h("p", { className: "dash-note", key: "error", role: "alert" }, error) : null,
    h("div", { className: "dashboard-actions", key: "actions" }, [
      h("button", { className: "dashboard-action primary", disabled: busy, key: "save", type: "submit" }, busy ? "Saving…" : initial ? "Save accessory" : "Add accessory"),
      h("button", { className: "dashboard-action", disabled: busy, key: "cancel", onClick: onCancel, type: "button" }, "Cancel"),
    ]),
  ]);
}

/** Accessories: cart, towel, minis, rangefinder… each with its own private photos. */
export function BagAccessories({ token, extras }) {
  const [editing, setEditing] = React.useState(null); // "new" | accessory id
  const [error, setError] = React.useState("");
  if (extras.status !== "ready") return null;
  const done = () => { setEditing(null); extras.refresh(); };
  async function remove(item) {
    const confirmed = await memberConfirm({
      title: "Delete this accessory?", message: "Its photos are deleted too.", confirmText: "Delete accessory", tone: "danger",
    });
    if (!confirmed) return;
    setError("");
    try {
      const response = await request("/me/bag/accessories/" + item.id, { method: "DELETE", token });
      if (!response.ok) setError("That didn't delete. Try again in a moment.");
    } catch {
      setError("That didn't delete. Check your connection.");
    }
    extras.refresh();
  }
  return h("section", { "aria-label": "Accessories", className: "player-card bag-accessories", "data-bag-accessories": extras.accessories.length }, [
    h("h3", { key: "title" }, "Accessories"),
    h("p", { className: "player-card-meta", key: "why" }, "Your cart, towel, minis, rangefinder and the rest, with photos. Private: only you see them."),
    extras.accessories.length ? h("ul", { className: "bag-accessory-list", key: "list" }, extras.accessories.map((item) => h("li", {
      className: "bag-accessory", "data-bag-accessory": item.id, key: item.id,
    }, editing === item.id
      ? h(AccessoryForm, { initial: item, onCancel: () => setEditing(null), onDone: done, token })
      : [
        h("div", { className: "bag-accessory-head", key: "head" }, [
          h("strong", { key: "name" }, accessoryLabel(item)),
          item.name ? h("span", { className: "player-card-meta", key: "kind" }, KIND_LABEL[item.kind] || "") : null,
        ]),
        item.notes ? h("p", { className: "player-card-meta", key: "notes" }, item.notes) : null,
        h(BagPhotoStrip, {
          attr: { "data-bag-accessory-photos": item.id }, extras, hint: "The " + accessoryLabel(item).toLowerCase() + ".", key: "photos",
          label: accessoryLabel(item), max: PHOTOS_PER_ACCESSORY, photos: item.photos || [], target: { accessoryId: item.id }, token,
        }),
        h("div", { className: "dashboard-actions", key: "actions" }, [
          h("button", { className: "dashboard-action", key: "edit", onClick: () => setEditing(item.id), type: "button" }, "Edit"),
          h("button", { className: "dashboard-action member-record-delete", key: "delete", onClick: () => { void remove(item); }, type: "button" }, "Delete"),
        ]),
        h(BagSell, {
          extras, itemRef: "accessory:" + item.id, key: "sell",
          item: () => ({ gearType: item.kind, mold: (item.name || KIND_LABEL[item.kind] || "").slice(0, 40), photos: (item.photos || []).slice(0, LISTING_PHOTOS) }),
        }),
      ]))) : h("p", { className: "dash-note", key: "empty" }, "No accessories yet."),
    editing === "new"
      ? h(AccessoryForm, { key: "form", onCancel: () => setEditing(null), onDone: done, token })
      : h("button", { className: "dashboard-action bag-accessory-add", key: "add", onClick: () => setEditing("new"), type: "button" }, [
        h(Plus, { "aria-hidden": true, key: "icon", size: 16 }), "Add accessory",
      ]),
    error ? h("p", { className: "dash-note", key: "error", role: "alert" }, error) : null,
  ]);
}
