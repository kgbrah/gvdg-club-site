// The uploader-only photo nudge. When the club's private read finds a name or phone number in one of your photos,
// you (and nobody else) see "This photo may show a name or phone number, and anyone can see it." with Replace photo
// and Keep it. Nothing says what was read. Replace uploads a new photo in its place (the old file is deleted).
import React from "react";
import { EyeOff } from "lucide-react";

import { resizeImageFile } from "../shared/image-resize.js";
import { LF_NUDGE_TEXT, lfErrorMessage } from "../shared/lost-found-model.js";
import { StatusLine, useAction } from "./market-ui.js";
import { announceLfChange, LfPhoto, lfRequest } from "./lf-ui.js";

const h = React.createElement;
const MAX_PHOTO_DATA_URL = 2_000_000;

function PhotoNudge({ photo, label, href, onChanged }) {
  const action = useAction();
  const input = React.useRef(null);
  async function post(path, body, done) {
    await action.run(async () => {
      const { ok, data } = await lfRequest(`/lost-found/photos/${photo.id}/${path}`, { body, method: "POST" });
      if (ok) {
        action.setMessage({ text: done, tone: "success" });
        announceLfChange();
        onChanged?.();
      } else action.setMessage({ text: lfErrorMessage(data), tone: "error" });
    });
  }
  async function replace(file) {
    const image = file ? await resizeImageFile(file, 1280) : "";
    if (!image || image.length > MAX_PHOTO_DATA_URL) {
      action.setMessage({ text: "That photo couldn't be used. Try a JPEG or PNG.", tone: "error" });
      return;
    }
    await post("replace", { image }, "Photo replaced.");
  }
  return h("li", { className: "lf-nudge", "data-lf-nudge": photo.id }, [
    h(LfPhoto, { alt: label ? "Your photo of the " + label : "Your photo", className: "lf-nudge-thumb", key: "photo", photo }),
    h("div", { className: "lf-nudge-body", key: "body" }, [
      label ? (href ? h("a", { className: "lf-nudge-label", href, key: "label" }, label) : h("strong", { className: "lf-nudge-label", key: "label" }, label)) : null,
      h("p", { className: "lf-nudge-text", key: "text" }, LF_NUDGE_TEXT),
      h("div", { className: "market-actions lf-nudge-actions", key: "actions" }, [
        h("button", { className: "shop-btn secondary", disabled: action.busy, key: "replace", onClick: () => input.current?.click(), type: "button" }, "Replace photo"),
        h("button", { className: "shop-filter-reset", disabled: action.busy, key: "keep", onClick: () => post("keep", {}, "Kept."), type: "button" }, "Keep it"),
      ]),
      h("input", {
        accept: "image/jpeg,image/png,image/webp,image/*", "aria-label": "Choose a new photo", className: "public-sr-only", key: "input", ref: input, tabIndex: -1, type: "file",
        onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void replace(file); },
      }),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
  ]);
}

/** `photos`: [{ id, url, label?, href? }] of the viewer's own flagged photos. Renders nothing when there are none. */
export function PhotoNudges({ photos, onChanged, heading = "Check your photo" }) {
  const list = Array.isArray(photos) ? photos : [];
  if (!list.length) return null;
  return h("section", { "aria-label": heading, className: "market-panel lf-nudges", "data-lf-nudges": list.length }, [
    h("h3", { className: "market-subhead lf-nudge-title", key: "title" }, [h(EyeOff, { "aria-hidden": true, key: "icon", size: 18 }), " ", heading]),
    h("p", { className: "market-note", key: "why" }, "Only you see this. A thumb, a strip of tape or the other side of the disc keeps it private."),
    h("ul", { className: "lf-nudge-list", key: "list" }, list.map((photo) => h(PhotoNudge, {
      href: photo.href, key: photo.id, label: photo.label || "", onChanged, photo,
    }))),
  ]);
}
