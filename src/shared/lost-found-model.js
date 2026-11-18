// Pure helpers for Lost & Found (no DOM, node-tested): routes, labels, the karma badge and form payloads.

export const LF_TABS = [
  ["found", "#found", "Found discs"],
  ["lost", "#lost", "Lost discs"],
  ["returned", "#returned", "Returned"],
  ["mine", "#mine", "My posts"],
];

export const LF_TAB_COPY = {
  found: "Found a disc on the course? Post it. We read the disc and any writing on it privately and let a likely owner know.",
  lost: "Lost a disc? Describe it. What's written on it stays private and is only used to match it with found discs.",
  returned: "Discs that made it home, and the finders who brought them back.",
  mine: "Your posts, possible matches and returns in progress.",
};

export const LF_REPORT_REASONS = [
  ["not_mine", "Someone is claiming a disc that isn't theirs"],
  ["wrong_info", "Wrong or misleading details"],
  ["privacy", "Shows private information"],
  ["inappropriate", "Inappropriate"],
  ["spam", "Spam"],
  ["other", "Something else"],
];

export const LF_LIMITS = { brand: 40, mold: 40, plastic: 40, color: 40, area: 60, areaDetail: 48, binNote: 80, rewardNote: 80, privateInk: 120, message: 500, caption: 200 };
export const LF_MAX_PHOTOS = { found: 3, lost: 2, celebration: 2 };

/** Shown wherever photos are added: photos are public as uploaded. */
export const LF_PHOTO_TIP = "Photos are public. Cover any name or phone number on the disc (a thumb or a strip of tape works) or show the other side.";
/** The uploader-only nudge when the private read found a name or phone number in one of their photos. */
export const LF_NUDGE_TEXT = "This photo may show a name or phone number, and anyone can see it.";

const PERSON_KEY = /^[0-9a-f]{18}$/;

function positiveId(value) {
  const text = String(value ?? "");
  return /^\d{1,12}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/** "#post/12" -> { tab, view, id, key, kind, query }. Unknown hashes land on the Found list. */
export function parseLfRoute(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const [path, search = ""] = raw.split("?", 2);
  const query = new URLSearchParams(search);
  const parts = path.split("/").filter(Boolean);
  const route = (tab, view, extra = {}) => ({ tab, view, id: null, key: null, kind: null, query, ...extra });
  const head = parts[0] || "found";
  if ((head === "found" || head === "lost") && parts.length === 1) return route(head, "list");
  if (head === "returned" && parts.length === 1) return route("returned", "wall");
  if (head === "mine" && parts.length === 1) return route("mine", "mine");
  if (head === "new" && (parts[1] === "found" || parts[1] === "lost") && parts.length === 2) return route(parts[1], "new", { kind: parts[1] });
  if (head === "post" && parts.length === 2 && positiveId(parts[1])) return route("found", "post", { id: positiveId(parts[1]) });
  if ((head === "match" || head === "claim" || head === "celebrate") && parts.length === 2 && positiveId(parts[1])) {
    return route("mine", head, { id: positiveId(parts[1]) });
  }
  if (head === "person" && parts.length === 2 && PERSON_KEY.test(parts[1])) return route("returned", "person", { key: parts[1] });
  return route("found", "list");
}

export function postHref(id) { return "#post/" + id; }
export function matchHref(id) { return "#match/" + id; }
export function claimHref(id) { return "#claim/" + id; }
export function celebrateHref(id) { return "#celebrate/" + id; }
export function personHref(key) { return PERSON_KEY.test(String(key || "")) ? "#person/" + key : "#returned"; }

/** "Karma 30 · 3 discs returned"; "" for someone who has not returned a disc yet. */
export function karmaLabel(person) {
  const karma = Number(person?.karma) || 0;
  const returned = Number(person?.returned) || 0;
  if (karma <= 0 && returned <= 0) return "";
  return `Karma ${karma} · ${returned} ${returned === 1 ? "disc" : "discs"} returned`;
}

export function discTitle(post) {
  const parts = [post?.brand, post?.plastic, post?.mold].map((part) => String(part || "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  const color = String(post?.color || "").trim();
  return color ? color + " disc" : "Disc";
}

const FIELD_LABELS = { brand: "brand", mold: "mold", plastic: "plastic", color: "colour" };

/** "Brand and mold read from the photo" when the AI filled in details the poster left blank. */
export function aiFieldsNote(fields) {
  const names = (Array.isArray(fields) ? fields : []).map((field) => FIELD_LABELS[field]).filter(Boolean);
  if (!names.length) return "";
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names.at(-1);
  return list.charAt(0).toUpperCase() + list.slice(1) + " read from the photo";
}

/** "a Destroyer" / "an Innova Star Destroyer". */
export function withArticle(text) {
  const value = String(text || "").trim();
  return (/^[aeiou]/i.test(value) ? "an " : "a ") + value;
}

export function shortDay(value) {
  const text = String(value || "");
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text + "T12:00:00Z" : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + "Z" : text;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

/** Where and when, for a card: "Elm Street Park · Hole 7 · Found Nov 12". */
export function postMeta(post) {
  const verb = post?.kind === "lost" ? "Lost" : "Found";
  const day = shortDay(post?.date);
  return [post?.course?.name, post?.area, day ? `${verb} ${day}` : ""].filter(Boolean).join(" · ");
}

export function holdingText(post) {
  if (post?.kind !== "found") return "";
  if (post.holding === "club_bin") return post.binNote ? `Turned in to the club bin at ${post.binNote}` : "Turned in to the club bin";
  return "The finder has it";
}

export const POST_STATUS_LABELS = {
  open: "Open",
  claimed: "Return in progress",
  returned: "Returned",
  closed: "Closed",
  expired: "Expired",
  merged: "Merged",
};

export const CLAIM_STATUS_LABELS = {
  open: "Claimed — arrange the return",
  returned: "Marked returned — waiting for the owner",
  confirmed: "Returned",
  cancelled: "Withdrawn",
  declined: "Closed",
};

/** Form draft -> request body (strings trimmed, blanks dropped). The Worker re-validates everything. */
/** "Hole 7 · by the pond" from the hole pick-list and the optional detail; "off" = not on a hole. */
export function composeArea(hole, detail) {
  const where = String(detail ?? "").trim();
  const number = Number(hole);
  if (!Number.isInteger(number) || number < 1 || number > 40) return where;
  return where ? "Hole " + number + " · " + where : "Hole " + number;
}

/** Where "Back to your round" goes: only this site's scoring page. */
export function safeRoundReturn(value) {
  const text = String(value ?? "").trim();
  return /^score\.html(?:\?[\w=&%.-]*)?(?:#[\w/=&%.-]*)?$/.test(text) && text.length <= 200 ? text : "";
}

export function postPayload(kind, draft, photos) {
  const text = (key) => String(draft?.[key] ?? "").trim();
  const body = { kind, brand: text("brand"), mold: text("mold"), plastic: text("plastic"), color: text("color"), area: composeArea(draft?.hole, draft?.area) };
  const courseId = positiveId(draft?.courseId);
  if (courseId) body.courseId = courseId;
  const weight = Number(text("weightG"));
  if (Number.isInteger(weight) && weight >= 100 && weight <= 200) body.weightG = weight;
  const hole = Number(text("hole"));
  if (Number.isInteger(hole) && hole >= 1 && hole <= 40) body.hole = hole;
  if (text("eventDate")) body.eventDate = text("eventDate");
  if (kind === "found") {
    body.holding = draft?.holding === "club_bin" ? "club_bin" : "finder";
    if (body.holding === "club_bin") body.binNote = text("binNote");
  } else {
    body.rewardNote = text("rewardNote");
    body.privateInk = String(draft?.privateInk ?? "").trim();
  }
  body.photos = Array.isArray(photos) ? photos.slice(0, LF_MAX_PHOTOS[kind] || 0) : [];
  return body;
}

/** The first problem with a draft, as { field, text }, or null. Mirrors the Worker's rules. */
export function validatePost(kind, draft, photoCount) {
  const value = (key) => String(draft?.[key] ?? "").trim();
  for (const key of ["brand", "mold", "plastic", "color"]) {
    if (value(key).length > LF_LIMITS[key]) return { field: key, text: "That's too long." };
  }
  if (value("area").length > LF_LIMITS.areaDetail) return { field: "area", text: "That's too long." };
  if (kind === "found" && photoCount < 1) return { field: "photos", text: "Add at least one photo of the disc." };
  if (kind === "found" && draft?.holding === "club_bin" && !value("binNote")) return { field: "binNote", text: "Say which club bin you left it in." };
  if (kind === "lost" && !value("brand") && !value("mold") && !value("color") && !value("privateInk")) {
    return { field: "mold", text: "Add the mold, brand, colour or what's written on it so we can match it." };
  }
  if (kind === "lost" && value("privateInk").length > LF_LIMITS.privateInk) return { field: "privateInk", text: "That's too long." };
  return null;
}

export function lfErrorMessage(data, fallback = "That didn't work. Please try again.") {
  const messages = {
    network: "Couldn't reach the club. Check your connection and try again.",
    rate_limited: "Too many tries. Wait a few minutes and try again.",
    unauthorized: "Sign in or verify your email first.",
    invalid_photo: "That photo couldn't be used. Try a JPEG or PNG under 1.5 MB.",
    invalid_post: "Check the highlighted details and try again.",
    invalid_claim: "Tell the finder how they'll know it's yours (what's written on it, a mark, the colour).",
    own_post: "That's your own post.",
    already_claimed: "You've already claimed this disc.",
    not_open: "This changed in the meantime. Refresh to see where it stands.",
    not_returned: "The finder hasn't marked it returned yet.",
    return_in_progress: "A return is already in progress.",
    already_celebrated: "You've already posted a celebration for this return.",
    not_confirmed: "Celebrations open once the owner confirms they got the disc back.",
    already_reported: "You already reported this. An admin will take a look.",
    use_messages: "You're both members: keep talking in Messages.",
    storage_unavailable: "Photo uploads are unavailable right now.",
    guest_unavailable: "Email checks are unavailable right now. Members can sign in.",
    invalid_code: "That code didn't match or has expired. Request a new one.",
    not_found: "That's no longer available.",
    request_too_large: "Those photos are too large. Try fewer or smaller photos.",
  };
  return messages[data?.error] || fallback;
}
