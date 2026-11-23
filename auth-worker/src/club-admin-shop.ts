import type { Env } from "./env.js";
import * as shopDb from "./shop-db.js";
import { listMembers, resolveMemberFlexible, type KVListLike } from "./roster.js";
import { json, readJson } from "./http.js";
import { asInt, asStr, inSet } from "./input.js";
import { reverseStoreOrder } from "./order-reversal.js";
import { decodeDataUrl } from "./photos.js";
import { readProductLabel } from "./vision.js";
import { createWalletAdjustmentOnce } from "./wallet-idempotency.js";

const PRODUCT_CATEGORIES = ["disc", "accessory"] as const;
const PRODUCT_ADMIN_STATUSES = ["active", "inactive", "all"] as const;

function asSignedInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v !== 0) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    const parsed = parseInt(v, 10);
    return parsed !== 0 ? parsed : null;
  }
  return null;
}

const MAX_IMAGE_DATA_URL = 700_000; // ~500KB photo as base64 (admin camera/upload images are resized client-side)
function imageUrl(v: unknown): string | null | undefined {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (/^https:\/\//.test(s)) return s.length <= 2000 ? s : undefined; // pasted URL
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s.length <= MAX_IMAGE_DATA_URL ? s : undefined; // photo/upload
  return undefined;
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

function adminProductListOptions(request: Request): shopDb.StoreProductListOptions {
  const params = new URL(request.url).searchParams;
  const status = params.get("status") ?? "active";
  const active = inSet(PRODUCT_ADMIN_STATUSES, status) && status !== "all" ? status === "active" : undefined;
  return {
    sort: params.get("sort") ?? "newest",
    includeInactive: status === "all",
    ...(active !== undefined ? { active } : {}),
  };
}

export async function handleAdminShop(
  request: Request,
  env: Env,
  origin: string | null,
  method: string,
  seg: string[],
  adminId: string,
): Promise<Response | null> {
  if (seg[1] === "shop" && seg[2] === "read-label" && method === "POST" && seg.length === 3) {
    const body = await readJson(request, MAX_IMAGE_DATA_URL + 1_000);
    const image = decodeDataUrl(body && typeof body === "object" ? (body as { image?: unknown }).image : null);
    if (!image) return json({ error: "invalid_image" }, 400, origin);
    const label = await readProductLabel(env, image.bytes, image.contentType);
    return json({ fields: {
      brand: label.brand,
      color: label.color,
      name: label.name,
      price: label.price,
      productType: label.productType,
      weight: label.weight,
    } }, 200, origin);
  }
  // GET /admin/shop/low-stock — Today's "Low on the shelf" card: how many active products have 2 or fewer left and
  // the first one's name. One small query instead of the whole product list (photos included) every minute.
  if (seg[1] === "shop" && seg[2] === "low-stock" && seg.length === 3 && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count, (SELECT name FROM store_products WHERE active = 1 AND stock_qty <= 2 ORDER BY id DESC LIMIT 1) AS name
         FROM store_products WHERE active = 1 AND stock_qty <= 2`,
    ).first<{ count: number; name: string | null }>();
    return json({ count: Number(row?.count) || 0, name: row?.name ?? "" }, 200, origin);
  }
  if (seg[1] === "shop" && seg[2] === "products") {
    const id = seg[3] != null ? asInt(seg[3]) : null;
    if (method === "GET" && seg.length === 3) return json({ products: await shopDb.listStoreProducts(env.DB, adminProductListOptions(request)) }, 200, origin);
    if (method === "POST" && seg.length === 3) {
      const body = await readJson(request, MAX_IMAGE_DATA_URL + 8_000); // room for an inline product photo
      const input = body && cleanProductInput(body, adminId);
      if (!input) return json({ error: "invalid_product" }, 400, origin);
      return json({ product: await shopDb.createStoreProduct(env.DB, input) }, 201, origin);
    }
    if (method === "PATCH" && id != null) {
      const body = await readJson(request, MAX_IMAGE_DATA_URL + 8_000);
      const patch = body && cleanProductPatch(body);
      if (!patch) return json({ error: "invalid_product" }, 400, origin);
      const row = await shopDb.updateStoreProduct(env.DB, id, patch);
      return row ? json({ product: row }, 200, origin) : json({ error: "not_found" }, 404, origin);
    }
    if (method === "DELETE" && id != null) {
      const result = await shopDb.deleteStoreProduct(env.DB, id);
      if (result.kind === "not_found") return json({ error: "not_found" }, 404, origin);
      return json({
        product: result.product,
        deleted: true,
        archived: false,
        reason: null,
      }, 200, origin);
    }
  }

  if (seg[1] === "wallets") {
    if (method === "GET" && seg[2] === "recent") return json({ transactions: await shopDb.listRecentWalletTransactions(env.DB) }, 200, origin);
    // Every member's store-credit balance (owner: "need admin to be able to view all member wallet balances"): the
    // roster (current names; held accounts left out) joined with the ledger, plus anyone the ledger has who's gone.
    if (method === "GET" && seg[2] === "balances") {
      const [roster, ledger] = await Promise.all([listMembers(env.ROSTER as unknown as KVListLike), shopDb.walletLedgerSummaries(env.DB)]);
      const byId = new Map(ledger.map((row) => [row.member_id, row]));
      const members = roster.filter((member) => member.held !== true || byId.has(member.memberId)).map((member) => {
        const row = byId.get(member.memberId);
        byId.delete(member.memberId);
        return { memberId: member.memberId, name: member.name, pdgaNo: member.pdgaNo ?? null, udisc: member.udisc ?? null, balanceCents: row?.balance_cents ?? 0,
          transactions: row?.transactions ?? 0, lastActivityAt: row?.last_at ?? null, onRoster: true };
      });
      for (const row of byId.values()) {
        members.push({ memberId: row.member_id, name: row.member_name || row.member_id, pdgaNo: null, udisc: null, balanceCents: row.balance_cents,
          transactions: row.transactions, lastActivityAt: row.last_at, onRoster: false });
      }
      members.sort((a, b) => b.balanceCents - a.balanceCents || a.name.localeCompare(b.name));
      const withBalance = members.filter((member) => member.balanceCents !== 0);
      return json({
        members,
        totalCents: members.reduce((sum, member) => sum + Math.max(0, member.balanceCents), 0),
        withBalance: withBalance.length,
      }, 200, origin);
    }
    if (method === "GET" && seg[2]) {
      const memberId = decodeURIComponent(seg[2]);
      // The admin drill-down pages through a member's ledger (owner: "a drill down for wallet transactions ... so admin
      // can see each transaction with every member"); without ?page it answers as before (the newest 50).
      const params = new URL(request.url).searchParams;
      if (params.has("page")) {
        const before = params.get("before") ? asInt(params.get("before")) : null;
        if (params.get("before") && (before == null || before <= 0)) return json({ error: "invalid_before" }, 400, origin);
        const [balance, page] = await Promise.all([shopDb.walletBalance(env.DB, memberId), shopDb.listWalletTransactionsPage(env.DB, memberId, { before })]);
        return json({ balance_cents: balance, transactions: page.transactions, more: page.more }, 200, origin);
      }
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
      const idemKey = asStr(body.idempotency_key, 160);
      const txInput = {
        member_id: member.memberId,
        member_name: member.name,
        amount_cents: amount,
        transaction_type: amount > 0 ? "credit" : "debit",
        source: "manual_adjustment",
        note: asStr(body.note, 300),
        created_by: adminId,
      };
      if (idemKey) {
        const res = await createWalletAdjustmentOnce(env.DB, { ...txInput, idempotency_key: "admin_wallet:" + idemKey });
        if (!res.ok) return json({ error: res.error }, 409, origin);
        return json({ transaction: res.transaction, balance_cents: await shopDb.walletBalance(env.DB, member.memberId) }, res.created ? 201 : 200, origin);
      }
      const tx = await shopDb.createWalletTransaction(env.DB, txInput);
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
      const existing = await shopDb.getStoreOrderById(env.DB, id);
      if (!existing) return json({ error: "not_found" }, 404, origin);
      if ((existing as Record<string, unknown>).status === "cancelled" && patch.status !== undefined && patch.status !== "cancelled") {
        return json({ error: "already_cancelled" }, 409, origin);
      }
      // Cancelling an order must make the member whole — restock and refund store credit — not just flip
      // the status. Route the cancel through the reversal primitive (idempotent), then apply any other
      // patch fields (tracking/note) without re-setting status.
      if (patch.status === "cancelled") {
        const rev = await reverseStoreOrder(env, id, { by: adminId });
        if (!(await shopDb.getStoreOrderById(env.DB, id))) return json({ error: "not_found" }, 404, origin);
        delete patch.status;
        if (Object.keys(patch).length) await shopDb.updateStoreOrderFulfillment(env.DB, id, patch);
        return json({ order: await shopDb.getStoreOrderById(env.DB, id), reversal: { refund: rev.refund, restocked: rev.restocked } }, 200, origin);
      }
      const updated = await shopDb.updateStoreOrderFulfillment(env.DB, id, patch);
      if (!updated) {
        const latest = await shopDb.getStoreOrderById(env.DB, id);
        if (latest && (latest as Record<string, unknown>).status === "cancelled" && patch.status !== undefined && patch.status !== "cancelled") {
          return json({ error: "already_cancelled" }, 409, origin);
        }
        return json({ error: "not_found" }, 404, origin);
      }
      return json({ order: updated }, 200, origin);
    }
    if (method === "DELETE" && id != null) {
      // Deleting an order still owes the member their money/stock back — reverse before the row (and its
      // ON DELETE CASCADE items) are gone.
      if (!(await shopDb.getStoreOrderById(env.DB, id))) return json({ error: "not_found" }, 404, origin);
      const rev = await reverseStoreOrder(env, id, { by: adminId });
      const deleted = await shopDb.deleteStoreOrder(env.DB, id);
      return deleted
        ? json({ order: deleted, deleted: true, reversal: { refund: rev.refund, restocked: rev.restocked } }, 200, origin)
        : json({ error: "not_found" }, 404, origin);
    }
  }

  return null;
}
