// Post a found or a lost disc, or edit your own post. Members post directly; anyone else verifies their email first
// (the club's guest identity, shared with the marketplace). Photos are resized on the phone (which drops location
// data) and the server strips metadata again. Photos are public as posted, so the form asks posters to cover names
// and phone numbers; the club reads the writing privately to find the owner.
import React from "react";

import { resizeImageFile } from "../shared/image-resize.js";
import {
  draftFromPost, LF_LIMITS, LF_MAX_PHOTOS, LF_PHOTO_TIP, lfErrorMessage, postEditPayload, postHref, postPayload, validatePost,
} from "../shared/lost-found-model.js";
import { plasticsFor } from "../shared/disc-catalog.js";
import { holeCount, layoutHoles, matchSpokenCourse, nearestCourse, nearestHole } from "../shared/course-geo.js";
import { Note, StatusLine, useAction } from "./market-ui.js";
import { announceLfChange, LfLoad, LfPhoto, lfRequest, PrivacyNote, useLfConfig, useLfIdentityGate, useLfResource } from "./lf-ui.js";
import { useCourses } from "./lf-list.js";
import { PhotoAddButtons } from "./photo-add.js";
import { BrandPick, ColorPick, MoldInput, PickList, PlasticPick, VoiceDiscButton, WeightPick } from "./disc-fields.js";
import { CoursePicker, useHere } from "./course-picker.js";
import { BagPhotoChooser, BagPicker, clearBagHandoff, readBagHandoff, useBagChoices } from "./lf-bag.js";
import { memberTokenExpired, readMemberToken } from "../shared/member-session.js";

const LF_VOICE_FIELDS = ["brand", "mold", "plastic", "color", "weightG", "courseId", "hole", "area"];

const h = React.createElement;
const MAX_PHOTO_DATA_URL = 2_000_000;
const EMPTY = {
  brand: "", mold: "", plastic: "", color: "", weightG: "", courseId: "", hole: "", area: "", eventDate: "", holding: "finder", binNote: "", rewardNote: "",
  privateInk: "",
};
const DEFAULT_HOLES = 18;
const courseLayouts = new Map();

/** The course's holes with their tees and baskets (every layout), for the hole pick-list and "the hole I'm on". */
function useCourseLayout(courseId) {
  const id = Number(courseId) || 0;
  const [loaded, setLoaded] = React.useState(() => new Map(courseLayouts));
  React.useEffect(() => {
    if (!id || courseLayouts.has(id)) return undefined;
    let live = true;
    lfRequest("/courses/" + id + "/layouts").then(({ ok, data }) => {
      if (!ok) return;
      const layouts = Array.isArray(data?.layouts) ? data.layouts : [];
      courseLayouts.set(id, { holes: layoutHoles(layouts), count: holeCount(layouts) });
      if (live) setLoaded(new Map(courseLayouts));
    }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  const layout = id ? loaded.get(id) : null;
  return { holes: layout?.holes ?? [], count: layout?.count >= 1 && layout.count <= 40 ? layout.count : DEFAULT_HOLES, ready: Boolean(layout) };
}

/** A new brand clears a plastic that only belonged to the old one. */
function withBrand(current, brand) {
  const plastic = current.plastic;
  const key = (value) => String(value).toLowerCase();
  const belongsToOld = plasticsFor(current.brand).some((name) => key(name) === key(plastic)) && current.brand;
  const fitsNew = plasticsFor(brand).some((name) => key(name) === key(plastic));
  return { ...current, brand, plastic: plastic && belongsToOld && !fitsNew ? "" : plastic };
}

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

export function PhotoPicker({ photos, setPhotos, max, min, legend, hint, cameraHint, onError }) {
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
    h(PhotoAddButtons, {
      cameraHint, disabled: busy, hasPhotos: photos.length > 0, key: "add", multiple: max > 1, onFiles: (files) => { void add(files); }, remaining,
    }),
    hint ? h("small", { className: "market-hint", key: "hint" }, hint) : null,
  ]);
}

/** The photos already on a post being edited: each one comes off, or a new one goes on, straight away. */
function EditPhotos({ post, photos, setPhotos, onError }) {
  const [busy, setBusy] = React.useState(false);
  const found = post.kind === "found";
  const max = LF_MAX_PHOTOS[post.kind] || 0;
  const remaining = max - photos.length;
  async function change(path, body, failure) {
    setBusy(true);
    try {
      const { ok, data } = await lfRequest(`/lost-found/posts/${post.id}/${path}`, { body, method: "POST" });
      // Both routes answer with the post as it now stands.
      if (ok && data.post) setPhotos(data.post.myPhotos || []);
      else onError(lfErrorMessage(data, failure));
    } finally {
      setBusy(false);
    }
  }
  async function add(files) {
    for (const file of files.slice(0, remaining)) {
      const image = await resizeImageFile(file, 1280);
      if (!image || image.length > MAX_PHOTO_DATA_URL) { onError("One photo couldn't be used. Try a JPEG or PNG."); continue; }
      await change("photos", { image }, "That photo didn't upload. Try again.");
    }
  }
  return h("fieldset", { className: "market-fieldset market-photos", "data-lf-edit-photos": photos.length, "data-lf-field": "photos" }, [
    h("legend", { key: "legend" }, found ? "Photos (1 to 3)" : "Photos (optional, up to 2)"),
    h("p", { className: "lf-photo-tip", key: "tip" }, LF_PHOTO_TIP),
    photos.length ? h("ul", { className: "market-photo-list", key: "list" }, photos.map((photo, index) => h("li", { className: "market-photo-item", key: photo.id }, [
      h(LfPhoto, { alt: `Photo ${index + 1}`, className: "market-photo-thumb", key: "img", photo }),
      h("button", {
        "aria-label": `Remove photo ${index + 1}`, className: "shop-filter-reset", disabled: busy || (found && photos.length <= 1), key: "remove",
        onClick: () => { void change("photos/" + photo.id + "/remove", {}, "That photo couldn't be removed."); }, type: "button",
      }, "Remove"),
    ]))) : null,
    h(PhotoAddButtons, {
      cameraHint: found ? "The top of the disc, then the bottom. Cover any name or phone number." : "Your disc, or one just like it.",
      disabled: busy, hasPhotos: photos.length > 0, key: "add", multiple: remaining > 1, onFiles: (files) => { void add(files); }, remaining,
    }),
    h("small", { className: "market-hint", key: "hint" }, busy ? "Saving photo…" : "Photo changes save straight away."),
  ]);
}

/** Edit your own post: the same form, filled in from the post. */
export function EditPost({ id }) {
  const state = useLfResource("/lost-found/posts/" + id);
  const back = h("a", { className: "market-back", href: postHref(id), key: "back" }, "Back to your post");
  if (state.status !== "ready") {
    return h("section", { "data-lf-state": state.status, "data-lf-view": "edit" }, [back, h(LfLoad, { key: "load", missing: "This post is no longer up.", onRetry: state.retry, state })]);
  }
  const post = state.data.post;
  if (!post.mine || !post.canEdit) {
    return h("section", { "data-lf-state": "locked", "data-lf-view": "edit" }, [back, h(Note, { key: "locked" }, "Only the person who posted it can edit this post, while it's still up.")]);
  }
  return h(NewPost, { edit: post, kind: post.kind });
}

/** `route.query` may carry course / hole from the scoring app ("Found a disc" on the hole you're playing). `edit`: the
 *  poster's own post, to edit instead of posting a new one. */
export function NewPost({ kind, route, edit = null }) {
  const config = useLfConfig();
  const courses = useCourses();
  const editing = Boolean(edit);
  // "I lost this disc" from My Bag fills the lost post in (a signed-in member's own bag disc only).
  const [bag, setBag] = React.useState(() => {
    if (editing || kind !== "lost" || route?.query?.get("from") !== "bag") return null;
    const token = readMemberToken();
    return token && !memberTokenExpired(token) ? readBagHandoff() : null;
  });
  const fromBag = bag && config.viewer?.kind === "member" ? bag : null;
  React.useEffect(() => {
    if (config.status === "ready" && config.viewer?.kind !== "member" && bag) {
      setBag(null);
      setBagChosen([]);
      clearBagHandoff();
      setDraft((current) => ({ ...current, brand: "", mold: "", plastic: "", color: "", weightG: "", privateInk: "" }));
    }
  }, [config.status, config.viewer?.kind, bag]);
  // "Lost a disc" without one picked: a signed-in member with discs saved picks one from the bag, or enters it.
  const [skipPicker, setSkipPicker] = React.useState(false);
  const member = config.viewer?.kind === "member";
  // Loaded once for the form (not dropped after a pick, so "Pick a different disc" can bring it back); not needed when
  // My Bag already handed a disc over.
  const [cameFromBag] = React.useState(() => route?.query?.get("from") === "bag");
  const picker = useBagChoices(member && !editing && kind === "lost" && !cameFromBag);
  const showPicker = member && !editing && kind === "lost" && !bag && !skipPicker && picker.status === "ready";
  function pickFromBag(handoff) {
    setBag(handoff);
    setBagChosen(handoff.photos.slice(0, LF_MAX_PHOTOS.lost));
    setDraft((current) => ({ ...current, brand: handoff.brand, mold: handoff.mold, plastic: handoff.plastic, color: handoff.color, weightG: handoff.weightG, privateInk: handoff.ink }));
  }
  function unpickBag() {
    setBag(null);
    setBagChosen([]);
    setSkipPicker(false);
    setDraft((current) => ({ ...current, brand: "", mold: "", plastic: "", color: "", weightG: "", privateInk: "" }));
  }
  // The bag's photos go on the post unless the owner unticks them (a lost post takes two).
  const [bagChosen, setBagChosen] = React.useState(() => (bag ? bag.photos.slice(0, LF_MAX_PHOTOS.lost) : []));
  const [remotePhotos, setRemotePhotos] = React.useState(() => edit?.myPhotos || []);
  const [draft, setDraft] = React.useState(() => {
    if (edit) return draftFromPost(edit);
    if (bag) {
      return { ...EMPTY, brand: bag.brand, mold: bag.mold, plastic: bag.plastic, color: bag.color, weightG: bag.weightG, privateInk: bag.ink, eventDate: todayEastern() };
    }
    const query = route?.query;
    const course = /^\d{1,9}$/.test(query?.get("course") || "") ? query.get("course") : "";
    const hole = /^\d{1,2}$/.test(query?.get("hole") || "") && Number(query.get("hole")) >= 1 && Number(query.get("hole")) <= 40 ? query.get("hole") : "";
    return { ...EMPTY, courseId: course, hole: course ? hole : "", eventDate: todayEastern() };
  });
  const layout = useCourseLayout(draft.courseId);
  const holes = layout.count;
  // Where you are: read on open when location is already allowed (never prompts by itself); "Use my location" asks.
  const here = useHere();
  // What location filled in (and was left alone since), for the notes under the fields.
  const [located, setLocated] = React.useState(() => ({ course: "", hole: "", tried: editing ? "edit" : route?.query?.get("course") ? "prefilled" : "" }));
  React.useEffect(() => {
    if (here.status !== "ready" || !courses.length || located.tried || draft.courseId) return;
    const near = nearestCourse(courses, here.here);
    setLocated((current) => ({ ...current, tried: "course", course: near ? String(near.course.id) : "" }));
    if (near) setDraft((current) => (current.courseId ? current : { ...current, courseId: String(near.course.id), hole: "" }));
  }, [here.status, here.here, courses, located.tried, draft.courseId]);
  React.useEffect(() => {
    if (editing || here.status !== "ready" || !layout.ready || draft.hole || located.holeFor === draft.courseId) return;
    const near = nearestHole(layout.holes, here.here);
    setLocated((current) => ({ ...current, holeFor: draft.courseId, hole: near ? String(near.hole) : "" }));
    if (near) setDraft((current) => (current.hole ? current : { ...current, hole: String(near.hole) }));
  }, [here.status, here.here, layout.ready, layout.holes, draft.hole, draft.courseId, located.holeFor]);
  const position = here.status === "ready" ? here.here : null;
  const spokenCourse = (transcript) => {
    const course = matchSpokenCourse(transcript, courses, position);
    return course ? { courseId: String(course.id) } : {};
  };
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
  const set = (key, value) => setDraft((current) => (key === "brand" ? withBrand(current, value) : { ...current, [key]: value }));
  const heard = (fields) => setDraft((current) => {
    const next = fields.brand ? withBrand(current, fields.brand) : { ...current };
    if (fields.courseId && fields.courseId !== current.courseId) { next.courseId = fields.courseId; next.hole = ""; }
    for (const key of ["mold", "plastic", "color", "weightG", "hole", "area"]) if (fields[key]) next[key] = fields[key];
    return next;
  });
  const fieldError = (key) => (problem?.field === key ? problem.text : "");
  const text = (id, key, label, extra = {}) => h(Field, { error: problem?.field === key ? problem.text : "", hint: extra.hint, id, key, label },
    h("input", { id, key: "input", maxLength: LF_LIMITS[key], onChange: (event) => set(key, event.target.value), type: "text", value: draft[key], ...extra.input }));

  async function save() {
    await action.run(async () => {
      const { ok, data } = await lfRequest("/lost-found/posts/" + edit.id, { body: postEditPayload(kind, draft), method: "PATCH" });
      if (ok && data.post?.id) {
        announceLfChange();
        window.location.hash = postHref(data.post.id).slice(1);
      } else {
        if (data.field) setProblem({ field: data.field, text: lfErrorMessage(data) });
        action.setMessage({ text: lfErrorMessage(data), tone: "error" });
      }
    });
  }

  async function send() {
    await action.run(async () => {
      const body = postPayload(kind, draft, photos.map((photo) => photo.dataUrl));
      if (fromBag) {
        body.bagDiscId = fromBag.discId;
        body.bagPhotoIds = bagChosen;
      }
      const { ok, data } = await lfRequest("/lost-found/posts", { body, method: "POST" });
      if (ok && data.post?.id) {
        if (fromBag) clearBagHandoff();
        announceLfChange();
        window.location.hash = postHref(data.post.id).slice(1);
      } else {
        if (data.field) setProblem({ field: data.field, text: lfErrorMessage(data) });
        action.setMessage({ text: lfErrorMessage(data), tone: "error" });
      }
    });
  }

  const sendRef = React.useRef(send);
  sendRef.current = send;

  function submit(event) {
    event.preventDefault();
    const issue = validatePost(kind, draft, editing ? remotePhotos.length : photos.length + bagChosen.length, {
      keepEventDate: Boolean(editing && draft.eventDate === (edit?.date || "")),
    });
    setProblem(issue);
    if (issue) {
      action.setMessage({ text: issue.text, tone: "error" });
      return;
    }
    if (editing) { void save(); return; }
    identity.require(found ? "Verify your email to post the disc you found" : "Verify your email to post your lost disc", () => sendRef.current());
  }

  const heading = editing ? "Edit your post" : found ? "Post a found disc" : "Post a lost disc";
  return h("section", { "data-lf-state": editing ? "ready" : undefined, "data-lf-view": editing ? "edit" : "new-" + kind }, [
    editing
      ? h("a", { className: "market-back", href: postHref(edit.id), key: "back" }, "Back to your post")
      : h("a", { className: "market-back", href: found ? "#found" : "#lost", key: "back" }, found ? "Back to found discs" : "Back to lost discs"),
    h("form", { "aria-label": heading, className: "market-form market-panel lf-form", key: "form", noValidate: true, onSubmit: submit }, [
      h("h2", { className: "my-orders-title", key: "title" }, heading),
      found
        ? h(PrivacyNote, { key: "privacy" }, "Anyone can see the photos you post. We also read any writing on the disc privately, only to find its owner.")
        : h(PrivacyNote, { key: "privacy" }, "What you type about the writing on your disc stays private: it's only used to match your disc with found ones and is never shown to anyone. Any photo you add is public."),
      showPicker ? h(BagPicker, { choices: picker.discs, key: "bag-picker", onPick: pickFromBag, onSkip: () => setSkipPicker(true) }) : null,
      fromBag ? h(Note, { key: "from-bag", tone: "success" }, [
        "Filled in from your bag. Add where you lost it, check the rest, and post. ",
        picker.status === "ready" ? h("button", { className: "market-text-btn", "data-lf-bag-change": "true", key: "change", onClick: unpickBag, type: "button" }, "Pick a different disc") : null,
      ]) : null,
      fromBag ? h(BagPhotoChooser, {
        chosen: bagChosen, key: "bag-photos", photos: fromBag.photos, room: LF_MAX_PHOTOS[kind] - photos.length - bagChosen.length, setChosen: setBagChosen,
      }) : null,
      editing ? h(EditPhotos, { key: "edit-photos", onError: (message) => action.setMessage({ text: message, tone: "error" }), photos: remotePhotos, post: edit, setPhotos: setRemotePhotos }) : null,
      editing ? null : h(PhotoPicker, {
        key: "photos", max: Math.max(0, LF_MAX_PHOTOS[kind] - bagChosen.length), min: found ? 1 : 0, onError: (message) => action.setMessage({ text: message, tone: "error" }), photos, setPhotos,
        hint: found ? "Show the top and the bottom. Photos are resized on your phone and location data is removed." : "Optional: a photo of the same disc or one like it.",
        cameraHint: found ? "The top of the disc, then the bottom. Cover any name or phone number." : "Your disc, or one just like it.",
        legend: found ? "Photos (1 to 3)" : "Photos (optional, up to 2)",
      }),
      problem?.field === "photos" ? h(Note, { key: "photo-error", tone: "error" }, problem.text) : null,
      h(Note, { key: "optional" }, found ? "Everything below is optional. We can read most of it from the photo." : "Add what you remember."),
      h(VoiceDiscButton, {
        example: found ? "Try: “Orange Star Destroyer, 175 grams, hole 7 at Elm Street, by the pond.”" : "Try: “Blue ESP Buzzz, 177 grams, lost on hole 12 at the Farm, in the woods.”",
        extraParse: spokenCourse, fields: LF_VOICE_FIELDS, holes, key: "voice", onFields: heard,
      }),
      h("div", { className: "market-grid-2", key: "disc" }, [
        h(BrandPick, { error: fieldError("brand"), id: "lfBrand", key: "brand", maxLength: LF_LIMITS.brand, onChange: (value) => set("brand", value), value: draft.brand }),
        h(MoldInput, { brand: draft.brand, error: fieldError("mold"), id: "lfMold", key: "mold", maxLength: LF_LIMITS.mold, onChange: (value) => set("mold", value), value: draft.mold }),
        h(PlasticPick, { brand: draft.brand, error: fieldError("plastic"), id: "lfPlastic", key: "plastic", maxLength: LF_LIMITS.plastic, onChange: (value) => set("plastic", value), value: draft.plastic }),
        h(ColorPick, { error: fieldError("color"), id: "lfColor", key: "color", onChange: (value) => set("color", value), value: draft.color }),
        h(WeightPick, { error: fieldError("weightG"), id: "lfWeight", key: "weight", label: "Weight (if you know it)", onChange: (value) => set("weightG", value), value: draft.weightG }),
      ]),
      h("div", { className: "market-grid-2", key: "where" }, [
        h(CoursePicker, {
          courses, error: fieldError("courseId"), here, id: "lfCourse", key: "course",
          note: located.course && located.course === draft.courseId ? "Filled in from your location. Change it if that's wrong." : "",
          onChange: (value) => setDraft((current) => ({ ...current, courseId: value, hole: "" })), value: draft.courseId,
        }),
        h(PickList, {
          allowOther: false, error: fieldError("hole"), field: "hole", id: "lfHole", key: "hole", label: found ? "Hole found on" : "Hole lost on", onChange: (value) => set("hole", value),
          hint: located.hole && located.hole === draft.hole && located.holeFor === draft.courseId ? "The hole closest to you." : "",
          options: [...Array.from({ length: holes }, (_, index) => [String(index + 1), "Hole " + (index + 1)]), ["off", "Not on a hole"]],
          placeholder: "Choose a hole", value: draft.hole,
        }),
        text("lfArea", "area", "Where exactly (optional)", { input: { maxLength: LF_LIMITS.areaDetail, placeholder: found ? "By the pond, left of the fairway" : "Parking lot, the creek…" } }),
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
      h("button", { className: "shop-btn market-submit", disabled: action.busy, key: "submit", type: "submit" },
        editing ? (action.busy ? "Saving…" : "Save changes") : action.busy ? "Posting…" : found ? "Post found disc" : "Post lost disc"),
      h(StatusLine, { key: "status", message: action.message }),
    ]),
    h("div", { className: "lf-gate", key: "gate", ref: gateBox }, identity.gate),
  ]);
}
