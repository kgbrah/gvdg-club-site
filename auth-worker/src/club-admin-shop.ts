import type { Env } from "./env.js";
import * as shopDb from "./shop-db.js";
import { resolveMemberFlexible, type KVListLike } from "./roster.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, inSet } from "./input.js";

const PRODUCT_CATEGORIES = ["disc", "accessory"] as const;

function asSignedInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v !== 0) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

function imageUrl(v: unknown): string | null | undefined {
  if (v == null || v === "") return null;
  const s = asStr(v, 2000);
  if (!s || !/^https:\/\//.test(s)) return undefined;
  return s;
}

function nonNegativeInt(v: unknown): number | null {
  const value = asInt(v);
  return value != null && value >= 0 ? value : null;
}

function positiveInt(v: unknown): number | null {
  const value = asInt(v);
  return value != null && value > 0 ? value : null;
}

function cleanProductInput(body: Record<string, unknown>, adminId: string): shopDb.StoreProductInput | null {
  const name = asStr(body.name, 160);
  const price = nonNegativeInt(body.price_cents);
  if (!name || price == null) return null;
  const category = body.category == null ? "disc" : body.category;
  if (!inSet(PRODUCT_CATEGORIES, category)) return null;
  const img = imageUrl(body.image_url);
  if (img === undefined) return null;
  const weight = body.weight_g == null ? null : positiveInt(body.weight_g);
  const stock = body.stock_qty == null ? 0 : nonNegativeInt(body.stock_qty);
  if (body.weight_g != null && weight == null) return null;
  if (stock == null) return null;
  return {
    category,
    name,
    brand: asStr(body.brand, 80),
    product_type: asStr(body.product_type, 60),
    color: asStr(body.color, 60),
    weight_g: weight,
    price_cents: price,
    stock_qty: stock,
    image_url: img,
    description: asStr(body.description, 1000),
    active: body.active === false ? 0 : 1,
    created_by: adminId,
  };
}

function cleanProductPatch(body: Record<string, unknown>): shopDb.StoreProductPatch | null {
  const patch: shopDb.StoreProductPatch = {};
  if ("category" in body) {
    if (!inSet(PRODUCT_CATEGORIES, body.category)) return null;
    patch.category = body.category;
  }
  if ("name" in body) patch.name = asStr(body.name, 160);
  if ("brand" in body) patch.brand = asStr(body.brand, 80);
  if ("product_type" in body) patch.product_type = asStr(body.product_type, 60);
  if ("color" in body) patch.color = asStr(body.color, 60);
  if ("weight_g" in body) {
    if (body.weight_g == null) patch.weight_g = null;
    else {
      const weight = positiveInt(body.weight_g);
      if (weight == null) return null;
      patch.weight_g = weight;
    }
  }
  if ("price_cents" in body) {
    const price = nonNegativeInt(body.price_cents);
    if (price == null) return null;
    patch.price_cents = price;
  }
  if ("stock_qty" in body) {
    const stock = nonNegativeInt(body.stock_qty);
    if (stock == null) return null;
    patch.stock_qty = stock;
  }
  if ("image_url" in body) {
    const img = imageUrl(body.image_url);
    if (img === undefined) return null;
    patch.image_url = img;
  }
  if ("description" in body) patch.description = asStr(body.description, 1000);
  if ("active" in body) patch.active = body.active ? 1 : 0;
  return patch;
}

export async function handleAdminShop(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
): Promise<Response | null> {
  if (seg[1] === "shop" && seg[2] === "products") {
    const id = seg[3] != null ? asInt(seg[3]) : null;
    if (method === "GET" && seg.length === 3) return json({ products: await shopDb.listStoreProducts(env.DB, { includeInactive: true }) }, 200, origin);
    if (method === "POST" && seg.length === 3) {
      const body = await readJson(request);
      const input = body && cleanProductInput(body, adminId);
      if (!input) return json({ error: "invalid_product" }, 400, origin);
      return json({ product: await shopDb.createStoreProduct(env.DB, input) }, 201, origin);
    }
    if (method === "PATCH" && id != null) {
      const body = await readJson(request);
      const patch = body && cleanProductPatch(body);
      if (!patch) return json({ error: "invalid_product" }, 400, origin);
      const row = await shopDb.updateStoreProduct(env.DB, id, patch);
      return row ? json({ product: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
    if (method === "DELETE" && id != null) {
      const row = await shopDb.deactivateStoreProduct(env.DB, id);
      return row ? json({ product: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
  }

  if (seg[1] === "wallets") {
    if (method === "GET" && seg[2] === "recent") return json({ transactions: await shopDb.listRecentWalletTransactions(env.DB) }, 200, origin);
    if (method === "GET" && seg[2]) {
      const memberId = decodeURIComponent(seg[2]);
      const [balance, transactions] = await Promise.all([shopDb.walletBalance(env.DB, memberId), shopDb.listWalletTransactions(env.DB, memberId)]);
      return json({ balance_cents: balance, transactions }, 200, origin);
    }
    if (method === "POST" && seg[2] === "credit") {
      const body = (await readJson(request)) ?? {};
      // Accept any member identifier (name / PDGA# / UDisc / internal id), then store the canonical id.
      const identifier = asStr(body.member_id, 80);
      const amount = asSignedInt(body.amount_cents);
      if (!identifier || amount == null) return json({ error: "invalid_wallet_adjustment" }, 400, origin);
      const resolved = await resolveMemberFlexible(env.ROSTER as unknown as KVListLike, identifier);
      if (!resolved.ok) {
        return resolved.reason === "ambiguous"
          ? json({ error: "member_ambiguous" }, 409, origin)
          : json({ error: "member_not_found" }, 404, origin);
      }
      const member = resolved.member;
      const tx = await shopDb.createWalletTransaction(env.DB, {
        member_id: member.memberId,
        member_name: member.name,
        amount_cents: amount,
        transaction_type: amount > 0 ? "credit" : "debit",
        source: "manual_adjustment",
        note: asStr(body.note, 300),
        created_by: adminId,
      });
      return json({ transaction: tx, balance_cents: await shopDb.walletBalance(env.DB, member.memberId) }, 201, origin);
    }
  }

  if (seg[1] === "orders") {
    const id = seg[2] != null ? asInt(seg[2]) : null;
    if (method === "GET" && seg.length === 2) {
      const status = new URL(request.url).searchParams.get("status");
      const filter = status && inSet(shopDb.ORDER_STATUSES, status) ? status : undefined;
      const [orders, unfulfilled] = await Promise.all([
        shopDb.listAllStoreOrders(env.DB, { status: filter }),
        shopDb.countUnfulfilledStoreOrders(env.DB),
      ]);
      return json({ orders, unfulfilled }, 200, origin);
    }
    if (method === "PATCH" && id != null) {
      const body = (await readJson(request)) ?? {};
      const patch: shopDb.OrderFulfillmentPatch = {};
      if ("status" in body) {
        const s = asStr(body.status, 20);
        if (!s || !inSet(shopDb.ORDER_STATUSES, s)) return json({ error: "invalid_status" }, 400, origin);
        patch.status = s;
      }
      if ("tracking_carrier" in body) patch.tracking_carrier = asStr(body.tracking_carrier, 60);
      if ("tracking_number" in body) patch.tracking_number = asStr(body.tracking_number, 120);
      if ("admin_note" in body) patch.admin_note = asStr(body.admin_note, 500);
      const updated = await shopDb.updateStoreOrderFulfillment(env.DB, id, patch);
      if (!updated) return json({ error: "not_found" }, 404, origin);
      return json({ order: updated }, 200, origin);
    }
  }

  return null;
}
