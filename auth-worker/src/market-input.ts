// Marketplace request validation and payment-link building. Pure functions: everything a client sends is
// re-checked here; handlers never trust ids, prices, statuses or handles from the body.

export const DISC_TYPES = ["driver", "fairway", "midrange", "putter"] as const;
export type DiscType = (typeof DISC_TYPES)[number];
/** What a listing sells. Bags and accessories have no disc type, plastic, weight or flight numbers. */
export const ITEM_KINDS = ["disc", "bag", "accessory"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** What a My Bag accessory is, and what an accessory listing sells (the same list). */
export const ACCESSORY_KINDS = ["cart", "towel", "mini", "rangefinder", "retriever", "umbrella", "shoes", "rain_gear", "seat", "light", "other"] as const;
export const REPORT_REASONS = ["scam", "prohibited", "wrong_info", "abusive", "spam", "other"] as const;
export const RATINGS = ["positive", "neutral", "negative"] as const;
export type Rating = (typeof RATINGS)[number];

export const MAX_PHOTOS = 4;
export const PRICE_MIN_CENTS = 100;
export const PRICE_MAX_CENTS = 100_000;
export const COMMENT_MAX = 300;

type Fail = { ok: false; field: string };
type Ok<T> = { ok: true; value: T };

/** Single-line text: control characters removed, whitespace collapsed, trimmed. "" when absent. */
export function cleanLine(value: unknown, max: number): string | null {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? null : text;
}

/** Multi-line text (comments, notes): keeps newlines, strips other control characters. */
export function cleanText(value: unknown, max: number): string | null {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? null : text;
}

function optionalNumber(value: unknown, min: number, max: number, step: number): number | null | undefined {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  if (Math.abs(n / step - Math.round(n / step)) > 1e-9) return undefined;
  return n;
}

function optionalInt(value: unknown, min: number, max: number): number | null | undefined {
  return optionalNumber(value, min, max, 1);
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export interface ListingInput {
  itemKind: ItemKind;
  /** What an accessory is (as in My Bag: cart, towel…); "" for discs and bags. */
  gearType: string;
  brand: string;
  /** The disc's mold, or a bag's / accessory's name or model. */
  mold: string;
  plastic: string;
  discType: DiscType | null;
  speed: number | null;
  glide: number | null;
  turn: number | null;
  fade: number | null;
  weightG: number | null;
  color: string;
  condition: number;
  conditionNotes: string;
  priceCents: number | null;
  openToTrade: boolean;
  tradeFor: string;
  quantity: number;
  location: string;
}

export function parseListing(body: Record<string, unknown>): Ok<ListingInput> | Fail {
  const itemKind = body.itemKind == null || body.itemKind === "" ? "disc" : body.itemKind;
  if (typeof itemKind !== "string" || !(ITEM_KINDS as readonly string[]).includes(itemKind)) return { ok: false, field: "itemKind" };
  const disc = itemKind === "disc";
  const gearType = itemKind === "accessory" ? body.gearType : "";
  if (itemKind === "accessory" && (typeof gearType !== "string" || !(ACCESSORY_KINDS as readonly string[]).includes(gearType))) {
    return { ok: false, field: "gearType" };
  }
  const brand = cleanLine(body.brand, 40);
  if (brand == null) return { ok: false, field: "brand" };
  const mold = cleanLine(body.mold, 40);
  if (!mold) return { ok: false, field: "mold" };
  // Disc-only details: a bag or an accessory never carries them (whatever the body says).
  const plastic = disc ? cleanLine(body.plastic, 40) : "";
  if (plastic == null) return { ok: false, field: "plastic" };
  const discType = typeof body.discType === "string" && (DISC_TYPES as readonly string[]).includes(body.discType) ? body.discType as DiscType : null;
  if (disc && !discType) return { ok: false, field: "discType" };
  const speed = disc ? optionalNumber(body.speed, 1, 15, 0.5) : null;
  if (speed === undefined) return { ok: false, field: "speed" };
  const glide = disc ? optionalNumber(body.glide, 0, 7, 0.5) : null;
  if (glide === undefined) return { ok: false, field: "glide" };
  const turn = disc ? optionalNumber(body.turn, -5, 2, 0.5) : null;
  if (turn === undefined) return { ok: false, field: "turn" };
  const fade = disc ? optionalNumber(body.fade, 0, 6, 0.5) : null;
  if (fade === undefined) return { ok: false, field: "fade" };
  const weightG = disc ? optionalInt(body.weightG, 100, 200) : null;
  if (weightG === undefined) return { ok: false, field: "weightG" };
  const color = cleanLine(body.color, 30);
  if (color == null) return { ok: false, field: "color" };
  const condition = optionalInt(body.condition, 1, 10);
  if (condition == null) return { ok: false, field: "condition" };
  const conditionNotes = cleanText(body.conditionNotes, 200);
  if (conditionNotes == null) return { ok: false, field: "conditionNotes" };
  const priceCents = optionalInt(body.priceCents, PRICE_MIN_CENTS, PRICE_MAX_CENTS);
  if (priceCents === undefined) return { ok: false, field: "priceCents" };
  const openToTrade = bool(body.openToTrade);
  if (priceCents == null && !openToTrade) return { ok: false, field: "priceCents" };
  const tradeFor = cleanText(body.tradeFor, 200);
  if (tradeFor == null) return { ok: false, field: "tradeFor" };
  const quantity = body.quantity == null || body.quantity === "" ? 1 : optionalInt(body.quantity, 1, 20);
  if (quantity == null) return { ok: false, field: "quantity" };
  const location = cleanLine(body.location, 80);
  if (location == null) return { ok: false, field: "location" };
  return {
    ok: true,
    value: {
      itemKind: itemKind as ItemKind, gearType: String(gearType), brand, mold, plastic, discType: disc ? discType : null,
      speed, glide, turn, fade, weightG, color, condition, conditionNotes,
      priceCents, openToTrade, tradeFor: openToTrade ? tradeFor : "", quantity, location,
    },
  };
}

export function listingTitle(row: { brand?: string | null; plastic?: string | null; mold?: string | null }): string {
  return [row.brand, row.plastic, row.mold].map((part) => String(part || "").trim()).filter(Boolean).join(" ").slice(0, 130) || "Disc";
}

export interface WantedInput {
  brand: string;
  mold: string;
  plastic: string;
  discType: DiscType | null;
  weightMin: number | null;
  weightMax: number | null;
  conditionMin: number | null;
  maxPriceCents: number | null;
  openToTrade: boolean;
  notes: string;
}

export function parseWanted(body: Record<string, unknown>): Ok<WantedInput> | Fail {
  const brand = cleanLine(body.brand, 40);
  if (brand == null) return { ok: false, field: "brand" };
  const mold = cleanLine(body.mold, 40);
  if (mold == null) return { ok: false, field: "mold" };
  if (!brand && !mold) return { ok: false, field: "mold" };
  const plastic = cleanLine(body.plastic, 40);
  if (plastic == null) return { ok: false, field: "plastic" };
  let discType: DiscType | null = null;
  if (body.discType != null && body.discType !== "") {
    if (typeof body.discType !== "string" || !(DISC_TYPES as readonly string[]).includes(body.discType)) return { ok: false, field: "discType" };
    discType = body.discType as DiscType;
  }
  const weightMin = optionalInt(body.weightMin, 100, 200);
  if (weightMin === undefined) return { ok: false, field: "weightMin" };
  const weightMax = optionalInt(body.weightMax, 100, 200);
  if (weightMax === undefined || (weightMin != null && weightMax != null && weightMax < weightMin)) return { ok: false, field: "weightMax" };
  const conditionMin = optionalInt(body.conditionMin, 1, 10);
  if (conditionMin === undefined) return { ok: false, field: "conditionMin" };
  const maxPriceCents = optionalInt(body.maxPriceCents, PRICE_MIN_CENTS, PRICE_MAX_CENTS);
  if (maxPriceCents === undefined) return { ok: false, field: "maxPriceCents" };
  const notes = cleanText(body.notes, 300);
  if (notes == null) return { ok: false, field: "notes" };
  return { ok: true, value: { brand, mold, plastic, discType, weightMin, weightMax, conditionMin, maxPriceCents, openToTrade: bool(body.openToTrade), notes } };
}

export function wantedTitle(row: { brand?: string | null; plastic?: string | null; mold?: string | null; disc_type?: string | null }): string {
  const parts = [row.brand, row.plastic, row.mold].map((part) => String(part || "").trim()).filter(Boolean);
  if (!parts.length && row.disc_type) parts.push(row.disc_type);
  return parts.join(" ").slice(0, 130) || "Disc";
}

// ---- Payment handles ----

const PAYPAL_RE = /^[A-Za-z0-9]{1,20}$/;
const CASHTAG_RE = /^[A-Za-z0-9_]{1,20}$/;
const EMAIL_RE = /^[^@\s<>",;:/\\]+@[^@\s<>",;:/\\]+\.[^@\s<>",;:/\\]+$/;

/** PayPal.me username: 1-20 letters/digits. "" clears. null = invalid. */
export function parsePaypalMe(value: unknown): string | null {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return "";
  return PAYPAL_RE.test(text) ? text : null;
}

/** Cash App $cashtag without the "$": 1-20 letters/digits/underscore including a letter. */
export function parseCashtag(value: unknown): string | null {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^\$/, "");
  if (!text) return "";
  return CASHTAG_RE.test(text) && /[A-Za-z]/.test(text) ? text : null;
}

export function parseEmail(value: unknown, max = 254): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text.length <= max && EMAIL_RE.test(text) ? text : null;
}

/** Zelle: an email, or a 10-digit US phone (an optional leading +1/1 and punctuation are accepted). Stored
 *  as the lower-cased email or as 10 digits. */
export function parseZelle(value: unknown): string | null {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return "";
  if (text.includes("@")) return parseEmail(text, 120);
  if (!/^[+\d\s().-]{10,20}$/.test(text)) return null;
  let digits = text.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? digits : null;
}

export function zelleDisplay(stored: string): string {
  return /^\d{10}$/.test(stored) ? `(${stored.slice(0, 3)}) ${stored.slice(3, 6)}-${stored.slice(6)}` : stored;
}

export interface SellerSettings {
  paypalMe: string;
  cashtag: string;
  zelle: string;
  notifyEmail: string;
}

export function parseSettings(body: Record<string, unknown>): Ok<SellerSettings> | Fail {
  const paypalMe = parsePaypalMe(body.paypalMe);
  if (paypalMe == null) return { ok: false, field: "paypalMe" };
  const cashtag = parseCashtag(body.cashtag);
  if (cashtag == null) return { ok: false, field: "cashtag" };
  const zelle = parseZelle(body.zelle);
  if (zelle == null) return { ok: false, field: "zelle" };
  let notifyEmail = "";
  if (body.notifyEmail != null && body.notifyEmail !== "") {
    const parsed = parseEmail(body.notifyEmail, 120);
    if (!parsed) return { ok: false, field: "notifyEmail" };
    notifyEmail = parsed;
  }
  return { ok: true, value: { paypalMe, cashtag, zelle, notifyEmail } };
}

export function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export type PayMethod =
  | { method: "paypal"; label: "PayPal"; handle: string; url: string }
  | { method: "cashapp"; label: "Cash App"; handle: string; url: string }
  | { method: "zelle"; label: "Zelle"; handle: string; instruction: string };

/** Checkout links for only the methods the seller set. Handles are re-validated so a bad stored value is
 *  dropped rather than turned into a link. */
export function payMethods(settings: Partial<SellerSettings> | null, amountCents: number): PayMethod[] {
  if (!settings || !Number.isInteger(amountCents) || amountCents <= 0) return [];
  const amount = dollars(amountCents);
  const out: PayMethod[] = [];
  const paypal = parsePaypalMe(settings.paypalMe);
  if (paypal) out.push({ method: "paypal", label: "PayPal", handle: paypal, url: `https://paypal.me/${encodeURIComponent(paypal)}/${amount}` });
  const cashtag = parseCashtag(settings.cashtag);
  if (cashtag) out.push({ method: "cashapp", label: "Cash App", handle: "$" + cashtag, url: `https://cash.app/$${encodeURIComponent(cashtag)}/${amount}` });
  const zelle = parseZelle(settings.zelle);
  if (zelle) {
    const handle = zelleDisplay(zelle);
    out.push({ method: "zelle", label: "Zelle", handle, instruction: `Send $${amount} via Zelle to ${handle}` });
  }
  return out;
}

/** Guest display name: 2-40 visible characters; no emails or links so a name can't leak an address. */
export function parseDisplayName(value: unknown): string | null {
  const text = cleanLine(value, 40);
  if (!text || text.length < 2) return null;
  if (/[@<>]|:\/\/|www\.|\.(com|net|org|io)\b/i.test(text)) return null;
  return text;
}

export function parseIdList(value: unknown, max: number): number[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const ids: number[] = [];
  for (const raw of value) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}
