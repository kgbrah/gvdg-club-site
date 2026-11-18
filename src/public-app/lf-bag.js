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

function BagPhoto({ id, alt }) {
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

/** The bag's photos, each with "Show on the post" (off until ticked). `room`: how many more the post can take. */
export function BagPhotoChooser({ photos, chosen, setChosen, room }) {
  if (!photos.length) return null;
  return h("fieldset", { className: "market-fieldset lf-bag-photos", "data-lf-bag-photos": photos.length }, [
    h("legend", { key: "legend" }, "Photos from your bag"),
    h("p", { className: "market-hint", key: "why" }, "These are private. Tick one to show it on the post, where anyone can see it."),
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
