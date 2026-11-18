// Post a found or a lost disc. Members post directly; anyone else verifies their email first (the club's guest
// identity, shared with the marketplace). Photos are resized on the phone (which drops location data) and the
// server strips metadata again. Photos are public as posted, so the form asks posters to cover names and
// phone numbers; the club reads the writing privately to find the owner.
import React from "react";

import { resizeImageFile } from "../shared/image-resize.js";
import { LF_LIMITS, LF_MAX_PHOTOS, LF_PHOTO_TIP, lfErrorMessage, postHref, postPayload, validatePost } from "../shared/lost-found-model.js";
import { Note, StatusLine, useAction } from "./market-ui.js";
import { announceLfChange, lfRequest, PrivacyNote, useLfConfig, useLfIdentityGate } from "./lf-ui.js";
import { useCourses } from "./lf-list.js";

const h = React.createElement;
const MAX_PHOTO_DATA_URL = 2_000_000;
const EMPTY = { brand: "", mold: "", plastic: "", color: "", courseId: "", area: "", eventDate: "", holding: "finder", binNote: "", rewardNote: "", privateInk: "" };

function todayEastern() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function Field({ id, label, hint, error, children }) {
  return h("div", { className: "market-field" + (error ? " has-error" : ""), "data-lf-field": id }, [
    h("label", { htmlFor: id, key: "label" }, label),
    children,
    hint ? h("small", { className: "market-hint", key: "hint" }, hint) : null,
    error ? h("small", { className: "market-note error", key: "error", role: "alert" }, error) : null,
  ]);
}

export function PhotoPicker({ photos, setPhotos, max, min, legend, hint, onError }) {
  const inputId = React.useId();
  const [busy, setBusy] = React.useState(false);
  const remaining = max - photos.length;
  async function add(files) {
    setBusy(true);
    try {
      const added = [];
      for (const file of files.slice(0, remaining)) {
        const dataUrl = await resizeImageFile(file, 1280);
        if (!dataUrl || dataUrl.length > MAX_PHOTO_DATA_URL) {
          onError?.("One photo couldn't be used. Try a JPEG or PNG.");
          continue;
        }
        added.push({ key: "p-" + Math.random().toString(36).slice(2), dataUrl });
      }
      setPhotos((current) => current.concat(added).slice(0, max));
    } finally {
      setBusy(false);
    }
  }
  return h("fieldset", { className: "market-fieldset market-photos", "data-lf-field": "photos" }, [
    h("legend", { key: "legend" }, legend || `Photos (${min ? min + " to " : "up to "}${max})`),
    h("p", { className: "lf-photo-tip", "data-lf-photo-tip": "true", key: "tip" }, LF_PHOTO_TIP),
    photos.length ? h("ul", { className: "market-photo-list", key: "list" }, photos.map((photo, index) => h("li", { className: "market-photo-item", key: photo.key }, [
      h("img", { alt: `Photo ${index + 1}`, className: "market-photo-thumb", key: "img", src: photo.dataUrl }),
      h("button", { "aria-label": `Remove photo ${index + 1}`, className: "shop-filter-reset", disabled: busy, key: "remove",
        onClick: () => setPhotos((current) => current.filter((item) => item.key !== photo.key)), type: "button" }, "Remove"),
    ]))) : null,
    remaining > 0 ? h("label", { className: "shop-filter-reset market-photo-add", htmlFor: inputId, key: "add" }, photos.length ? "Add another photo" : "Add photos") : null,
    h("input", {
      accept: "image/jpeg,image/png,image/webp,image/*", "aria-label": "Choose disc photos", className: "public-sr-only", disabled: busy || remaining <= 0,
      id: inputId, key: "input", multiple: max > 1,
      onChange: (event) => { const files = Array.from(event.target.files || []); event.target.value = ""; void add(files); },
      type: "file",
    }),
    hint ? h("small", { className: "market-hint", key: "hint" }, hint) : null,
  ]);
}

export function NewPost({ kind }) {
  const config = useLfConfig();
  const courses = useCourses();
  const [draft, setDraft] = React.useState(() => ({ ...EMPTY, eventDate: todayEastern() }));
  const [photos, setPhotos] = React.useState([]);
  const [problem, setProblem] = React.useState(null);
  const action = useAction();
  const identity = useLfIdentityGate(config.viewer);
  const gateBox = React.useRef(null);
  const gateOpen = Boolean(identity.gate);
  React.useEffect(() => {
    if (gateOpen) gateBox.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [gateOpen]);
  const found = kind === "found";
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const text = (id, key, label, extra = {}) => h(Field, { error: problem?.field === key ? problem.text : "", hint: extra.hint, id, key, label },
    h("input", { id, key: "input", maxLength: LF_LIMITS[key], onChange: (event) => set(key, event.target.value), type: "text", value: draft[key], ...extra.input }));

  async function send() {
    await action.run(async () => {
      const { ok, data } = await lfRequest("/lost-found/posts", { body: postPayload(kind, draft, photos.map((photo) => photo.dataUrl)), method: "POST" });
      if (ok && data.post?.id) {
        announceLfChange();
        window.location.hash = postHref(data.post.id).slice(1);
      } else {
        if (data.field) setProblem({ field: data.field, text: lfErrorMessage(data) });
        action.setMessage({ text: lfErrorMessage(data), tone: "error" });
      }
    });
  }

  function submit(event) {
    event.preventDefault();
    const issue = validatePost(kind, draft, photos.length);
    setProblem(issue);
    if (issue) {
      action.setMessage({ text: issue.text, tone: "error" });
      return;
    }
    identity.require(found ? "Verify your email to post the disc you found" : "Verify your email to post your lost disc", send);
  }

  return h("section", { "data-lf-view": "new-" + kind }, [
    h("a", { className: "market-back", href: found ? "#found" : "#lost", key: "back" }, found ? "Back to found discs" : "Back to lost discs"),
    h("form", { "aria-label": found ? "Post a found disc" : "Post a lost disc", className: "market-form market-panel lf-form", key: "form", noValidate: true, onSubmit: submit }, [
      h("h2", { className: "my-orders-title", key: "title" }, found ? "Post a found disc" : "Post a lost disc"),
      found
        ? h(PrivacyNote, { key: "privacy" }, "Anyone can see the photos you post. We also read any writing on the disc privately, only to find its owner.")
        : h(PrivacyNote, { key: "privacy" }, "What you type about the writing on your disc stays private: it's only used to match your disc with found ones and is never shown to anyone. Any photo you add is public."),
      h(PhotoPicker, {
        key: "photos", max: LF_MAX_PHOTOS[kind], min: found ? 1 : 0, onError: (message) => action.setMessage({ text: message, tone: "error" }), photos, setPhotos,
        hint: found ? "Show the top and the bottom. Photos are resized on your phone and location data is removed." : "Optional: a photo of the same disc or one like it.",
        legend: found ? "Photos (1 to 3)" : "Photos (optional, up to 2)",
      }),
      problem?.field === "photos" ? h(Note, { key: "photo-error", tone: "error" }, problem.text) : null,
      h(Note, { key: "optional" }, found ? "Everything below is optional. We can read most of it from the photo." : "Add what you remember."),
      h("div", { className: "market-grid-2", key: "disc" }, [
        text("lfBrand", "brand", "Brand", { input: { placeholder: "Innova, Discraft…" } }),
        text("lfMold", "mold", "Mold", { input: { placeholder: "Destroyer, Buzzz…" } }),
        text("lfPlastic", "plastic", "Plastic", { input: { placeholder: "Star, ESP…" } }),
        text("lfColor", "color", "Colour", { input: { placeholder: "Orange" } }),
      ]),
      h("div", { className: "market-grid-2", key: "where" }, [
        h(Field, { id: "lfCourse", key: "course", label: "Course" },
          h("select", { id: "lfCourse", key: "input", onChange: (event) => set("courseId", event.target.value), value: draft.courseId }, [
            h("option", { key: "none", value: "" }, "Choose a course"),
            ...courses.map((row) => h("option", { key: row.id, value: String(row.id) }, row.name)),
          ])),
        text("lfArea", "area", "Hole or area", { input: { placeholder: "Hole 7 pond" } }),
        h(Field, { id: "lfDate", key: "date", label: found ? "Date found" : "Date lost" },
          h("input", { id: "lfDate", key: "input", max: todayEastern(), onChange: (event) => set("eventDate", event.target.value), type: "date", value: draft.eventDate })),
      ]),
      found ? h("fieldset", { className: "market-fieldset", key: "holding" }, [
        h("legend", { key: "legend" }, "Where is it now?"),
        h("label", { className: "market-check", key: "finder" }, [
          h("input", { checked: draft.holding !== "club_bin", key: "input", name: "lfHolding", onChange: () => set("holding", "finder"), type: "radio" }), "I have it",
        ]),
        h("label", { className: "market-check", key: "bin" }, [
          h("input", { checked: draft.holding === "club_bin", key: "input", name: "lfHolding", onChange: () => set("holding", "club_bin"), type: "radio" }), "I turned it in to a club bin",
        ]),
        draft.holding === "club_bin" ? text("lfBin", "binNote", "Which bin?", { input: { placeholder: "Elm Street Park shed" } }) : null,
      ]) : null,
      !found ? h(Field, { id: "lfReward", key: "reward", label: "Reward note (optional, shown)" },
        h("input", { id: "lfReward", key: "input", maxLength: LF_LIMITS.rewardNote, onChange: (event) => set("rewardNote", event.target.value), placeholder: "A cold drink on me", type: "text", value: draft.rewardNote })) : null,
      !found ? h(Field, {
        error: problem?.field === "privateInk" ? problem.text : "", hint: "Your name, phone number, initials… Private: only used for matching.", id: "lfInk", key: "ink",
        label: "What's written on it (private)",
      }, h("textarea", { id: "lfInk", key: "input", maxLength: LF_LIMITS.privateInk, onChange: (event) => set("privateInk", event.target.value), rows: 2, value: draft.privateInk })) : null,
      h("button", { className: "shop-btn market-submit", disabled: action.busy, key: "submit", type: "submit" }, action.busy ? "Posting…" : found ? "Post found disc" : "Post lost disc"),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
    h("div", { className: "lf-gate", key: "gate", ref: gateBox }, identity.gate),
  ]);
}
