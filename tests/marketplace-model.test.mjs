import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPayUrl, cleanHandleInput, conditionText, CONDITION_LEGEND, dollarsToCents, exactMoney, feedbackLabel, flightText,
  listingPayload, listingsQuery, money, parseShopRoute, safePayUrl, traderHref, validCashtag, validateSettings, validPaypalMe,
  validZelle, wantedPayload, zelleDisplay, relistHoursLeft, withdrawnLabel, SELLER_EMAIL_LABEL, SAFETY_NOTE, GUEST_UNAVAILABLE, MEMBERS_ONLY_LISTING, PENDING_NOTE,
} from "../src/shared/market-model.js";
import { ADMIN_DESTINATIONS, MEMBER_DESTINATIONS } from "../src/shared/app-navigation.js";

test("pay links are built only from valid handles, on the method's own host", () => {
  assert.equal(buildPayUrl("paypal", "GreenvilleDG", 1800), "https://paypal.me/GreenvilleDG/18.00");
  assert.equal(buildPayUrl("cashapp", "$disc_guy", 1250), "https://cash.app/$disc_guy/12.50");
  assert.equal(buildPayUrl("cashapp", "disc_guy", 500), "https://cash.app/$disc_guy/5.00");
  assert.equal(buildPayUrl("paypal", "evil.com/x", 1800), "");
  assert.equal(buildPayUrl("zelle", "a@b.co", 1800), "");

  assert.equal(safePayUrl("paypal", "https://paypal.me/GreenvilleDG/18.00"), "https://paypal.me/GreenvilleDG/18.00");
  assert.equal(safePayUrl("cashapp", "https://cash.app/$disc_guy/12.50"), "https://cash.app/$disc_guy/12.50");
  assert.equal(safePayUrl("paypal", "https://cash.app/$x/1.00"), "", "a Cash App URL is not a PayPal link");
  assert.equal(safePayUrl("paypal", "http://paypal.me/x/1.00"), "", "https only");
  assert.equal(safePayUrl("paypal", "javascript:alert(1)"), "");
  assert.equal(safePayUrl("paypal", "https://paypal.me.evil.com/x"), "");
  assert.equal(safePayUrl("paypal", "https://user:pw@paypal.me/x"), "");
  assert.equal(safePayUrl("zelle", "https://paypal.me/x"), "");
});

test("payment handles are validated and pasted links are cleaned to a bare handle", () => {
  assert.equal(validPaypalMe("GVDG2026"), true);
  assert.equal(validPaypalMe("has space"), false);
  assert.equal(validPaypalMe("a".repeat(21)), false);
  assert.equal(validCashtag("disc_guy"), true);
  assert.equal(validCashtag("12345"), false, "a cashtag needs a letter");
  assert.equal(validCashtag("bad-dash"), false);
  assert.equal(validZelle("player@example.com"), true);
  assert.equal(validZelle("(252) 555-0134"), true);
  assert.equal(validZelle("+1 252 555 0134"), true);
  assert.equal(validZelle("555-0134"), false);
  assert.equal(zelleDisplay("2525550134"), "(252) 555-0134");
  assert.equal(zelleDisplay("ada@example.com"), "ada@example.com");
  assert.equal(validZelle(zelleDisplay("2525550134")), true, "a formatted stored phone saves back unchanged");
  assert.equal(validZelle("https://zelle.com"), false);
  assert.equal(cleanHandleInput("paypal", "https://www.paypal.me/GreenvilleDG/20"), "GreenvilleDG");
  assert.equal(cleanHandleInput("paypal", "@GreenvilleDG"), "GreenvilleDG");
  assert.equal(cleanHandleInput("cashapp", "https://cash.app/$disc_guy"), "disc_guy");
  assert.equal(cleanHandleInput("cashapp", "$disc_guy"), "disc_guy");

  assert.deepEqual(validateSettings({ paypalMe: "paypal.me/GVDG", cashtag: "$disc_guy", zelle: "", notifyEmail: "" }),
    { ok: true, value: { paypalMe: "GVDG", cashtag: "disc_guy", zelle: "", notifyEmail: "" } });
  assert.equal(validateSettings({ zelle: "not a handle" }).field, "zelle");
  assert.equal(validateSettings({ notifyEmail: "nope" }).field, "notifyEmail");
  assert.equal(validateSettings({ cashtag: "$$" }).field, "cashtag");
});

test("feedback reads like eBay: percent positive and the count", () => {
  assert.equal(feedbackLabel({ positive: 50, neutral: 0, negative: 1, count: 51, percent: 98 }), "98% positive (51)");
  assert.equal(feedbackLabel({ count: 0, percent: null }), "No feedback yet");
  assert.equal(feedbackLabel(null), "No feedback yet");
  assert.equal(feedbackLabel({ count: 2, neutral: 2, percent: null }), "Neutral only (2)");
});

test("condition legend runs 10 new to 1 beat", () => {
  assert.equal(CONDITION_LEGEND.length, 10);
  assert.equal(CONDITION_LEGEND[0][0], 10);
  assert.match(CONDITION_LEGEND[0][1], /new/i);
  assert.equal(CONDITION_LEGEND[9][0], 1);
  assert.match(CONDITION_LEGEND[9][1], /beat/i);
  assert.equal(conditionText(8), "8/10 · Light wear");
  assert.equal(conditionText(11), "");
});

test("money and dollars round-trip in whole cents", () => {
  assert.equal(money(1800), "$18");
  assert.equal(money(1250), "$12.50");
  assert.equal(exactMoney(1800), "$18.00");
  assert.equal(dollarsToCents("18"), 1800);
  assert.equal(dollarsToCents("$12.5"), 1250);
  assert.equal(dollarsToCents("12.345"), null);
  assert.equal(dollarsToCents("-3"), null);
  assert.equal(flightText({ speed: 12, glide: 5, turn: -1, fade: 3 }), "12 / 5 / -1 / 3");
  assert.equal(flightText({ speed: null, glide: null, turn: null, fade: null }), "");
});

test("the listing form needs a mold, type, condition and a price or trades", () => {
  const base = { mold: "Destroyer", discType: "driver", condition: "8", price: "18", quantity: "1" };
  const ok = listingPayload({ ...base, brand: "Innova", plastic: "Star", weightG: "175", speed: "12", glide: "5", turn: "-1", fade: "3" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.priceCents, 1800);
  assert.equal(ok.value.weightG, 175);
  assert.equal(ok.value.turn, -1);
  assert.equal(ok.value.tradeFor, "", "trade text only travels when open to trades");
  assert.equal(listingPayload({ ...base, mold: "" }).field, "mold");
  assert.equal(listingPayload({ ...base, discType: "frisbee" }).field, "discType");
  assert.equal(listingPayload({ ...base, condition: "" }).field, "condition");
  assert.equal(listingPayload({ ...base, price: "" }).field, "price");
  assert.equal(listingPayload({ ...base, price: "", openToTrade: true, tradeFor: "A Buzzz" }).ok, true);
  assert.equal(listingPayload({ ...base, price: "0.50" }).field, "price");
  assert.equal(listingPayload({ ...base, weightG: "250" }).field, "weightG");
  assert.equal(listingPayload({ ...base, speed: "16" }).field, "speed");
  assert.equal(listingPayload({ ...base, turn: "-1.25" }).field, "turn");
  assert.equal(listingPayload({ ...base, quantity: "0" }).field, "quantity");

  assert.equal(wantedPayload({}).field, "mold");
  assert.equal(wantedPayload({ mold: "Zone", weightMin: "175", weightMax: "170" }).field, "weightMax");
  assert.deepEqual(wantedPayload({ brand: "Discraft", mold: "Zone", maxPrice: "15", conditionMin: "7" }).value, {
    brand: "Discraft", mold: "Zone", plastic: "", discType: null, weightMin: null, weightMax: null, conditionMin: 7,
    maxPriceCents: 1500, openToTrade: false, notes: "",
  });
});

test("pro shop hash routes", () => {
  assert.deepEqual(pick(parseShopRoute("")), { section: "shop", view: "shop", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#shop-cart")), { section: "shop", view: "shop", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#market")), { section: "market", view: "browse", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#market/listing/12")), { section: "market", view: "listing", id: 12, key: null });
  assert.deepEqual(pick(parseShopRoute("#market/edit/12")), { section: "market", view: "edit", id: 12, key: null });
  assert.deepEqual(pick(parseShopRoute("#market/sell")), { section: "market", view: "sell", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#market/trader/t_ab12-CD")), { section: "market", view: "trader", id: null, key: "t_ab12-CD" });
  assert.deepEqual(pick(parseShopRoute("#market/listing/abc")), { section: "market", view: "browse", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#market/trader/../x")), { section: "market", view: "browse", id: null, key: null });
  assert.equal(parseShopRoute("#market?seller=t_1").query.get("seller"), "t_1");
  assert.deepEqual(pick(parseShopRoute("#wanted")), { section: "wanted", view: "list", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#wanted/new")), { section: "wanted", view: "new", id: null, key: null });
  assert.deepEqual(pick(parseShopRoute("#wanted/7")), { section: "wanted", view: "detail", id: 7, key: null });
  assert.deepEqual(pick(parseShopRoute("#my-market")), { section: "mine", view: "mine", id: null, key: null });
  assert.equal(traderHref("t_1"), "#market/trader/t_1");
  assert.equal(traderHref("<script>"), "#market");
});

test("browse filters become a bounded query string", () => {
  assert.equal(listingsQuery({}), "");
  assert.equal(listingsQuery({ q: " star ", type: "putter", brand: "Innova", wmin: "170", wmax: "999", cond: "7", pmin: "5", pmax: "25", trade: true, sort: "price_asc" }),
    "?q=star&type=putter&brand=Innova&wmin=170&cond=7&pmin=5&pmax=25&trade=1&sort=price_asc");
  assert.equal(listingsQuery({ type: "frisbee", sort: "bogus", seller: "../x" }), "");
  assert.equal(listingsQuery({ seller: "t_9" }, 24), "?seller=t_9&offset=24");
});

test("owner-facing copy is exact", () => {
  assert.equal(SAFETY_NOTE, "Payments go directly to the seller. Meet at club events when you can. Use PayPal Goods & Services for shipped discs.");
  assert.equal(GUEST_UNAVAILABLE, "Guest checkout is unavailable right now. Members can sign in.");
  assert.equal(MEMBERS_ONLY_LISTING, "Only members can list discs. Members can sign in.");
  assert.equal(PENDING_NOTE, "Pending — another buyer is finishing this");
});

test("the marketplace is reachable from the member app and the admin app, and stays lazy", () => {
  assert.ok(MEMBER_DESTINATIONS.some((row) => row.key === "marketplace" && row.group === "more"));
  assert.ok(ADMIN_DESTINATIONS.some((row) => row.key === "marketplace" && row.group === "money"));
  const shop = readFileSync("src/public-app/pro-shop-app.js", "utf8");
  assert.match(shop, /import\("\.\/market-app\.js"\)/);
  assert.doesNotMatch(shop, /from "\.\/market-/, "the club shop never imports marketplace code statically");
  const dashboard = readFileSync("src/members-app/dashboard-app.js", "utf8");
  assert.match(dashboard, /lazyPanel\(\(\) => import\("\.\/marketplace-panel\.js"\), "MemberMarketplacePage"\)/);
  const admin = readFileSync("admin.html", "utf8");
  assert.match(admin, /id="apane-marketplace"/);
  for (const file of ["market-ui.js", "market-listing.js", "market-browse.js", "market-mine.js", "market-wanted.js", "market-sell.js", "market-trader.js", "market-feedback.js", "market-app.js"]) {
    assert.doesNotMatch(readFileSync("src/public-app/" + file, "utf8"), /innerHTML|dangerouslySetInnerHTML/, file);
  }
});

function pick(route) {
  return { section: route.section, view: route.view, id: route.id, key: route.key };
}

test("a withdrawn listing reads as relistable for the hours left in its 24-hour window", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(relistHoursLeft("2026-11-18 11:00:00", now), 23);
  assert.equal(relistHoursLeft("2026-11-17 12:20:00", now), 1, "part of an hour still counts");
  assert.equal(relistHoursLeft("2026-11-17 11:59:59", now), 0);
  assert.equal(relistHoursLeft(null, now), 0);
  assert.equal(withdrawnLabel({ status: "withdrawn", withdrawal: "pending_final", relistUntil: "2026-11-18 11:00:00" }, now), "Withdrawn — relist within 23 h");
  assert.equal(withdrawnLabel({ status: "withdrawn", withdrawal: "final", relistUntil: null }, now), "Withdrawn");
  assert.equal(withdrawnLabel({ status: "active" }, now), null);
  assert.equal(SELLER_EMAIL_LABEL, "Email for buyer alerts (required to sell)");
});

test("bags and accessories list without disc details; the kind filters browse", async () => {
  const model = await import("../src/shared/market-model.js");
  const base = { mold: "AX5", brand: "Grip", condition: "8", price: "60", quantity: "1" };
  // A bag drops whatever disc details the form still holds.
  const bag = model.listingPayload({ ...base, itemKind: "bag", plastic: "Star", discType: "driver", weightG: "175", speed: "12" });
  assert.equal(bag.ok, true);
  assert.deepEqual({ ...bag.value }, {
    itemKind: "bag", gearType: "", brand: "Grip", mold: "AX5", plastic: "", discType: null, speed: null, glide: null, turn: null, fade: null,
    weightG: null, color: "", condition: 8, conditionNotes: "", priceCents: 6000, openToTrade: false, tradeFor: "", quantity: 1, location: "",
  });
  assert.deepEqual(model.listingPayload({ ...base, itemKind: "accessory", mold: "Zuca cart" }), { ok: false, field: "gearType", message: "Choose what it is." });
  assert.equal(model.listingPayload({ ...base, itemKind: "accessory", gearType: "cart", mold: "" }).message, "Enter what it is (the make and model).");
  const cart = model.listingPayload({ ...base, itemKind: "accessory", gearType: "cart", mold: "Zuca cart" });
  assert.equal(cart.value.gearType, "cart");
  // A disc (and anything without a kind) still needs its disc type.
  assert.equal(model.listingPayload({ ...base, mold: "Destroyer" }).field, "discType");
  assert.equal(model.listingPayload({ ...base, itemKind: "hat", mold: "Destroyer", discType: "driver" }).value.itemKind, "disc");

  assert.equal(model.itemKindLabel({ itemKind: "bag" }), "Bag");
  assert.equal(model.itemKindLabel({ itemKind: "accessory", gearType: "rangefinder" }), "Rangefinder");
  assert.equal(model.itemKindLabel({ itemKind: "accessory", gearType: "?" }), "Accessory");
  assert.equal(model.itemKindLabel({ discType: "midrange" }), "Midrange");
  assert.equal(model.listingMeta({ itemKind: "accessory", gearType: "cart", condition: 7, color: "Black" }), "Cart · Black · 7/10");
  assert.equal(conditionText(10, "bag"), "10/10 · New, never used");
  assert.equal(conditionText(7, "accessory"), "7/10 · Some wear, small marks");
  assert.equal(conditionText(10), "10/10 · New, never thrown");
  assert.equal(model.sellHeading("accessory"), "Sell an accessory");
  assert.deepEqual(model.listingDraft({ itemKind: "accessory", gearType: "towel", mold: "Club towel", condition: 9 }).itemKind, "accessory");

  assert.equal(listingsQuery({ kind: "bag" }), "?kind=bag");
  assert.equal(listingsQuery({ kind: "hat" }), "");
  assert.equal(model.activeFilterCount({ kind: "accessory" }), 1);
});

test("Sell this hand-off from My Bag is re-checked when it's read", async () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  try {
    const { MARKET_BAG_HANDOFF_KEY, bagRefKind, clearMarketBagHandoff, readMarketBagHandoff } = await import("../src/public-app/market-bag.js");
    const disc = "disc:12345678-1234-4234-8234-123456789abc";
    assert.equal(bagRefKind(disc), "disc");
    assert.equal(bagRefKind("bag"), "bag");
    assert.equal(bagRefKind("accessory:12"), "accessory");
    for (const bad of ["disc:1", "accessory:0", "accessory:x", "bags", "", null]) assert.equal(bagRefKind(bad), "", String(bad));
    const put = (value) => store.set(MARKET_BAG_HANDOFF_KEY, JSON.stringify(value));
    put({ ref: disc, brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", weightG: "175", photos: [3, 4, "5", -1, 6, 7, 8] });
    assert.deepEqual(readMarketBagHandoff(), {
      ref: disc, itemKind: "disc", gearType: "", brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", weightG: "175", photos: [3, 4, 6, 7],
    });
    put({ ref: "accessory:4", gearType: "jetpack", mold: "x".repeat(80), plastic: "Star", weightG: 175, photos: [] });
    assert.deepEqual(readMarketBagHandoff(), { ref: "accessory:4", itemKind: "accessory", gearType: "other", brand: "", mold: "x".repeat(40), plastic: "", color: "", weightG: "", photos: [] });
    put({ ref: "bag", weightG: 300 });
    assert.equal(readMarketBagHandoff().itemKind, "bag");
    put({ ref: "../admin" });
    assert.equal(readMarketBagHandoff(), null);
    store.set(MARKET_BAG_HANDOFF_KEY, "{not json");
    assert.equal(readMarketBagHandoff(), null);
    clearMarketBagHandoff();
    assert.equal(store.has(MARKET_BAG_HANDOFF_KEY), false);
  } finally {
    delete globalThis.sessionStorage;
  }
});
