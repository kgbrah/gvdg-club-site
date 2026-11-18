// "Sell this" from My Bag: the member app leaves the item's details in this tab's sessionStorage (never in the
// address) and opens the sell form, which fills itself in. The item's bag photos start on the listing; the Worker
// copies them from the bag when it's posted (the bag keeps its private originals). A photo on a listing is public, so
// the form says so and each one can come off before posting.
import { ACCESSORY_KINDS } from "../shared/market-model.js";

export const MARKET_BAG_HANDOFF_KEY = "gvdg_market_bag_handoff";
export const MARKET_BAG_HREF = "pro-shop.html#market/sell?from=bag";
const DISC_REF = /^disc:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACCESSORY_REF = /^accessory:[1-9]\d{0,9}$/;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** What a bag ref sells: "disc:<id>" a disc, "bag" the bag, "accessory:<id>" an accessory; "" for anything else. */
export function bagRefKind(ref) {
  const text = String(ref || "");
  return DISC_REF.test(text) ? "disc" : text === "bag" ? "bag" : ACCESSORY_REF.test(text) ? "accessory" : "";
}

/** The bag item handed over by My Bag, or null. */
export function readMarketBagHandoff() {
  try {
    const data = JSON.parse(sessionStorage.getItem(MARKET_BAG_HANDOFF_KEY) || "null");
    const itemKind = bagRefKind(data?.ref);
    if (!itemKind) return null;
    const weight = Number(data.weightG);
    const gearType = String(data.gearType || "");
    return {
      ref: String(data.ref), itemKind,
      gearType: itemKind === "accessory" ? (ACCESSORY_KINDS.some(([key]) => key === gearType) ? gearType : "other") : "",
      brand: clean(data.brand, 40), mold: clean(data.mold, 40), plastic: itemKind === "disc" ? clean(data.plastic, 40) : "",
      color: clean(data.color, 30),
      weightG: itemKind === "disc" && Number.isInteger(weight) && weight >= 100 && weight <= 200 ? String(weight) : "",
      photos: (Array.isArray(data.photos) ? data.photos : []).filter((id) => Number.isInteger(id) && id > 0).slice(0, 4),
    };
  } catch {
    return null;
  }
}

export function clearMarketBagHandoff() {
  try { sessionStorage.removeItem(MARKET_BAG_HANDOFF_KEY); } catch { /* nothing kept */ }
}

/** My Bag's side: remember the item and open the sell form. */
export function sellFromBag(item) {
  try {
    sessionStorage.setItem(MARKET_BAG_HANDOFF_KEY, JSON.stringify(item));
  } catch {
    /* the form still opens, just without the bag details */
  }
  window.location.href = MARKET_BAG_HREF;
}
