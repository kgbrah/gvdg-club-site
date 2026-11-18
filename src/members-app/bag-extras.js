// My Bag meets Lost & Found: private photos of your bag discs (the in-app camera or the photo picker), "I lost this
// disc" (opens a Lost & Found lost post filled in from the bag), and the switch for checking found discs against your
// bag. Photos are private: fetched with your sign-in, never a public link. Needs a connection (the bag itself works
// offline); without one, these controls just don't show.
import React from "react";
import { Camera, ImagePlus, Search, ShieldCheck, Trash2 } from "lucide-react";

import { authBase, request, requestJson } from "./api.js";
import { resizeImageFile } from "../shared/image-resize.js";
import { openPhotoInput, useCameraCapture, useCameraMode } from "../public-app/photo-add.js";
import { LF_BAG_HANDOFF_KEY } from "../public-app/lf-bag.js";

const h = React.createElement;
export const BAG_PHOTOS_PER_DISC = 3;
const EMPTY = { status: "loading", matchFound: true, photos: [], lost: [] };

/** GET /me/bag, refreshed after a change: { status, matchFound, photos: [{ id, discId }], lost: [{ discId, postId, status }] }. */
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
  const photos = extras.photos.filter((photo) => photo.discId === disc.id);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const room = BAG_PHOTOS_PER_DISC - photos.length;
  const cameraMode = useCameraMode();
  async function upload(files) {
    setBusy(true);
    setNote("");
    try {
      for (const file of files.slice(0, Math.max(0, room))) {
        const image = await resizeImageFile(file, 1280);
        if (!image) { setNote("That photo couldn't be used. Try a JPEG or PNG."); continue; }
        const response = await request("/me/bag/photos", { body: { discId: disc.id, image }, method: "POST", token });
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
      await request("/me/bag/photos/" + photo.id, { method: "DELETE", token });
    } finally {
      setBusy(false);
      extras.refresh();
    }
  }
  const [takePhoto, cameraSheet] = useCameraCapture({
    chooseFiles: () => openPhotoInput({ multiple: room > 1, onFiles: (files) => { void upload(files); } }),
    hint: "The top of the disc, and the bottom with any writing.", max: Math.max(1, room), mode: cameraMode,
    onFiles: (files) => { void upload(files); },
  });
  if (extras.status !== "ready") return null;
  const camera = cameraMode === "live" || cameraMode === "app";
  return h("div", { className: "bag-photos", "data-bag-photos": disc.id }, [
    photos.length ? h("ul", { "aria-label": "Photos of " + label, className: "bag-photo-list", key: "list" }, photos.map((photo, index) => h("li", { key: photo.id }, [
      h(BagPhoto, { alt: `${label}, photo ${index + 1}`, id: photo.id, key: "img", token }),
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
  if (extras.status !== "ready" || record.archived) return null;
  const lost = extras.lost.find((row) => row.discId === disc.id);
  if (lost && lost.status !== "closed" && lost.status !== "expired") {
    return h("p", { className: "player-card-meta bag-lost-status", "data-bag-lost": lost.status }, [
      h("strong", { key: "status" }, LOST_STATUS[lost.status] || "Reported lost"), " · ",
      h("a", { href: "lost-found.html#post/" + lost.postId, key: "link" }, "View post"),
    ]);
  }
  function report() {
    const photos = extras.photos.filter((photo) => photo.discId === disc.id).map((photo) => photo.id);
    try {
      sessionStorage.setItem(LF_BAG_HANDOFF_KEY, JSON.stringify({
        discId: disc.id, brand: record.brand || "", mold: record.model || "", plastic: record.plastic || "", color: record.color || "",
        weightG: record.weightGrams == null ? "" : String(Math.round(record.weightGrams)), ink: record.ink || "", photos,
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
