import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signMarketGuestSession, signSession, verifySession } from "../src/jwt.js";
import { payMethods, parseCashtag, parsePaypalMe, parseZelle, parseListing } from "../src/market-input.js";
import { stripJpeg, stripPng } from "../src/market-photos.js";
import { finalizeWithdrawals } from "../src/market-sweep.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

const member = (memberId: string, name: string, isAdmin = false) =>
  JSON.stringify({ memberId, name, isAdmin, pinHash: "secret-pin", mustChangePin: false });

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function r2() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  return {
    objects,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const hit = objects.get(key);
      if (!hit) return null;
      return { body: new Blob([hit.bytes as BlobPart]).stream(), arrayBuffer: async () => hit.bytes.buffer, httpMetadata: { contentType: hit.type } };
    },
    async delete(key: string) { objects.delete(key); },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return {
    raw: db,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() {
          if (/\bRETURNING\b/i.test(sql) || /^\s*(?:SELECT|WITH)\b/i.test(sql)) {
            const rows = db.prepare(sql).all(...(bound as never[]));
            return { results: rows, success: true, meta: { changes: rows.length } };
          }
          const info = db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return stmt;
    },
    async batch(list: Array<{ run(): Promise<unknown> }>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

type Db = Awaited<ReturnType<typeof sqliteDb>>;
let db: Db;
let env: Env;
let photos: ReturnType<typeof r2>;
let mail: Array<{ to: string; subject: string; text: string }>;

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    ROSTER: kv({
      "member:m_ada": member("m_ada", "Ada Lovelace"),
      "member:m_bo": member("m_bo", "Bo Burnham"),
      "member:m_cy": member("m_cy", "Cy Young"),
      "member:m_admin": member("m_admin", "Ann Admin", true),
    }),
    RATELIMIT: kv(),
    DB: db,
    PHOTOS: photos,
    JWT_SECRET: SECRET,
    SESSION_TTL_SEC: "900",
    ALLOWED_ORIGINS: ORIGIN,
    RESEND_API_KEY: "re_test",
    EXPECTED_ORIGIN: "https://gvdgclub.com",
    ...extra,
  } as unknown as Env;
}

const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

async function call(path: string, method = "GET", bearer?: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9", ...headers };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const response = await worker.fetch(new Request("https://worker.example" + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx as unknown as ExecutionContext);
  const type = response.headers.get("Content-Type") || "";
  const data: any = type.includes("json") ? await response.json().catch(() => null) : await response.arrayBuffer();
  await Promise.all(pending);
  return { status: response.status, data, headers: response.headers };
}

// A minimal JPEG: SOI, APP0 (JFIF), APP1 (EXIF with a fake GPS marker), SOS + data, EOI.
function jpegWithExif(): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const exifPayload = [...new TextEncoder().encode("Exif\0\0GPS-35.6N-77.3W")];
  const app1 = [0xff, 0xe1, 0x00, exifPayload.length + 2, ...exifPayload];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...sos, 0xff, 0xd9]);
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function hasBytes(hay: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function dataUrl(bytes: Uint8Array, type = "image/jpeg") {
  return `data:${type};base64,` + b64(bytes);
}

const PHOTO = dataUrl(jpegWithExif());

function listingBody(overrides: Record<string, unknown> = {}) {
  return {
    brand: "Innova", mold: "Destroyer", plastic: "Star", discType: "driver", speed: 12, glide: 5, turn: -1, fade: 3,
    weightG: 175, color: "Orange", condition: 8, conditionNotes: "Light ink on the rim", priceCents: 1800,
    openToTrade: true, tradeFor: "A Firebird", quantity: 1, location: "At Sunday Baggers", photos: [PHOTO], ...overrides,
  };
}

async function createListing(owner = "m_ada", overrides: Record<string, unknown> = {}) {
  const res = await call("/market/listings", "POST", await token(owner), listingBody(overrides));
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.listing;
}

async function setSettings(owner = "m_ada", settings: Record<string, unknown> = { paypalMe: "AdaDiscs", cashtag: "$AdaDiscs", zelle: "(252) 555-0134" }) {
  const res = await call("/market/settings", "PUT", await token(owner), settings);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data.settings;
}

async function guestToken(email = "guest@example.test", name = "Gail Guest") {
  const start = await call("/market/guest/start", "POST", undefined, { name, email }, { "CF-Connecting-IP": "198.51.100." + mail.length });
  expect(start.status, JSON.stringify(start.data)).toBe(200);
  const code = /code is (\d{6})/.exec(mail.at(-1)!.text)![1];
  const verify = await call("/market/guest/verify", "POST", undefined, { email, code });
  expect(verify.status).toBe(200);
  return verify.data as { token: string; guest: { key: string; name: string } };
}

beforeEach(async () => {
  db = await sqliteDb();
  photos = r2();
  mail = [];
  env = makeEnv();
  // Sellers need a buyer-alert email before they can list; the email-requirement test removes one.
  for (const id of ["m_ada", "m_bo", "m_cy", "m_admin"]) {
    db.raw.prepare("INSERT INTO market_seller_settings (member_id, notify_email) VALUES (?, ?)").run(id, id.slice(2) + "@example.test");
  }
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body));
      mail.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response("{}", { status: 200 });
    }
    return new Response("not mocked", { status: 500 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("marketplace pure helpers", () => {
  it("validates payment handles and never accepts URLs", () => {
    expect(parsePaypalMe("AdaDiscs")).toBe("AdaDiscs");
    expect(parsePaypalMe("https://paypal.me/AdaDiscs")).toBeNull();
    expect(parsePaypalMe("ada.discs")).toBeNull();
    expect(parseCashtag("$Ada_Discs")).toBe("Ada_Discs");
    expect(parseCashtag("12345")).toBeNull();
    expect(parseCashtag("cash.app/$ada")).toBeNull();
    expect(parseZelle("(252) 555-0134")).toBe("2525550134");
    expect(parseZelle("+1 252-555-0134")).toBe("2525550134");
    expect(parseZelle("Ada@Example.com")).toBe("ada@example.com");
    expect(parseZelle("http://evil.example/x@y.z")).toBeNull();
    expect(parseZelle("555-0134")).toBeNull();
  });

  it("builds checkout links for only the methods the seller set", () => {
    expect(payMethods({ paypalMe: "AdaDiscs", cashtag: "AdaDiscs", zelle: "2525550134" }, 1800)).toEqual([
      { method: "paypal", label: "PayPal", handle: "AdaDiscs", url: "https://paypal.me/AdaDiscs/18.00" },
      { method: "cashapp", label: "Cash App", handle: "$AdaDiscs", url: "https://cash.app/$AdaDiscs/18.00" },
      { method: "zelle", label: "Zelle", handle: "(252) 555-0134", instruction: "Send $18.00 via Zelle to (252) 555-0134" },
    ]);
    expect(payMethods({ paypalMe: "", cashtag: "", zelle: "ada@example.com" }, 1250).map((m) => m.method)).toEqual(["zelle"]);
    // A tampered stored value is dropped rather than turned into a link.
    expect(payMethods({ paypalMe: "evil.example/x", cashtag: "", zelle: "" }, 500)).toEqual([]);
  });

  it("validates listing fields", () => {
    expect(parseListing(listingBody()).ok).toBe(true);
    expect(parseListing(listingBody({ condition: 11 }))).toEqual({ ok: false, field: "condition" });
    expect(parseListing(listingBody({ priceCents: null, openToTrade: false }))).toEqual({ ok: false, field: "priceCents" });
    expect(parseListing(listingBody({ priceCents: null, openToTrade: true })).ok).toBe(true);
    expect(parseListing(listingBody({ turn: -1.25 }))).toEqual({ ok: false, field: "turn" });
    expect(parseListing(listingBody({ weightG: 250 }))).toEqual({ ok: false, field: "weightG" });
    expect(parseListing(listingBody({ discType: "roller" }))).toEqual({ ok: false, field: "discType" });
  });

  it("strips EXIF from JPEG and text chunks from PNG", () => {
    const stripped = stripJpeg(jpegWithExif())!;
    expect(hasBytes(stripped, "Exif")).toBe(false);
    expect(hasBytes(stripped, "JFIF")).toBe(true);
    expect(stripped.at(-1)).toBe(0xd9);
    const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...new TextEncoder().encode(type), ...data, 0, 0, 0, 0];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      ...chunk("tEXt", [...new TextEncoder().encode("GPS secret")]), ...chunk("IDAT", [1, 2, 3]), ...chunk("IEND", [])]);
    const cleaned = stripPng(png)!;
    expect(hasBytes(cleaned, "GPS secret")).toBe(false);
    expect(hasBytes(cleaned, "IDAT")).toBe(true);
  });
});

describe("guest identity", () => {
  it("is unavailable without a Resend key (fail soft)", async () => {
    env = makeEnv({ RESEND_API_KEY: undefined });
    expect((await call("/market/config")).data.guestCheckout).toBe(false);
    const start = await call("/market/guest/start", "POST", undefined, { name: "Gail", email: "g@example.test" });
    expect(start.status).toBe(503);
    expect(start.data.error).toBe("guest_unavailable");
  });

  it("emails a hashed single-use code and issues a guest token that is never a member session", async () => {
    expect((await call("/market/config")).data.guestCheckout).toBe(true);
    const start = await call("/market/guest/start", "POST", undefined, { name: "Gail Guest", email: "Gail@Example.test" });
    expect(start.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe("gail@example.test");
    const code = /code is (\d{6})/.exec(mail[0]!.text)![1]!;
    const stored = db.raw.prepare("SELECT * FROM market_guest_codes").all() as Array<Record<string, string>>;
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(stored)).not.toContain("gail@example.test");

    const verified = await call("/market/guest/verify", "POST", undefined, { email: "gail@example.test", code });
    expect(verified.status).toBe(200);
    expect(verified.data.guest.name).toBe("Gail Guest");
    expect(JSON.stringify(verified.data)).not.toContain("example.test");
    // Single use.
    expect((await call("/market/guest/verify", "POST", undefined, { email: "gail@example.test", code })).status).toBe(400);
    // Not a session anywhere else.
    expect(await verifySession(verified.data.token, SECRET)).toBeNull();
    expect((await call("/me", "GET", verified.data.token)).status).toBe(401);
    expect((await call("/me/messages", "GET", verified.data.token)).status).toBe(401);
    // A stable identity by email: verifying again yields the same trader key.
    const again = await guestToken("gail@example.test", "Gail G.");
    expect(again.guest.key).toBe(verified.data.guest.key);
    expect(again.guest.name).toBe("Gail G.");
    const guests = JSON.stringify(db.raw.prepare("SELECT * FROM market_guests").all());
    expect(guests).not.toContain("gail@example.test");
  });

  it("burns a code after five wrong guesses and rejects expired codes", async () => {
    await call("/market/guest/start", "POST", undefined, { name: "Gail Guest", email: "g@example.test" });
    const code = /code is (\d{6})/.exec(mail[0]!.text)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await call("/market/guest/verify", "POST", undefined, { email: "g@example.test", code: wrong })).status).toBe(400);
    expect((await call("/market/guest/verify", "POST", undefined, { email: "g@example.test", code })).status).toBe(400);

    await call("/market/guest/start", "POST", undefined, { name: "Gail Guest", email: "h@example.test" });
    const second = /code is (\d{6})/.exec(mail.at(-1)!.text)![1]!;
    db.raw.exec("UPDATE market_guest_codes SET expires_at = datetime('now', '-1 minute')");
    expect((await call("/market/guest/verify", "POST", undefined, { email: "h@example.test", code: second })).data.error).toBe("invalid_code");
  });

  it("rate-limits code requests per email and per IP", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await call("/market/guest/start", "POST", undefined, { name: "Gail", email: "rl@example.test" }, { "CF-Connecting-IP": "192.0.2." + i })).status).toBe(200);
    }
    expect((await call("/market/guest/start", "POST", undefined, { name: "Gail", email: "RL@example.test" }, { "CF-Connecting-IP": "192.0.2.50" })).status).toBe(429);
    for (let i = 0; i < 10; i++) {
      await call("/market/guest/start", "POST", undefined, { name: "Gail", email: `ip${i}@example.test` }, { "CF-Connecting-IP": "192.0.2.99" });
    }
    expect((await call("/market/guest/start", "POST", undefined, { name: "Gail", email: "ip-next@example.test" }, { "CF-Connecting-IP": "192.0.2.99" })).status).toBe(429);
  });

  it("rejects names that could leak an address", async () => {
    expect((await call("/market/guest/start", "POST", undefined, { name: "me@example.test", email: "a@example.test" })).data.error).toBe("invalid_name");
    expect((await call("/market/guest/start", "POST", undefined, { name: "Gail", email: "not-an-email" })).data.error).toBe("invalid_email");
  });
});

describe("listings", () => {
  it("only members can list; photos are validated, stripped and stored in R2", async () => {
    expect((await call("/market/listings", "POST", undefined, listingBody())).status).toBe(401);
    const guest = await guestToken();
    const asGuest = await call("/market/listings", "POST", guest.token, listingBody());
    expect(asGuest.status).toBe(403);
    expect(asGuest.data.error).toBe("members_only");

    const listing = await createListing();
    expect(listing.title).toBe("Innova Star Destroyer");
    expect(listing.status).toBe("active");
    expect(listing.photos).toHaveLength(1);
    expect(listing.seller.name).toBe("Ada Lovelace");
    expect(JSON.stringify(listing)).not.toContain("m_ada");
    const [object] = [...photos.objects.entries()];
    expect(object![0]).toMatch(new RegExp(`^market/${listing.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(hasBytes(object![1].bytes, "Exif")).toBe(false);

    const image = await call(listing.photos[0].url);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/jpeg");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("a member must add a buyer-alert email before listing; saving it sends a confirmation", async () => {
    db.raw.prepare("DELETE FROM market_seller_settings WHERE member_id = 'm_cy'").run();
    const cy = await token("m_cy");
    const blocked = await call("/market/listings", "POST", cy, listingBody());
    expect(blocked.status).toBe(400);
    expect(blocked.data).toEqual({ error: "seller_email_required" });
    expect(photos.objects.size).toBe(0);
    // Handles alone don't unlock selling.
    await call("/market/settings", "PUT", cy, { paypalMe: "CyDiscs" });
    expect((await call("/market/listings", "POST", cy, listingBody())).data.error).toBe("seller_email_required");
    expect((await call("/market/settings", "PUT", cy, { notifyEmail: "cy@@example" })).data).toEqual({ error: "invalid_settings", field: "notifyEmail" });
    // Saving just the email keeps the other handles (partial update) and sends one confirmation.
    const saved = await call("/market/settings", "PUT", cy, { notifyEmail: "Cy@Example.test" });
    expect(saved.data.settings).toEqual({ paypalMe: "CyDiscs", cashtag: "", zelle: "", notifyEmail: "cy@example.test" });
    const confirmations = mail.filter((m) => m.to === "cy@example.test");
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.text).toContain("You're set up to sell on the GVDG marketplace — buyer alerts will come here.");
    await call("/market/settings", "PUT", cy, { paypalMe: "CyDiscs2" });
    expect(mail.filter((m) => m.to === "cy@example.test")).toHaveLength(1);
    await call("/market/settings", "PUT", cy, { notifyEmail: "cy.new@example.test" });
    expect(mail.filter((m) => m.to === "cy.new@example.test")).toHaveLength(1);
    expect((await call("/market/listings", "POST", cy, listingBody())).status).toBe(201);
    // Never public: not on listings, profiles or the seller's public card.
    const pub = JSON.stringify([(await call("/market/listings")).data, (await call("/market/wanted")).data]);
    expect(pub).not.toContain("example.test");

    // Existing listings of a member without an email keep working; they just can't add new ones.
    const listing = await createListing("m_ada");
    db.raw.prepare("UPDATE market_seller_settings SET notify_email = '' WHERE member_id = 'm_ada'").run();
    const ada = await token("m_ada");
    expect((await call(`/market/listings/${listing.id}`, "PATCH", ada, { priceCents: 1600 })).status).toBe(200);
    expect((await call(`/market/listings/${listing.id}/buy`, "POST", await token("m_bo"))).status).toBe(201);
    expect((await call("/market/listings", "POST", ada, listingBody())).data.error).toBe("seller_email_required");
  });

  it("enforces the 1-4 photo limits and the file checks", async () => {
    const ada = await token("m_ada");
    expect((await call("/market/listings", "POST", ada, listingBody({ photos: [] }))).data.error).toBe("invalid_photo");
    expect((await call("/market/listings", "POST", ada, listingBody({ photos: Array(5).fill(PHOTO) }))).data.error).toBe("invalid_photo");
    const svg = "data:image/svg+xml;base64," + btoa("<svg onload=alert(1)/>");
    expect((await call("/market/listings", "POST", ada, listingBody({ photos: [svg] }))).data.error).toBe("invalid_photo");
    const lying = dataUrl(jpegWithExif(), "image/png");
    expect((await call("/market/listings", "POST", ada, listingBody({ photos: [lying] }))).data.error).toBe("invalid_photo");
    const huge = new Uint8Array(1_600_000);
    huge.set(jpegWithExif());
    expect((await call("/market/listings", "POST", ada, listingBody({ photos: [dataUrl(huge)] }))).data.error).toBe("invalid_photo");
    const bad = await call("/market/listings", "POST", ada, listingBody({ condition: 0 }));
    expect(bad.status).toBe(400);
    expect(bad.data).toEqual({ error: "invalid_listing", field: "condition" });

    const listing = await createListing();
    for (let i = 0; i < 3; i++) expect((await call(`/market/listings/${listing.id}/photos`, "POST", ada, { image: PHOTO })).status).toBe(200);
    expect((await call(`/market/listings/${listing.id}/photos`, "POST", ada, { image: PHOTO })).data.error).toBe("too_many_photos");
    const detail = (await call(`/market/listings/${listing.id}`, "GET", ada)).data.listing;
    expect(detail.photos).toHaveLength(4);
    for (const photo of detail.photos.slice(1)) {
      expect((await call(`/market/listings/${listing.id}/photos/${photo.id}`, "DELETE", ada)).status).toBe(200);
    }
    expect((await call(`/market/listings/${listing.id}/photos/${detail.photos[0].id}`, "DELETE", ada)).data.error).toBe("photo_required");
    expect(photos.objects.size).toBe(1);
    // Another member can't touch the photos (no IDOR).
    expect((await call(`/market/listings/${listing.id}/photos`, "POST", await token("m_bo"), { image: PHOTO })).status).toBe(404);
  });

  it("withdraw hides the listing but keeps it relistable for 24 hours, then a sweep makes it final", async () => {
    const listing = await createListing();
    const ada = await token("m_ada");
    const offer = await call(`/market/listings/${listing.id}/offers`, "POST", await token("m_bo"), { text: "Swap for my Buzzz?" });
    expect((await call(`/market/listings/${listing.id}/withdraw`, "POST", await token("m_bo"))).status).toBe(404);
    const withdrawn = await call(`/market/listings/${listing.id}/withdraw`, "POST", ada);
    expect(withdrawn.data.listing.status).toBe("withdrawn");
    expect(withdrawn.data.listing.withdrawal).toBe("pending_final");
    expect(withdrawn.data.listing.canRelist).toBe(true);
    expect(withdrawn.data.listing.relistUntil).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    // Hidden from everyone else during the window; photos are kept.
    expect(photos.objects.size).toBe(1);
    expect((await call("/market/listings")).data.listings).toEqual([]);
    expect((await call(`/market/listings/${listing.id}`)).status).toBe(404);
    expect((await call(listing.photos[0].url)).status).toBe(404);
    // The open trade offer was closed and its buyer told.
    expect(db.raw.prepare("SELECT status FROM market_offers WHERE id = ?").get(offer.data.offer.id)).toEqual({ status: "declined" });
    expect(mail.some((m) => m.to === "bo@example.test" && /Trade offer closed/.test(m.subject))).toBe(true);
    const mine = (await call("/market/me", "GET", ada)).data.listings[0];
    expect(mine.withdrawal).toBe("pending_final");
    expect(mine.relistUntil).toBe(withdrawn.data.listing.relistUntil);
    const admin = (await call("/admin/market/overview", "GET", await token("m_admin"))).data;
    expect(admin.withdrawn.map((card: { id: number }) => card.id)).toEqual([listing.id]);

    // Relist: back to active with the same details and photos.
    expect((await call(`/market/listings/${listing.id}/relist`, "POST", await token("m_bo"))).status).toBe(404);
    const relisted = await call(`/market/listings/${listing.id}/relist`, "POST", ada);
    expect(relisted.data.listing.status).toBe("active");
    expect(relisted.data.listing.photos).toEqual(listing.photos);
    expect(relisted.data.listing.priceCents).toBe(1800);
    expect((await call("/market/listings")).data.listings.map((l: { id: number }) => l.id)).toEqual([listing.id]);
    expect((await call(`/market/listings/${listing.id}/relist`, "POST", ada)).data.error).toBe("not_withdrawn");

    // After 24 hours the withdrawal is final: the sweep deletes the photos once and relist is refused.
    await call(`/market/listings/${listing.id}/withdraw`, "POST", ada);
    expect(await finalizeWithdrawals(env)).toEqual({ finalized: 0, photosDeleted: 0 });
    db.raw.prepare("UPDATE market_listings SET withdrawn_at = datetime('now', '-25 hours') WHERE id = ?").run(listing.id);
    expect((await call(`/market/listings/${listing.id}/relist`, "POST", ada)).data.error).toBe("relist_expired");
    expect(await finalizeWithdrawals(env)).toEqual({ finalized: 1, photosDeleted: 1 });
    expect(photos.objects.size).toBe(0);
    expect(await finalizeWithdrawals(env)).toEqual({ finalized: 0, photosDeleted: 0 });
    const final = (await call(`/market/listings/${listing.id}`, "GET", ada)).data.listing;
    expect(final.withdrawal).toBe("final");
    expect(final.canRelist).toBe(false);
    expect((await call("/admin/market/overview", "GET", await token("m_admin"))).data.withdrawn).toEqual([]);
    const log = db.raw.prepare("SELECT action FROM market_deal_log WHERE listing_id = ? ORDER BY id").all(listing.id).map((row) => (row as { action: string }).action);
    expect(log).toEqual(["list", "offer", "withdraw", "relist", "withdraw", "withdraw_final"]);
  });

  it("the withdrawal sweep is bounded per tick and retries a part-done purge", async () => {
    const ada = await token("m_ada");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const listing = await createListing();
      ids.push(listing.id);
      await call(`/market/listings/${listing.id}/withdraw`, "POST", ada);
    }
    db.raw.exec("UPDATE market_listings SET withdrawn_at = datetime('now', '-2 days')");
    expect(await finalizeWithdrawals(env, 2)).toEqual({ finalized: 2, photosDeleted: 2 });
    // A purge that failed part-way: the listing is final but a photo row is left; the next tick finishes it.
    db.raw.prepare("INSERT INTO market_listing_photos (listing_id, r2_key, content_type, bytes) VALUES (?, 'market/x/left.jpg', 'image/jpeg', 1)").run(ids[0]!);
    expect(await finalizeWithdrawals(env, 5)).toEqual({ finalized: 1, photosDeleted: 2 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM market_listing_photos").get()).toEqual({ n: 0 });
  });

  it("edits only the seller's own active listing", async () => {
    const listing = await createListing();
    expect((await call(`/market/listings/${listing.id}`, "PATCH", await token("m_bo"), { priceCents: 100 })).status).toBe(404);
    const edited = await call(`/market/listings/${listing.id}`, "PATCH", await token("m_ada"), { priceCents: 1500, condition: 7 });
    expect(edited.data.listing.priceCents).toBe(1500);
    expect(edited.data.listing.condition).toBe(7);
    expect(edited.data.listing.mold).toBe("Destroyer");
  });

  it("browses with filters and sorts", async () => {
    await createListing("m_ada", { brand: "Innova", mold: "Destroyer", discType: "driver", weightG: 175, condition: 8, priceCents: 1800, openToTrade: true });
    await createListing("m_ada", { brand: "Discraft", mold: "Buzzz", plastic: "ESP", discType: "midrange", weightG: 177, condition: 10, priceCents: 1500, openToTrade: false });
    await createListing("m_bo", { brand: "Axiom", mold: "Envy", plastic: "Neutron", discType: "putter", weightG: 174, condition: 5, priceCents: null, openToTrade: true });
    const titles = async (query: string) => (await call("/market/listings" + query)).data.listings.map((l: { mold: string }) => l.mold);
    expect(await titles("")).toEqual(["Envy", "Buzzz", "Destroyer"]);
    expect(await titles("?type=midrange")).toEqual(["Buzzz"]);
    expect(await titles("?brand=innova")).toEqual(["Destroyer"]);
    expect(await titles("?plastic=sp")).toEqual(["Buzzz"]);
    expect(await titles("?wmin=176")).toEqual(["Buzzz"]);
    expect(await titles("?cond=8&sort=condition")).toEqual(["Buzzz", "Destroyer"]);
    expect(await titles("?pmin=16&pmax=20")).toEqual(["Destroyer"]);
    expect(await titles("?trade=1&sort=price_asc")).toEqual(["Destroyer", "Envy"]);
    expect(await titles("?sort=price_desc")).toEqual(["Destroyer", "Buzzz", "Envy"]);
    expect(await titles("?q=buz")).toEqual(["Buzzz"]);
    expect(await titles("?q=%25")).toEqual([]);
    const browse = await call("/market/listings");
    const boKey = browse.data.listings.find((l: { mold: string }) => l.mold === "Envy").seller.key;
    expect(await titles("?seller=" + boKey)).toEqual(["Envy"]);
    expect(browse.data.facets.brands).toEqual(["Axiom", "Discraft", "Innova"]);
  });
});

describe("payment details visibility", () => {
  it("shows pay links to members and verified guests only", async () => {
    await setSettings("m_ada", { paypalMe: "AdaDiscs", cashtag: "", zelle: "ada@example.com" });
    const listing = await createListing();
    const pub = (await call(`/market/listings/${listing.id}`)).data.listing;
    expect(pub.pay).toBeNull();
    expect(pub.payLocked).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("AdaDiscs");
    const asMember = (await call(`/market/listings/${listing.id}`, "GET", await token("m_bo"))).data.listing;
    expect(asMember.payLocked).toBe(false);
    expect(asMember.pay.methods.map((m: { method: string }) => m.method)).toEqual(["paypal", "zelle"]);
    expect(asMember.pay.methods[0].url).toBe("https://paypal.me/AdaDiscs/18.00");
    const guest = await guestToken();
    const asGuest = (await call(`/market/listings/${listing.id}`, "GET", guest.token)).data.listing;
    expect(asGuest.pay.methods[1].instruction).toBe("Send $18.00 via Zelle to ada@example.com");
    // Settings are member-only and validated.
    expect((await call("/market/settings", "PUT", guest.token, { paypalMe: "x" })).status).toBe(403);
    const bad = await call("/market/settings", "PUT", await token("m_ada"), { paypalMe: "paypal.me/ada" });
    expect(bad.data).toEqual({ error: "invalid_settings", field: "paypalMe" });
  });
});

describe("buy and trade state machine", () => {
  it("buy -> pending for that buyer -> sold, with a state log and notifications", async () => {
    await setSettings();
    db.raw.exec("INSERT INTO market_seller_settings (member_id, notify_email) VALUES ('m_bo', 'bo@example.test') ON CONFLICT(member_id) DO UPDATE SET notify_email = excluded.notify_email");
    const listing = await createListing();
    const bo = await token("m_bo");
    expect((await call(`/market/listings/${listing.id}/buy`, "POST")).status).toBe(401);
    expect((await call(`/market/listings/${listing.id}/buy`, "POST", await token("m_ada"))).data.error).toBe("own_listing");
    const bought = await call(`/market/listings/${listing.id}/buy`, "POST", bo);
    expect(bought.status).toBe(201);
    expect(bought.data.deal.status).toBe("pending");
    expect(bought.data.deal.role).toBe("buyer");
    expect(bought.data.deal.pay.methods[0].url).toBe("https://paypal.me/AdaDiscs/18.00");
    expect(bought.data.listing.status).toBe("pending");
    expect(bought.data.listing.myDeal.id).toBe(bought.data.deal.id);
    // A second buyer is told it's pending; the seller sees the buyer.
    const cy = await token("m_cy");
    expect((await call(`/market/listings/${listing.id}/buy`, "POST", cy)).data.error).toBe("not_available");
    const forOthers = (await call(`/market/listings/${listing.id}`, "GET", cy)).data.listing;
    expect(forOthers.status).toBe("pending");
    expect(forOthers.myDeal).toBeNull();
    expect(forOthers.canBuy).toBe(false);
    const forSeller = (await call(`/market/listings/${listing.id}`, "GET", await token("m_ada"))).data.listing;
    expect(forSeller.pendingDeal.buyer.name).toBe("Bo Burnham");
    // Seller notice recorded.
    const notices = db.raw.prepare("SELECT member_id, kind, href FROM member_notices").all() as Array<Record<string, string>>;
    expect(notices).toContainEqual({ member_id: "m_ada", kind: "market", href: "/gvdg-members.html#marketplace" });
    expect((await call("/me/messages/summary", "GET", await token("m_ada"))).data.market).toBe(1);

    const dealId = bought.data.deal.id;
    expect((await call(`/market/deals/${dealId}/complete`, "POST", cy, { outcome: "sold" })).status).toBe(404);
    expect((await call(`/market/deals/${dealId}/complete`, "POST", bo, { outcome: "sold" })).status).toBe(404);
    const done = await call(`/market/deals/${dealId}/complete`, "POST", await token("m_ada"), { outcome: "sold" });
    expect(done.data.deal.status).toBe("completed");
    expect(done.data.deal.outcome).toBe("sold");
    expect((await call(`/market/listings/${listing.id}`)).data.listing.status).toBe("sold");
    expect((await call(`/market/deals/${dealId}/complete`, "POST", await token("m_ada"))).data.error).toBe("not_pending");
    const log = db.raw.prepare("SELECT action, from_status, to_status FROM market_deal_log ORDER BY id").all();
    expect(log).toEqual([
      { action: "list", from_status: null, to_status: "active" },
      { action: "buy", from_status: "active", to_status: "pending" },
      { action: "complete", from_status: "pending", to_status: "sold" },
    ]);
    // Buyer gets a "leave feedback" email at their notification address.
    expect(mail.some((m) => m.to === "bo@example.test" && /Leave feedback/.test(m.text))).toBe(true);
    const mine = (await call("/market/me", "GET", bo)).data;
    expect(mine.feedbackToLeave.map((d: { id: number }) => d.id)).toEqual([dealId]);
  });

  it("buyer cancel and seller release return the listing to active", async () => {
    const listing = await createListing();
    const bo = await token("m_bo");
    const first = await call(`/market/listings/${listing.id}/buy`, "POST", bo);
    expect((await call(`/market/deals/${first.data.deal.id}/cancel`, "POST", await token("m_cy"))).status).toBe(404);
    expect((await call(`/market/deals/${first.data.deal.id}/cancel`, "POST", bo)).data.deal.status).toBe("cancelled");
    expect((await call(`/market/listings/${listing.id}`)).data.listing.status).toBe("active");
    const second = await call(`/market/listings/${listing.id}/buy`, "POST", await token("m_cy"));
    expect((await call(`/market/deals/${second.data.deal.id}/release`, "POST", await token("m_ada"))).data.deal.status).toBe("released");
    expect((await call(`/market/listings/${listing.id}`)).data.listing.status).toBe("active");
  });

  it("a verified guest can buy, and quantity above one relists after a sale", async () => {
    await setSettings();
    const listing = await createListing("m_ada", { quantity: 2 });
    const guest = await guestToken();
    const bought = await call(`/market/listings/${listing.id}/buy`, "POST", guest.token);
    expect(bought.status).toBe(201);
    expect(bought.data.deal.buyer.kind).toBe("guest");
    const seller = (await call(`/market/listings/${listing.id}`, "GET", await token("m_ada"))).data.listing;
    expect(seller.pendingDeal.buyer).toEqual({ key: guest.guest.key, name: "Gail Guest", kind: "guest" });
    await call(`/market/deals/${bought.data.deal.id}/complete`, "POST", await token("m_ada"));
    const after = (await call(`/market/listings/${listing.id}`)).data.listing;
    expect(after.status).toBe("active");
    expect(after.quantity).toBe(1);
    // The guest got an email about the sale at their verified address; their address never left the server.
    expect(mail.some((m) => m.to === "guest@example.test" && /Sold to you/.test(m.subject))).toBe(true);
  });

  it("trade offers: propose, accept into a pending trade deal, decline and withdraw", async () => {
    const target = await createListing("m_ada", { openToTrade: true });
    const mine = await createListing("m_bo", { brand: "MVP", mold: "Volt", plastic: "Neutron", discType: "fairway" });
    const bo = await token("m_bo");
    const cy = await token("m_cy");
    const noTrade = await createListing("m_ada", { openToTrade: false });
    expect((await call(`/market/listings/${noTrade.id}/offers`, "POST", bo, { text: "Swap?" })).data.error).toBe("trade_not_open");
    expect((await call(`/market/listings/${target.id}/offers`, "POST", bo, { listingIds: [target.id] })).data.error).toBe("invalid_offer");
    expect((await call(`/market/listings/${target.id}/offers`, "POST", cy, { listingIds: [mine.id] })).data.error).toBe("invalid_offer");
    const offer = await call(`/market/listings/${target.id}/offers`, "POST", bo, { listingIds: [mine.id], text: "Plus $5" });
    expect(offer.status).toBe(201);
    expect(offer.data.offer.offered).toEqual([{ id: mine.id, title: "MVP Neutron Volt" }]);
    expect((await call(`/market/listings/${target.id}/offers`, "POST", bo, { text: "again" })).data.error).toBe("offer_exists");
    const guest = await guestToken();
    expect((await call(`/market/listings/${target.id}/offers`, "POST", guest.token, { listingIds: [mine.id] })).data.error).toBe("invalid_offer");
    const guestOffer = await call(`/market/listings/${target.id}/offers`, "POST", guest.token, { text: "A Firebird, 9/10" });
    expect(guestOffer.status).toBe(201);
    const cyOffer = await call(`/market/listings/${target.id}/offers`, "POST", cy, { text: "Two putters" });

    const seller = (await call(`/market/listings/${target.id}`, "GET", await token("m_ada"))).data.listing;
    expect(seller.offers).toHaveLength(3);
    expect((await call(`/market/offers/${offer.data.offer.id}/accept`, "POST", bo)).status).toBe(404);
    expect((await call(`/market/offers/${cyOffer.data.offer.id}/withdraw`, "POST", cy)).data.offer.status).toBe("withdrawn");
    expect((await call(`/market/offers/${guestOffer.data.offer.id}/decline`, "POST", await token("m_ada"))).data.offer.status).toBe("declined");
    const accepted = await call(`/market/offers/${offer.data.offer.id}/accept`, "POST", await token("m_ada"));
    expect(accepted.data.offer.status).toBe("accepted");
    expect(accepted.data.deal.kind).toBe("trade");
    expect(accepted.data.deal.offerText).toBe("Plus $5");
    expect((await call(`/market/listings/${target.id}`)).data.listing.status).toBe("pending");
    const done = await call(`/market/deals/${accepted.data.deal.id}/complete`, "POST", await token("m_ada"), { outcome: "traded" });
    expect(done.data.deal.outcome).toBe("traded");
    expect((await call(`/market/listings/${target.id}`)).data.listing.status).toBe("traded");
  });
});

describe("feedback", () => {
  async function completedDeal() {
    const listing = await createListing();
    const bought = await call(`/market/listings/${listing.id}/buy`, "POST", await token("m_bo"));
    return { listing, dealId: bought.data.deal.id as number };
  }

  it("only parties, only once, only after completion and within 60 days", async () => {
    const { listing, dealId } = await completedDeal();
    const bo = await token("m_bo");
    const ada = await token("m_ada");
    expect((await call("/market/feedback", "POST", bo, { dealId, rating: "positive", comment: "Great" })).data.error).toBe("deal_not_complete");
    await call(`/market/deals/${dealId}/complete`, "POST", ada);
    expect((await call("/market/feedback", "POST", await token("m_cy"), { dealId, rating: "negative", comment: "x" })).data.error).toBe("not_party");
    expect((await call("/market/feedback", "POST", bo, { dealId, rating: "great", comment: "x" })).status).toBe(400);
    expect((await call("/market/feedback", "POST", bo, { dealId, rating: "positive", comment: "x".repeat(301) })).status).toBe(400);
    const left = await call("/market/feedback", "POST", bo, { dealId, rating: "positive", comment: "Smooth handoff at Sunday Baggers" });
    expect(left.status).toBe(201);
    expect(left.data.feedback.role).toBe("seller");
    expect(left.data.feedback.canEdit).toBe(true);
    expect((await call("/market/feedback", "POST", bo, { dealId, rating: "neutral", comment: "" })).data.error).toBe("already_left");
    const back = await call("/market/feedback", "POST", ada, { dealId, rating: "neutral", comment: "Paid late" });
    expect(back.data.feedback.role).toBe("buyer");

    const seller = (await call(`/market/listings/${listing.id}`)).data.listing.seller;
    expect(seller.feedback).toEqual({ positive: 1, neutral: 0, negative: 0, count: 1, percent: 100 });
    const profile = (await call("/market/traders/" + seller.key)).data;
    expect(profile.asSeller).toHaveLength(1);
    expect(profile.asBuyer).toHaveLength(0);
    expect(profile.asSeller[0].comment).toBe("Smooth handoff at Sunday Baggers");

    const late = await completedDeal();
    await call(`/market/deals/${late.dealId}/complete`, "POST", ada);
    db.raw.prepare("UPDATE market_deals SET completed_at = datetime('now', '-61 days') WHERE id = ?").run(late.dealId);
    expect((await call("/market/feedback", "POST", bo, { dealId: late.dealId, rating: "positive", comment: "" })).data.error).toBe("window_closed");
  });

  it("can be edited once within 7 days, and the counterparty can reply once", async () => {
    const { dealId } = await completedDeal();
    const bo = await token("m_bo");
    const ada = await token("m_ada");
    await call(`/market/deals/${dealId}/complete`, "POST", ada);
    const left = (await call("/market/feedback", "POST", bo, { dealId, rating: "neutral", comment: "Ok" })).data.feedback;
    expect((await call(`/market/feedback/${left.id}`, "PATCH", ada, { rating: "negative", comment: "x" })).status).toBe(404);
    const edited = await call(`/market/feedback/${left.id}`, "PATCH", bo, { rating: "positive", comment: "Actually great" });
    expect(edited.data.feedback.rating).toBe("positive");
    expect(edited.data.feedback.canEdit).toBe(false);
    expect((await call(`/market/feedback/${left.id}`, "PATCH", bo, { rating: "neutral", comment: "" })).data.error).toBe("edit_used");

    expect((await call(`/market/feedback/${left.id}/reply`, "POST", bo, { body: "self" })).data.error).toBe("not_subject");
    const reply = await call(`/market/feedback/${left.id}/reply`, "POST", ada, { body: "Thanks Bo!" });
    expect(reply.status).toBe(201);
    expect(reply.data.feedback.reply.body).toBe("Thanks Bo!");
    expect((await call(`/market/feedback/${left.id}/reply`, "POST", ada, { body: "again" })).data.error).toBe("reply_exists");

    const other = await completedDeal();
    await call(`/market/deals/${other.dealId}/complete`, "POST", ada);
    const old = (await call("/market/feedback", "POST", bo, { dealId: other.dealId, rating: "neutral", comment: "" })).data.feedback;
    db.raw.prepare("UPDATE market_feedback SET created_at = datetime('now', '-8 days') WHERE id = ?").run(old.id);
    expect((await call(`/market/feedback/${old.id}`, "PATCH", bo, { rating: "positive", comment: "" })).data.error).toBe("edit_window_closed");
  });

  it("score is percent positive of rated feedback with a total count", async () => {
    const ada = await token("m_ada");
    for (const [buyer, rating] of [["m_bo", "positive"], ["m_cy", "negative"], ["m_admin", "neutral"]] as const) {
      const listing = await createListing();
      const bought = await call(`/market/listings/${listing.id}/buy`, "POST", await token(buyer));
      await call(`/market/deals/${bought.data.deal.id}/complete`, "POST", ada);
      await call("/market/feedback", "POST", await token(buyer), { dealId: bought.data.deal.id, rating, comment: "" });
    }
    await createListing();
    const card = (await call("/market/listings")).data.listings[0];
    expect(card.seller.feedback).toEqual({ positive: 1, neutral: 1, negative: 1, count: 3, percent: 50 });
  });
});

describe("WANTED", () => {
  it("guests and members post; members reply 'I have one' by DM or email relay; posts expire", async () => {
    const guest = await guestToken("wants@example.test", "Wanda");
    expect((await call("/market/wanted", "POST", undefined, { mold: "Firebird" })).status).toBe(401);
    expect((await call("/market/wanted", "POST", guest.token, { notes: "anything" })).data).toEqual({ error: "invalid_wanted", field: "mold" });
    const posted = await call("/market/wanted", "POST", guest.token, { brand: "Innova", mold: "Firebird", weightMin: 170, weightMax: 175, conditionMin: 7, maxPriceCents: 1500, openToTrade: true, notes: "Champion preferred" });
    expect(posted.status).toBe(201);
    expect(posted.data.wanted.title).toBe("Innova Firebird");
    expect(posted.data.wanted.poster.kind).toBe("guest");
    const listing = await createListing("m_ada", { mold: "Firebird", plastic: "Champion", discType: "fairway" });

    expect((await call(`/market/wanted/${posted.data.wanted.id}/replies`, "POST", guest.token, { body: "me" })).status).toBe(403);
    const mailsBefore = mail.length;
    const reply = await call(`/market/wanted/${posted.data.wanted.id}/replies`, "POST", await token("m_ada"), { listingId: listing.id, body: "I have one, 9/10" });
    expect(reply.status).toBe(201);
    expect(reply.data.reply.listing).toEqual({ id: listing.id, title: "Innova Champion Firebird" });
    const relay = mail.slice(mailsBefore);
    expect(relay).toHaveLength(1);
    expect(relay[0]!.to).toBe("wants@example.test");
    expect(relay[0]!.text).toContain("I have one, 9/10");
    expect(relay[0]!.text).toContain("Ada Lovelace");
    // The poster sees replies; others don't.
    expect((await call(`/market/wanted/${posted.data.wanted.id}`, "GET", guest.token)).data.wanted.replies).toHaveLength(1);
    expect((await call(`/market/wanted/${posted.data.wanted.id}`, "GET", await token("m_bo"))).data.wanted.replies).toBeUndefined();
    expect(JSON.stringify((await call("/market/wanted")).data)).not.toContain("wants@example.test");

    // A member poster receives a direct message.
    const memberPost = await call("/market/wanted", "POST", await token("m_bo"), { mold: "Buzzz", discType: "midrange" });
    await call(`/market/wanted/${memberPost.data.wanted.id}/replies`, "POST", await token("m_ada"), { body: "Got a 177g Buzzz" });
    const threads = (await call("/me/messages", "GET", await token("m_bo"))).data.threads;
    expect(threads[0].with.name).toBe("Ada Lovelace");
    expect(threads[0].preview).toContain("Got a 177g Buzzz");

    // Close and expiry.
    expect((await call(`/market/wanted/${memberPost.data.wanted.id}/close`, "POST", await token("m_cy"))).status).toBe(404);
    expect((await call(`/market/wanted/${memberPost.data.wanted.id}/close`, "POST", await token("m_bo"))).data.wanted.status).toBe("closed");
    db.raw.prepare("UPDATE market_wanted SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(posted.data.wanted.id);
    expect((await call("/market/wanted")).data.wanted).toEqual([]);
    expect((await call(`/market/wanted/${posted.data.wanted.id}/replies`, "POST", await token("m_cy"), { body: "late" })).data.error).toBe("not_open");
    const created = db.raw.prepare("SELECT julianday(expires_at) - julianday(created_at) AS days FROM market_wanted WHERE id = ?").get(memberPost.data.wanted.id) as { days: number };
    expect(Math.round(created.days)).toBe(60);
  });
});

describe("reports and moderation", () => {
  it("reports land in the admin queue; hide, remove feedback and suspend are logged with reasons", async () => {
    const listing = await createListing();
    const bo = await token("m_bo");
    const admin = await token("m_admin");
    expect((await call("/market/reports", "POST", undefined, { kind: "listing", id: listing.id, reason: "scam" })).status).toBe(401);
    expect((await call("/market/reports", "POST", await token("m_ada"), { kind: "listing", id: listing.id, reason: "scam" })).data.error).toBe("own_item");
    expect((await call("/market/reports", "POST", bo, { kind: "listing", id: listing.id, reason: "nonsense" })).status).toBe(400);
    expect((await call("/market/reports", "POST", bo, { kind: "listing", id: listing.id, reason: "wrong_info", details: "It's a Star, not Champion" })).status).toBe(201);
    expect((await call("/market/reports", "POST", bo, { kind: "listing", id: listing.id, reason: "scam" })).data.error).toBe("already_reported");
    const guest = await guestToken();
    expect((await call("/market/reports", "POST", guest.token, { kind: "listing", id: listing.id, reason: "spam" })).status).toBe(201);

    expect((await call("/admin/market/summary", "GET", bo)).status).toBe(403);
    expect((await call("/admin/market/summary", "GET", admin)).data.openReports).toBe(2);
    const overview = (await call("/admin/market/overview", "GET", admin)).data;
    expect(overview.reports).toHaveLength(2);
    expect(overview.reports[0].target.title).toBe("Innova Star Destroyer");
    expect(overview.reports[0].target.owner.name).toBe("Ada Lovelace");
    expect(overview.reports[0].target.text).toBe("$18.00 or trade · Condition 8/10 · Light ink on the rim · Pickup: At Sunday Baggers");

    expect((await call(`/admin/market/listings/${listing.id}/hide`, "POST", admin, {})).data.error).toBe("reason_required");
    expect((await call(`/admin/market/listings/${listing.id}/hide`, "POST", admin, { reason: "Misleading plastic" })).status).toBe(200);
    expect((await call("/market/listings")).data.listings).toEqual([]);
    expect((await call(`/market/listings/${listing.id}`)).status).toBe(404);
    expect((await call(listing.photos[0].url)).status).toBe(404);
    expect((await call("/admin/market/summary", "GET", admin)).data.openReports).toBe(0);
    expect((await call(`/admin/market/listings/${listing.id}/unhide`, "POST", admin, { reason: "Seller fixed it" })).status).toBe(200);
    expect((await call("/market/listings")).data.listings).toHaveLength(1);

    // Suspension blocks buying and hides the trader's listings.
    const sellerKey = overview.reports[0].target.owner.key;
    expect((await call("/admin/market/suspensions", "POST", admin, { key: sellerKey, reason: "Repeated no-shows" })).status).toBe(201);
    expect((await call("/market/listings")).data.listings).toEqual([]);
    expect((await call("/market/listings", "POST", await token("m_ada"), listingBody())).data.error).toBe("suspended");
    const susp = (await call("/admin/market/overview", "GET", admin)).data.suspensions;
    expect(susp[0].trader.name).toBe("Ada Lovelace");
    expect((await call(`/admin/market/suspensions/${susp[0].id}/lift`, "POST", admin, { reason: "Talked it through" })).status).toBe(200);
    expect((await call("/market/listings")).data.listings).toHaveLength(1);

    const log = (await call("/admin/market/overview", "GET", admin)).data.log.map((row: { action: string; reason: string }) => [row.action, row.reason]);
    expect(log).toEqual([
      ["lift", "Talked it through"], ["suspend", "Repeated no-shows"], ["unhide", "Seller fixed it"], ["hide", "Misleading plastic"],
    ]);
  });

  it("admins remove abusive feedback; a suspended buyer cannot buy", async () => {
    const listing = await createListing();
    const bought = await call(`/market/listings/${listing.id}/buy`, "POST", await token("m_bo"));
    await call(`/market/deals/${bought.data.deal.id}/complete`, "POST", await token("m_ada"));
    const fb = (await call("/market/feedback", "POST", await token("m_bo"), { dealId: bought.data.deal.id, rating: "negative", comment: "abusive words" })).data.feedback;
    await call("/market/reports", "POST", await token("m_ada"), { kind: "feedback", id: fb.id, reason: "abusive" });
    const admin = await token("m_admin");
    expect((await call(`/admin/market/feedback/${fb.id}/remove`, "POST", admin, { reason: "Abusive language" })).status).toBe(200);
    expect((await call(`/market/listings/${listing.id}`)).data.listing.seller.feedback.count).toBe(0);

    const another = await createListing();
    const boKey = bought.data.deal.buyer.key;
    await call("/admin/market/suspensions", "POST", admin, { key: boKey, reason: "Abusive feedback" });
    expect((await call(`/market/listings/${another.id}/buy`, "POST", await token("m_bo"))).data.error).toBe("suspended");
    expect((await call("/admin/market/suspensions", "POST", admin, { key: boKey, reason: "again" })).data.error).toBe("already_suspended");
  });

  it("rate-limits listing and WANTED creation", async () => {
    const ada = await token("m_ada");
    for (let i = 0; i < 10; i++) expect((await call("/market/listings", "POST", ada, listingBody())).status).toBe(201);
    expect((await call("/market/listings", "POST", ada, listingBody())).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await call("/market/wanted", "POST", ada, { mold: "Envy" })).status).toBe(201);
    expect((await call("/market/wanted", "POST", ada, { mold: "Envy" })).status).toBe(429);
  });
});

describe("donating part of a sale to the club", () => {
  async function soldDeal(overrides: Record<string, unknown> = {}) {
    await setSettings();
    const listing = await createListing("m_ada", overrides);
    const bought = await call(`/market/listings/${listing.id}/buy`, "POST", await token("m_bo"));
    expect(bought.status, JSON.stringify(bought.data)).toBe(201);
    const done = await call(`/market/deals/${bought.data.deal.id}/complete`, "POST", await token("m_ada"), { outcome: "sold" });
    expect(done.data.deal.status).toBe("completed");
    return { listing, dealId: bought.data.deal.id as number };
  }
  const myDonation = async (dealId: number) => (await call("/market/me", "GET", await token("m_ada"))).data.recentDeals.find((deal: any) => deal.id === dealId)?.donation;

  it("shows the pledge to buyers and rejects pledges that don't make sense", async () => {
    await setSettings();
    const ada = await token("m_ada");
    expect((await call("/market/listings", "POST", ada, listingBody({ donatePercent: 0 }))).data).toMatchObject({ field: "donatePercent" });
    expect((await call("/market/listings", "POST", ada, listingBody({ donatePercent: 101 }))).data).toMatchObject({ field: "donatePercent" });
    expect((await call("/market/listings", "POST", ada, listingBody({ donatePercent: 10, donateCents: 500 }))).data).toMatchObject({ field: "donateCents" });
    expect((await call("/market/listings", "POST", ada, listingBody({ donateCents: 1900 }))).data).toMatchObject({ field: "donateCents" });
    const pledged = await createListing("m_ada", { donatePercent: 25 });
    expect(pledged.clubShare).toEqual({ percent: 25 });
    const browse = (await call("/market/listings")).data.listings.find((card: any) => card.id === pledged.id);
    expect(browse.clubShare).toEqual({ percent: 25 });
    const set = await createListing("m_ada", { donateCents: 500 });
    expect(set.clubShare).toEqual({ cents: 500 });
    // A trade-only listing has no sale to share.
    const trade = await createListing("m_ada", { priceCents: null, openToTrade: true, donatePercent: 50 });
    expect(trade.clubShare).toBeNull();
    // Editing can change or drop the pledge.
    expect((await call("/market/listings/" + set.id, "PATCH", ada, { donateCents: null, donatePercent: 10 })).data.listing.clubShare).toEqual({ percent: 10 });
    expect((await call("/market/listings/" + set.id, "PATCH", ada, { donatePercent: null })).data.listing.clubShare).toBeNull();
  });

  it("the seller sends it; only an admin's 'received' gives karma (+10 a whole dollar)", async () => {
    const { dealId } = await soldDeal({ priceCents: 1800, donatePercent: 25 });
    expect(await myDonation(dealId)).toEqual({
      dealId, status: "none", amountCents: null, suggestedCents: 450, pledged: true, karma: 0, maxCents: 1800,
      payUrl: "https://paypal.me/greenvillediscgolf/4.50", reviewNote: "",
    });
    // The buyer's view of the deal carries no donation; the buyer can't send one.
    expect((await call("/market/me", "GET", await token("m_bo"))).data.recentDeals.find((deal: any) => deal.id === dealId).donation).toBeNull();
    const send = (bearer: string, amountCents: unknown) => call(`/market/deals/${dealId}/donation`, "POST", bearer, { amountCents });
    const ada = await token("m_ada");
    expect((await send(await token("m_bo"), 450)).status).toBe(404);
    expect((await send(ada, 50)).data.error).toBe("invalid_amount");
    expect((await send(ada, 1801)).data.error).toBe("invalid_amount");
    expect((await send(ada, "4.50")).data.error).toBe("invalid_amount");
    const sent = await send(ada, 550);
    expect(sent.status, JSON.stringify(sent.data)).toBe(200);
    expect(sent.data.donation).toMatchObject({ status: "sent", amountCents: 550, payUrl: "https://paypal.me/greenvillediscgolf/5.50" });

    const admin = await token("m_admin");
    expect((await call("/admin/market/summary", "GET", admin)).data.openReports).toBe(1);
    const [waiting] = (await call("/admin/market/overview", "GET", admin)).data.donations;
    expect(waiting).toMatchObject({ dealId, amountCents: 550, karma: 50, listingTitle: "Innova Star Destroyer", seller: { name: "Ada Lovelace" } });
    const review = (body: Record<string, unknown>) => call(`/admin/market/donations/${waiting.id}/review`, "POST", admin, body);
    expect((await call(`/admin/market/donations/${waiting.id}/review`, "POST", await token("m_bo"), { decision: "received" })).status).toBe(403);
    expect((await review({ decision: "not_received" })).data.error).toBe("reason_required");
    expect((await review({ decision: "not_received", reason: "Nothing in PayPal yet" })).status).toBe(200);
    expect(await myDonation(dealId)).toMatchObject({ status: "not_received", karma: 0, reviewNote: "Nothing in PayPal yet" });
    expect(db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_ada' ORDER BY id DESC LIMIT 1").get()).toEqual({ title: "Your club donation didn't arrive" });

    // Sent again; this time it arrived.
    expect((await send(ada, 550)).data.donation.status).toBe("sent");
    expect((await review({ decision: "received" })).status).toBe(200);
    expect(await myDonation(dealId)).toMatchObject({ status: "confirmed", karma: 50, payUrl: null });
    expect((await review({ decision: "received" })).data.error).toBe("not_open");
    expect((await send(ada, 1800)).data.error).toBe("already_confirmed");
    expect(db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_ada' ORDER BY id DESC LIMIT 1").get()).toEqual({ title: "Thank you: +50 karma" });
    expect((await call("/admin/market/summary", "GET", admin)).data.openReports).toBe(0);
    // The karma joins the seller's Lost & Found karma; how much they gave isn't published.
    const mine = (await call("/lost-found/me", "GET", ada)).data;
    expect(mine.karma).toEqual({ karma: 50, returned: 0 });
    const log = (await call("/admin/market/overview", "GET", admin)).data.log.map((row: any) => row.action);
    expect(log).toEqual(expect.arrayContaining(["donation_not_received", "donation_confirmed"]));
  });

  it("works for an unpledged sale too, but never for a trade", async () => {
    const { dealId } = await soldDeal({ priceCents: 1200 });
    expect(await myDonation(dealId)).toMatchObject({ status: "none", suggestedCents: null, pledged: false, payUrl: null });
    expect((await call(`/market/deals/${dealId}/donation`, "POST", await token("m_ada"), { amountCents: 200 })).data.donation)
      .toMatchObject({ status: "sent", amountCents: 200, payUrl: "https://paypal.me/greenvillediscgolf/2.00" });
    db.raw.exec("UPDATE market_deals SET outcome = 'traded' WHERE id = " + dealId);
    expect((await call(`/market/deals/${dealId}/donation`, "POST", await token("m_ada"), { amountCents: 200 })).data.error).toBe("not_a_sale");
  });
});

describe("authz edges", () => {
  it("guest tokens are never accepted as members, and forged guest ids are rejected", async () => {
    const forged = await signMarketGuestSession("m_ada", SECRET, 600);
    expect((await call("/market/me", "GET", forged)).status).toBe(401);
    const ghost = await signMarketGuestSession("mg_999", SECRET, 600);
    expect((await call("/market/me", "GET", ghost)).status).toBe(401);
    const otherKey = await signMarketGuestSession("mg_1", "y".repeat(40), 600);
    expect((await call("/market/me", "GET", otherKey)).status).toBe(401);
    expect((await call("/admin/market/overview", "GET", (await guestToken()).token)).status).toBe(401);
  });

  it("my marketplace only shows the caller's own data", async () => {
    await createListing("m_ada");
    await createListing("m_bo", { mold: "Envy" });
    const mine = (await call("/market/me", "GET", await token("m_bo"))).data;
    expect(mine.listings.map((l: { mold: string }) => l.mold)).toEqual(["Envy"]);
    expect(mine.settings).toEqual({ paypalMe: "", cashtag: "", zelle: "", notifyEmail: "bo@example.test" });
    const guest = (await call("/market/me", "GET", (await guestToken()).token)).data;
    expect(guest.settings).toBeNull();
    expect(guest.listings).toEqual([]);
  });
});
