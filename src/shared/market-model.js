// Pure helpers for the used-disc marketplace in the Pro Shop (no DOM, node-tested).
import { safeExternalUrl } from "./safe-url.js";

export const DISC_TYPES = [
  ["driver", "Distance driver"],
  ["fairway", "Fairway driver"],
  ["midrange", "Midrange"],
  ["putter", "Putter"],
];

// What a listing sells. Bags and accessories have no disc type, plastic, weight or flight numbers.
export const ITEM_KINDS = [
  ["disc", "Disc"],
  ["bag", "Bag"],
  ["accessory", "Accessory"],
];

// What a My Bag accessory is, and what an accessory listing sells (the Worker keeps the same list).
export const ACCESSORY_KINDS = [
  ["cart", "Cart"], ["towel", "Towel"], ["mini", "Mini marker"], ["rangefinder", "Rangefinder"], ["retriever", "Disc retriever"],
  ["umbrella", "Umbrella"], ["shoes", "Shoes"], ["rain_gear", "Rain gear"], ["seat", "Seat"], ["light", "Light / headlamp"], ["other", "Other"],
];

/** "Sell a disc" / "Sell a bag" / "Sell an accessory". */
export function sellHeading(itemKind) {
  return itemKind === "bag" ? "Sell a bag" : itemKind === "accessory" ? "Sell an accessory" : "Sell a disc";
}

// PDGA-style 1-10 condition scale, short enough for a select and a legend.
export const CONDITION_LEGEND = [
  [10, "New, never thrown"],
  [9, "Like new, thrown a few times"],
  [8, "Light wear"],
  [7, "Some wear, small dings"],
  [6, "Moderate wear"],
  [5, "Used, clear dings"],
  [4, "Well used"],
  [3, "Heavy wear"],
  [2, "Very beat"],
  [1, "Beat"],
];

export const REPORT_REASONS = [
  ["scam", "Looks like a scam"],
  ["prohibited", "Not allowed here"],
  ["wrong_info", "Wrong or misleading details"],
  ["abusive", "Abusive or rude"],
  ["spam", "Spam"],
  ["other", "Something else"],
];

export const FEEDBACK_RATINGS = [
  ["positive", "Positive"],
  ["neutral", "Neutral"],
  ["negative", "Negative"],
];

export const SAFETY_NOTE = "Payments go directly to the seller. Meet at club events when you can. Use PayPal Goods & Services for shipped discs.";
export const GUEST_UNAVAILABLE = "Guest checkout is unavailable right now. Members can sign in.";
export const MEMBERS_ONLY_LISTING = "Only members can list discs. Members can sign in.";
export const SELLER_EMAIL_LABEL = "Email for buyer alerts (required to sell)";
export const SELLER_EMAIL_HINT = "Buyer alerts go here. We'll send a confirmation. It's never shown to anyone.";

/** Whole hours left to relist a withdrawn listing (rounded up), or 0 when the window has closed. */
export function relistHoursLeft(relistUntil, now = Date.now()) {
  const text = String(relistUntil || "");
  const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(" ", "T") + "Z" : text);
  if (!Number.isFinite(at) || at <= now) return 0;
  return Math.max(1, Math.ceil((at - now) / 3_600_000));
}

/** "Withdrawn — relist within 23 h" while a withdrawn listing can still come back; null otherwise. */
export function withdrawnLabel(listing, now = Date.now()) {
  if (!listing || listing.status !== "withdrawn") return null;
  const hours = listing.withdrawal === "pending_final" ? relistHoursLeft(listing.relistUntil, now) : 0;
  return hours ? `Withdrawn — relist within ${hours} h` : "Withdrawn";
}
export const PENDING_NOTE = "Pending — another buyer is finishing this";

export const LISTING_STATUS_LABELS = {
  active: "Available",
  pending: "Pending",
  sold: "Sold",
  traded: "Traded",
  withdrawn: "Withdrawn",
};

export const LIMITS = {
  brand: 40, mold: 40, plastic: 40, color: 30, conditionNotes: 200, tradeFor: 200, location: 80,
  comment: 300, reply: 300, notes: 300, offer: 300, name: 40, email: 120,
};

export function discTypeLabel(value) {
  const row = DISC_TYPES.find(([key]) => key === value);
  return row ? row[1] : "";
}

/** The same 1-10 scale for a bag or an accessory, worded for gear (it isn't thrown). */
export function conditionLegend(itemKind) {
  if (!itemKind || itemKind === "disc") return CONDITION_LEGEND;
  return CONDITION_LEGEND.map(([score, text]) => [score, score === 10 ? "New, never used" : score === 9 ? "Like new, used a few times" : text.replace("dings", "marks")]);
}

/** A disc's type ("Midrange"), or what a bag / accessory listing is ("Bag", "Cart"). */
export function itemKindLabel(listing) {
  if (listing?.itemKind === "bag") return "Bag";
  if (listing?.itemKind === "accessory") return ACCESSORY_KINDS.find(([key]) => key === listing.gearType)?.[1] || "Accessory";
  return discTypeLabel(listing?.discType);
}

export function conditionText(value, itemKind = "disc") {
  const n = Number(value);
  const row = conditionLegend(itemKind).find(([score]) => score === n);
  return row ? `${n}/10 · ${row[1]}` : "";
}

export function money(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(Math.round(value));
  const whole = Math.floor(abs / 100);
  const part = abs % 100;
  const text = "$" + whole.toLocaleString("en-US") + (part ? "." + String(part).padStart(2, "0") : "");
  return value < 0 ? "-" + text : text;
}

/** "$12.50" style text a buyer types or reads, from whole cents. Always two decimals. */
export function exactMoney(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0));
  return "$" + Math.floor(value / 100).toLocaleString("en-US") + "." + String(value % 100).padStart(2, "0");
}

/** Dollars typed by a person -> cents, or null. "18", "18.5", "$18.50". */
export function dollarsToCents(text) {
  const raw = String(text ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function centsToDollarsInput(cents) {
  if (cents == null || cents === "") return "";
  const value = Number(cents);
  if (!Number.isFinite(value)) return "";
  return value % 100 ? (value / 100).toFixed(2) : String(value / 100);
}

/** eBay-style "98% positive (51)". */
export function feedbackLabel(summary) {
  const count = Number(summary?.count) || 0;
  if (!count) return "No feedback yet";
  const percent = summary?.percent;
  if (percent == null || !Number.isFinite(Number(percent))) return `Neutral only (${count})`;
  return `${Math.round(Number(percent))}% positive (${count})`;
}

export function flightText(flight) {
  if (!flight || typeof flight !== "object") return "";
  const parts = [flight.speed, flight.glide, flight.turn, flight.fade];
  if (parts.every((value) => value == null || value === "")) return "";
  return parts.map((value) => (value == null || value === "" ? "–" : String(value))).join(" / ");
}

export function weightRangeText(min, max) {
  if (min && max) return min === max ? `${min}g` : `${min}–${max}g`;
  if (min) return `${min}g or more`;
  if (max) return `Up to ${max}g`;
  return "";
}

export function listingTitle(listing) {
  if (listing?.title) return String(listing.title);
  return [listing?.brand, listing?.plastic, listing?.mold].filter(Boolean).join(" ") || "Disc";
}

export function listingMeta(listing) {
  return [
    itemKindLabel(listing),
    listing?.weightG ? listing.weightG + "g" : "",
    listing?.color || "",
    listing?.condition ? listing.condition + "/10" : "",
  ].filter(Boolean).join(" · ");
}

export function priceLine(listing) {
  if (listing?.priceCents != null) return money(listing.priceCents);
  return listing?.openToTrade ? "Trade only" : "";
}

// ---- Payment handles (mirrors the Worker's validation; the Worker is authoritative) ----

const EMAIL_RE = /^[^@\s<>",;/:]+@[^@\s<>",;/:]+\.[^@\s<>",;/:]+$/;

/** Strip the bits people paste around a handle: a link prefix, "@" or "$". Never keeps a URL. */
export function cleanHandleInput(kind, raw) {
  let text = String(raw ?? "").trim();
  if (kind === "paypal") {
    text = text.replace(/^https?:\/\//i, "").replace(/^(www\.)?paypal\.me\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
  } else if (kind === "cashapp") {
    text = text.replace(/^https?:\/\//i, "").replace(/^(www\.)?cash\.app\//i, "").replace(/^\$/, "").replace(/\/.*$/, "");
  }
  return text.trim();
}

export function validPaypalMe(value) {
  return /^[A-Za-z0-9]{1,20}$/.test(String(value ?? ""));
}

export function validCashtag(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_]{1,20}$/.test(text) && /[A-Za-z]/.test(text);
}

export function validEmail(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 && text.length <= LIMITS.email && EMAIL_RE.test(text);
}

export function zellePhoneDigits(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : "";
}

/** A stored Zelle handle as people read it: 10 digits become "(252) 555-0134"; emails are unchanged. */
export function zelleDisplay(value) {
  const text = String(value ?? "");
  return /^\d{10}$/.test(text) ? `(${text.slice(0, 3)}) ${text.slice(3, 6)}-${text.slice(6)}` : text;
}

export function validZelle(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (text.includes("@")) return validEmail(text);
  if (/[^\d\s()+.-]/.test(text)) return false;
  return Boolean(zellePhoneDigits(text));
}

/** Client-side check of the seller payment settings form. Empty fields are allowed (not set). */
export function validateSettings(draft) {
  const paypalMe = cleanHandleInput("paypal", draft?.paypalMe);
  const cashtag = cleanHandleInput("cashapp", draft?.cashtag);
  const zelle = String(draft?.zelle ?? "").trim();
  const notifyEmail = String(draft?.notifyEmail ?? "").trim();
  if (paypalMe && !validPaypalMe(paypalMe)) return { ok: false, field: "paypalMe", message: "PayPal.me usernames are 1–20 letters or numbers." };
  if (cashtag && !validCashtag(cashtag)) return { ok: false, field: "cashtag", message: "A $cashtag is up to 20 letters, numbers or underscores." };
  if (zelle && !validZelle(zelle)) return { ok: false, field: "zelle", message: "Zelle needs an email address or a 10-digit US phone number." };
  if (notifyEmail && !validEmail(notifyEmail)) return { ok: false, field: "notifyEmail", message: "Enter a valid email, or leave it blank." };
  return { ok: true, value: { paypalMe, cashtag, zelle, notifyEmail } };
}

function amountPath(cents) {
  return (Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2);
}

/** The pay links the Worker builds, rebuilt for tests and as a cross-check. */
export function buildPayUrl(method, handle, cents) {
  if (method === "paypal" && validPaypalMe(handle)) return `https://paypal.me/${handle}/${amountPath(cents)}`;
  const tag = String(handle ?? "").replace(/^\$/, "");
  if (method === "cashapp" && validCashtag(tag)) return `https://cash.app/$${tag}/${amountPath(cents)}`;
  return "";
}

const PAY_HOSTS = { paypal: "paypal.me", cashapp: "cash.app" };

/** A pay link is shown only when it is https on the method's own host. Anything else renders as no link. */
export function safePayUrl(method, url) {
  const safe = safeExternalUrl(url);
  if (!safe) return "";
  try {
    const parsed = new URL(safe);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return parsed.hostname === PAY_HOSTS[method] ? safe : "";
  } catch {
    return "";
  }
}

export function payMethodLabel(method) {
  return method === "paypal" ? "PayPal" : method === "cashapp" ? "Cash App" : method === "zelle" ? "Zelle" : "";
}

// ---- Listing form ----

function optionalNumber(text, { min, max, step = 1 }) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false };
  if (Math.round(n / step) * step !== n) return { ok: false };
  return { ok: true, value: n };
}

/** Form strings -> the POST /market/listings body (without photos), or the first problem. */
export function listingPayload(draft) {
  const text = (key) => String(draft?.[key] ?? "").trim();
  const itemKind = ITEM_KINDS.some(([key]) => key === draft?.itemKind) ? draft.itemKind : "disc";
  const disc = itemKind === "disc";
  const gearType = itemKind === "accessory" ? text("gearType") : "";
  if (itemKind === "accessory" && !ACCESSORY_KINDS.some(([key]) => key === gearType)) return { ok: false, field: "gearType", message: "Choose what it is." };
  const brand = text("brand");
  const mold = text("mold");
  if (!mold) return { ok: false, field: "mold", message: disc ? "Enter the mold (disc name)." : "Enter what it is (the make and model)." };
  for (const key of ["brand", "mold", "plastic", "color", "conditionNotes", "tradeFor", "location"]) {
    if (text(key).length > LIMITS[key]) return { ok: false, field: key, message: "That's too long." };
  }
  const discType = text("discType");
  if (disc && !DISC_TYPES.some(([key]) => key === discType)) return { ok: false, field: "discType", message: "Choose the disc type." };
  const condition = Number(text("condition"));
  if (!Number.isInteger(condition) || condition < 1 || condition > 10) return { ok: false, field: "condition", message: "Choose a condition from 1 to 10." };
  const flight = { speed: null, glide: null, turn: null, fade: null };
  for (const [key, range] of disc ? [["speed", { min: 1, max: 15, step: 0.5 }], ["glide", { min: 0, max: 7, step: 0.5 }],
    ["turn", { min: -5, max: 2, step: 0.5 }], ["fade", { min: 0, max: 6, step: 0.5 }]] : []) {
    const parsed = optionalNumber(draft?.[key], range);
    if (!parsed.ok) return { ok: false, field: key, message: "Flight numbers: speed 1–15, glide 0–7, turn -5 to 2, fade 0–6." };
    flight[key] = parsed.value;
  }
  const weight = disc ? optionalNumber(draft?.weightG, { min: 100, max: 200 }) : { ok: true, value: null };
  if (!weight.ok) return { ok: false, field: "weightG", message: "Weight is in grams, 100–200." };
  const openToTrade = Boolean(draft?.openToTrade);
  const priceText = text("price");
  const priceCents = priceText ? dollarsToCents(priceText) : null;
  if (priceText && (priceCents == null || priceCents < 100 || priceCents > 100000)) {
    return { ok: false, field: "price", message: "Price must be between $1 and $1,000." };
  }
  if (priceCents == null && !openToTrade) return { ok: false, field: "price", message: "Set a price, mark it open to trades, or both." };
  const quantity = Number(text("quantity") || "1");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return { ok: false, field: "quantity", message: "Quantity is 1 to 20." };
  return {
    ok: true,
    value: {
      itemKind, gearType, brand, mold, plastic: disc ? text("plastic") : "", discType: disc ? discType : null, ...flight, weightG: weight.value, color: text("color"),
      condition, conditionNotes: text("conditionNotes"), priceCents, openToTrade,
      tradeFor: openToTrade ? text("tradeFor") : "", quantity, location: text("location"),
    },
  };
}

export function listingDraft(listing) {
  const flight = listing?.flight || {};
  const num = (value) => (value == null ? "" : String(value));
  return {
    itemKind: listing?.itemKind || "disc", gearType: listing?.gearType || "",
    brand: listing?.brand || "", mold: listing?.mold || "", plastic: listing?.plastic || "",
    discType: listing?.discType || "", speed: num(flight.speed), glide: num(flight.glide), turn: num(flight.turn), fade: num(flight.fade),
    weightG: num(listing?.weightG), color: listing?.color || "", condition: listing?.condition ? String(listing.condition) : "",
    conditionNotes: listing?.conditionNotes || "", price: centsToDollarsInput(listing?.priceCents),
    openToTrade: Boolean(listing?.openToTrade), tradeFor: listing?.tradeFor || "",
    quantity: listing?.quantity ? String(listing.quantity) : "1", location: listing?.location || "",
  };
}

export function wantedPayload(draft) {
  const text = (key) => String(draft?.[key] ?? "").trim();
  const brand = text("brand");
  const mold = text("mold");
  if (!brand && !mold) return { ok: false, field: "mold", message: "Enter at least a brand or a mold." };
  for (const key of ["brand", "mold", "plastic"]) if (text(key).length > LIMITS[key]) return { ok: false, field: key, message: "That's too long." };
  if (text("notes").length > LIMITS.notes) return { ok: false, field: "notes", message: "Notes are up to 300 characters." };
  const discType = text("discType");
  if (discType && !DISC_TYPES.some(([key]) => key === discType)) return { ok: false, field: "discType", message: "Choose a disc type." };
  const weightMin = optionalNumber(draft?.weightMin, { min: 100, max: 200 });
  const weightMax = optionalNumber(draft?.weightMax, { min: 100, max: 200 });
  if (!weightMin.ok || !weightMax.ok) return { ok: false, field: "weightMin", message: "Weights are in grams, 100–200." };
  if (weightMin.value != null && weightMax.value != null && weightMin.value > weightMax.value) {
    return { ok: false, field: "weightMax", message: "The maximum weight is below the minimum." };
  }
  const condition = text("conditionMin");
  const conditionMin = condition ? Number(condition) : null;
  if (conditionMin != null && (!Number.isInteger(conditionMin) || conditionMin < 1 || conditionMin > 10)) {
    return { ok: false, field: "conditionMin", message: "Choose a condition from 1 to 10." };
  }
  const priceText = text("maxPrice");
  const maxPriceCents = priceText ? dollarsToCents(priceText) : null;
  if (priceText && (maxPriceCents == null || maxPriceCents < 100 || maxPriceCents > 100000)) {
    return { ok: false, field: "maxPrice", message: "Max price must be between $1 and $1,000." };
  }
  return {
    ok: true,
    value: {
      brand, mold, plastic: text("plastic"), discType: discType || null, weightMin: weightMin.value, weightMax: weightMax.value,
      conditionMin, maxPriceCents, openToTrade: Boolean(draft?.openToTrade), notes: text("notes"),
    },
  };
}

// ---- Pro Shop hash routes ----

const TRADER_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function positiveId(text) {
  return /^\d{1,12}$/.test(text || "") && Number(text) > 0 ? Number(text) : null;
}

/** "#market/listing/12?x=y" -> { section, view, id, key, query }. Unknown hashes are the club shop. */
export function parseShopRoute(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const [path, search = ""] = raw.split("?", 2);
  const query = new URLSearchParams(search);
  const parts = path.split("/").filter(Boolean);
  const shop = { section: "shop", view: "shop", id: null, key: null, query };
  if (parts[0] === "market") {
    if (!parts[1]) return { section: "market", view: "browse", id: null, key: null, query };
    if (parts[1] === "sell" && parts.length === 2) return { section: "market", view: "sell", id: null, key: null, query };
    if ((parts[1] === "listing" || parts[1] === "edit") && parts.length === 3 && positiveId(parts[2])) {
      return { section: "market", view: parts[1], id: positiveId(parts[2]), key: null, query };
    }
    if (parts[1] === "trader" && parts.length === 3 && TRADER_KEY.test(parts[2])) {
      return { section: "market", view: "trader", id: null, key: parts[2], query };
    }
    return { section: "market", view: "browse", id: null, key: null, query };
  }
  if (parts[0] === "wanted") {
    if (parts[1] === "new" && parts.length === 2) return { section: "wanted", view: "new", id: null, key: null, query };
    if (parts.length === 2 && positiveId(parts[1])) return { section: "wanted", view: "detail", id: positiveId(parts[1]), key: null, query };
    return { section: "wanted", view: "list", id: null, key: null, query };
  }
  if (parts[0] === "my-market") return { section: "mine", view: "mine", id: null, key: null, query };
  return shop;
}

export function listingHref(id) { return "#market/listing/" + id; }
export function traderHref(key) { return TRADER_KEY.test(String(key || "")) ? "#market/trader/" + key : "#market"; }
export function wantedHref(id) { return "#wanted/" + id; }

export const EMPTY_FILTERS = {
  q: "", kind: "", type: "", brand: "", plastic: "", wmin: "", wmax: "", cond: "", pmin: "", pmax: "", trade: false, seller: "", sort: "newest",
};

/** Browse filters -> the /market/listings query string. Prices are whole dollars, weights grams. */
export function listingsQuery(filters, offset = 0) {
  const params = new URLSearchParams();
  const f = { ...EMPTY_FILTERS, ...(filters || {}) };
  const whole = (value, min, max) => {
    const n = Number(String(value ?? "").trim());
    return String(value ?? "").trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? String(n) : "";
  };
  if (f.q.trim()) params.set("q", f.q.trim().slice(0, 60));
  if (ITEM_KINDS.some(([key]) => key === f.kind)) params.set("kind", f.kind);
  if (DISC_TYPES.some(([key]) => key === f.type)) params.set("type", f.type);
  if (f.brand) params.set("brand", f.brand.slice(0, 40));
  if (f.plastic) params.set("plastic", f.plastic.slice(0, 40));
  if (whole(f.wmin, 100, 200)) params.set("wmin", whole(f.wmin, 100, 200));
  if (whole(f.wmax, 100, 200)) params.set("wmax", whole(f.wmax, 100, 200));
  if (whole(f.cond, 1, 10)) params.set("cond", whole(f.cond, 1, 10));
  if (whole(f.pmin, 0, 1000)) params.set("pmin", whole(f.pmin, 0, 1000));
  if (whole(f.pmax, 0, 1000)) params.set("pmax", whole(f.pmax, 0, 1000));
  if (f.trade) params.set("trade", "1");
  if (TRADER_KEY.test(f.seller || "")) params.set("seller", f.seller);
  if (["price_asc", "price_desc", "condition"].includes(f.sort)) params.set("sort", f.sort);
  if (offset > 0) params.set("offset", String(offset));
  const text = params.toString();
  return text ? "?" + text : "";
}

export function activeFilterCount(filters) {
  const f = { ...EMPTY_FILTERS, ...(filters || {}) };
  return ["kind", "type", "brand", "plastic", "wmin", "wmax", "cond", "pmin", "pmax"].filter((key) => String(f[key] || "").trim()).length + (f.trade ? 1 : 0);
}

/** "2026-11-17 14:03:00" (UTC) -> "Nov 17". */
export function shortDate(value) {
  const text = String(value || "");
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + "Z" : text;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

export function wantedMeta(wanted) {
  return [
    discTypeLabel(wanted?.discType),
    weightRangeText(wanted?.weightMin, wanted?.weightMax),
    wanted?.conditionMin ? `Condition ${wanted.conditionMin}+` : "",
    wanted?.maxPriceCents != null ? "Up to " + money(wanted.maxPriceCents) : "",
  ].filter(Boolean).join(" · ");
}
