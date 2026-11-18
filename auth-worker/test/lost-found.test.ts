import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { parsePost } from "../src/lf-input.js";
import { nameMatch, privateKeys, rosterNameMatch, scoreMatch, type FoundSide, type LostSide } from "../src/lf-match.js";
import { runLostFoundTick } from "../src/lf-process.js";
import { blockSize, mosaic, padBox, redactImage } from "../src/lf-redact.js";
import { extractionStatus, inkKeys, normalizeName, parseCompare, parseDiscExtraction, phoneDigits } from "../src/lf-vision.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const FIXTURE = new Uint8Array(readFileSync(new URL("./fixtures/lf-ink-disc.jpg", import.meta.url)));
// The fixture's handwriting ("ADA 555-0134") sits at about x 70-165, y 70-86 of 240x160.
const FIXTURE_BOX = [430, 280, 550, 700];

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
      return { body: new Blob([hit.bytes as BlobPart]).stream(), arrayBuffer: async () => hit.bytes.slice().buffer, httpMetadata: { contentType: hit.type } };
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
          const info = db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return stmt;
    },
  };
}

type Db = Awaited<ReturnType<typeof sqliteDb>>;
let db: Db;
let env: Env;
let photos: ReturnType<typeof r2>;
let mail: Array<{ to: string; subject: string; text: string }>;
/** What the mocked Gemini says next about a disc photo (defaults to "no writing"). */
let geminiReplies: string[];
let geminiCalls: number;
let openRouterReply: string | null;

const NO_INK = JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "Star Destroyer", ink: [], unreadable_writing: false, ink_confidence: "high" });
function inkReply(ink: Array<{ text: string; type: string; box_2d?: number[] }>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "", ink, unreadable_writing: false, ink_confidence: "high", ...extra });
}

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
    GEMINI_API_KEY: "gk_test",
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
  const raw = type.includes("json") ? await response.text() : null;
  const data: any = raw != null ? (raw ? JSON.parse(raw) : null) : new Uint8Array(await response.arrayBuffer());
  // Background work (AI read, redaction, matching, notices) finishes before the test looks.
  while (pending.length) await Promise.all(pending.splice(0));
  return { status: response.status, data, raw: raw ?? "", headers: response.headers };
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const PHOTO = "data:image/jpeg;base64," + b64(FIXTURE);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function hasText(hay: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

async function guestToken(email = "wendy@example.test", name = "Wendy Guest", path = "/lost-found/guest") {
  const start = await call(path + "/start", "POST", undefined, { name, email }, { "CF-Connecting-IP": "198.51.100." + (mail.length + 1) });
  expect(start.status, JSON.stringify(start.data)).toBe(200);
  const code = /code is (\d{6})/.exec(mail.at(-1)!.text)![1];
  const verify = await call(path + "/verify", "POST", undefined, { email, code });
  expect(verify.status).toBe(200);
  return verify.data as { token: string; guest: { key: string; name: string } };
}

function foundBody(overrides: Record<string, unknown> = {}) {
  return { kind: "found", brand: "", mold: "", plastic: "", color: "Orange", courseId: 9001, area: "Hole 7 pond", eventDate: today(), photos: [PHOTO], ...overrides };
}

function lostBody(overrides: Record<string, unknown> = {}) {
  return { kind: "lost", brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", courseId: 9001, area: "Hole 7", eventDate: today(-1),
    rewardNote: "Cold drink on me", privateInk: "Wendy Smith 252-555-0199", ...overrides };
}

function today(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function createPost(bearer: string, body: Record<string, unknown>) {
  const res = await call("/lost-found/posts", "POST", bearer, body);
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.post;
}

async function getPost(id: number, bearer?: string) {
  return (await call("/lost-found/posts/" + id, "GET", bearer)).data.post;
}

beforeEach(async () => {
  db = await sqliteDb();
  photos = r2();
  mail = [];
  geminiReplies = [];
  geminiCalls = 0;
  openRouterReply = null;
  env = makeEnv();
  db.raw.prepare("INSERT INTO courses (id, name, lat, lng) VALUES (9001, 'Elm Street Park', 35.61, -77.37), (9002, 'Green Mill Run', 35.60, -77.36), (9003, 'Far Away DGC', 36.9, -80.1)").run();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body));
      mail.push({ to: body.to[0], subject: body.subject, text: body.text });
      return new Response("{}", { status: 200 });
    }
    if (target.startsWith("https://generativelanguage.googleapis.com/")) {
      geminiCalls += 1;
      const prompt = String(init?.body || "");
      const text = prompt.includes("SAME physical disc") ? '{"same":"yes"}' : geminiReplies.shift() ?? NO_INK;
      return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
    }
    if (target.startsWith("https://openrouter.ai/") && openRouterReply != null) {
      return Response.json({ choices: [{ message: { content: openRouterReply } }] });
    }
    return new Response("not mocked", { status: 500 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------

describe("lost & found pure helpers", () => {
  it("parses a Gemini disc read with normalised boxes and validates every field", () => {
    const read = parseDiscExtraction("```json\n" + inkReply([
      { text: "WENDY SMITH", type: "name", box_2d: [100, 200, 180, 600] },
      { text: "252 555 0199", type: "phone", box_2d: [200, 210, 260, 620] },
      { text: "??", type: "weird", box_2d: [500, 500, 400, 600] },
    ], { colors: ["Orange / Grey", "chartreuse"] }) + "\n```");
    expect(read.parsed).toBe(true);
    expect(read.brand).toBe("Innova");
    expect(read.colors).toEqual(["orange", "gray"]);
    expect(read.ink[0]).toEqual({ text: "WENDY SMITH", type: "name", box: { x0: 0.2, y0: 0.1, x1: 0.6, y1: 0.18 } });
    expect(read.ink[2]).toEqual({ text: "??", type: "other", box: null });
    expect(parseDiscExtraction("no json here").parsed).toBe(false);
    expect(parseDiscExtraction('{"ink": "nope"}').ink).toEqual([]);
  });

  it("only a trusted, fully boxed, confident read unlocks a public photo", () => {
    const boxed = parseDiscExtraction(inkReply([{ text: "WENDY", type: "name", box_2d: [1, 1, 50, 50] }]));
    expect(extractionStatus(boxed, "gemini:gemini-2.5-flash")).toBe("ok");
    expect(extractionStatus(boxed, "openrouter:any")).toBe("unsure");
    expect(extractionStatus(boxed, null)).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(inkReply([{ text: "WENDY", type: "name" }])), "gemini:x")).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(inkReply([], { unreadable_writing: true })), "gemini:x")).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(inkReply([{ text: "W", type: "initials", box_2d: [1, 1, 9, 9] }], { ink_confidence: "low" })), "gemini:x")).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(NO_INK), "gemini:x")).toBe("ok");
    expect(extractionStatus(parseDiscExtraction(""), "gemini:x")).toBe("empty");
  });

  it("normalises phone numbers, names and initials for matching", () => {
    expect(phoneDigits("Call (252) 555-0199 or +1 252.555.0100")).toEqual(["2525550199", "2525550100"]);
    expect(phoneDigits("PDGA 12345")).toEqual([]);
    expect(normalizeName("  Zoë  O'Brien-Smith ")).toBe("zoe obriensmith");
    expect(inkKeys([{ text: "WENDY SMITH", type: "name" }, { text: "W.S.", type: "initials" }, { text: "252-555-0199", type: "phone" }]))
      .toEqual({ names: ["wendy smith"], phones: ["2525550199"], initials: ["ws"] });
    expect(privateKeys("Wendy Smith\n(252) 555-0199")).toMatchObject({ names: ["wendy smith"], phones: ["2525550199"] });
    expect(nameMatch("WENDY SMITH", "Wendy J Smith")).toBe("full");
    expect(nameMatch("SMITH", "Wendy Smith")).toBe("surname");
    expect(nameMatch("Bo", "Wendy Smith")).toBeNull();
    expect(parseCompare('{"same":"yes"}')).toBe("same");
    expect(parseCompare("maybe")).toBeNull();
  });

  const found = (over: Partial<FoundSide> = {}): FoundSide => ({ brand: "Innova", mold: "Destroyer", plastic: "Star", color: "Orange", aiColors: [],
    courseId: 1, lat: 35.61, lng: -77.37, date: "2026-11-10", ink: { names: [], phones: [], initials: [] }, ...over });
  const lost = (over: Partial<LostSide> = {}): LostSide => ({ brand: "Innova", mold: "Destroyer", plastic: "Star", color: "orange",
    courseId: 1, lat: 35.61, lng: -77.37, date: "2026-11-09", privateInk: "", memberName: null, ...over });

  it("scores ink phone and name highest, details partially, and course/date windows", () => {
    const phone = scoreMatch(found({ brand: "", mold: "", plastic: "", color: "", courseId: 3, lat: 36.9, lng: -80.1, date: null, ink: { names: [], phones: ["2525550199"], initials: [] } }),
      lost({ privateInk: "my cell 252 555 0199", date: null }));
    expect(phone.reasons).toContain("ink_phone");
    expect(phone.identity).toBe(true);
    expect(phone.strong).toBe(true);
    const name = scoreMatch(found({ ink: { names: ["wendy smith"], phones: [], initials: [] } }), lost({ privateInk: "Wendy Smith" }));
    expect(name.reasons).toEqual(expect.arrayContaining(["ink_name", "brand", "mold", "plastic", "color", "course", "date"]));
    expect(name.score).toBe(100);
    const member = scoreMatch(found({ ink: { names: ["cy young"], phones: [], initials: [] } }), lost({ memberName: "Cy Young" }));
    expect(member.reasons).toContain("member_name");
    // Details alone: all match = strong; colour / brand only = weak; a different mold drags it down.
    expect(scoreMatch(found(), lost()).score).toBe(55);
    const colourOnly = scoreMatch(found({ brand: "Innova", mold: "", plastic: "" }), lost({ mold: "", plastic: "", courseId: 2, lat: 35.6, lng: -77.36 }));
    expect(colourOnly.reasons).toEqual(["brand", "color", "nearby", "date"]);
    expect(colourOnly.strong).toBe(false);
    expect(scoreMatch(found({ mold: "Destroyr" }), lost()).reasons).toContain("mold_close");
    expect(scoreMatch(found({ mold: "Firebird" }), lost()).reasons).toContain("mold_mismatch");
    expect(scoreMatch(found({ color: "Blue" }), lost()).reasons).toContain("color_mismatch");
    // Date windows: found before it was lost is penalised; weeks later counts less.
    const before = scoreMatch(found({ date: "2026-11-01" }), lost({ date: "2026-11-09" }));
    expect(before.reasons).toContain("date_before");
    expect(scoreMatch(found({ date: "2026-12-20" }), lost()).score).toBeLessThan(scoreMatch(found(), lost()).score);
    expect(scoreMatch(found({ courseId: 3, lat: 36.9, lng: -80.1 }), lost()).reasons).not.toContain("nearby");
  });

  it("matches a roster member only when exactly one full name fits", () => {
    const members = [{ memberId: "m_cy", name: "Cy Young" }, { memberId: "m_ada", name: "Ada Lovelace" }, { memberId: "m_ada2", name: "Ada Byron" }];
    expect(rosterNameMatch(["cy young"], members)).toBe("m_cy");
    expect(rosterNameMatch(["ada"], members)).toBeNull();
    expect(rosterNameMatch(["young"], members)).toBeNull();
    expect(rosterNameMatch(["cy young", "ada lovelace"], members)).toBeNull();
  });

  it("validates posts: found needs nothing but a photo, lost needs something to match on", () => {
    expect(parsePost({ kind: "found" }).ok).toBe(true);
    expect(parsePost({ kind: "found", holding: "club_bin" })).toEqual({ ok: false, field: "binNote" });
    expect(parsePost({ kind: "lost" })).toEqual({ ok: false, field: "mold" });
    expect(parsePost({ kind: "lost", privateInk: "Wendy" }).ok).toBe(true);
    expect(parsePost({ kind: "lost", color: "Red", eventDate: "2099-01-01" })).toEqual({ ok: false, field: "eventDate" });
    expect(parsePost({ kind: "stolen" })).toEqual({ ok: false, field: "kind" });
  });
});

describe("lost & found redaction", () => {
  it("pads boxes generously and mosaics with blocks bigger than a letter", () => {
    const area = padBox({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.5 }, 1000, 800);
    expect(area).toEqual({ x: 350, y: 300, w: 300, h: 120 });
    expect(blockSize(area)).toBe(60);
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) pixels.set(i % 2 ? [0, 0, 0, 255] : [200, 100, 50, 255], i * 4);
    mosaic(pixels, 4, [{ x: 0, y: 0, w: 4, h: 4 }]);
    expect(new Set(Array.from({ length: 16 }, (_, i) => pixels.slice(i * 4, i * 4 + 3).join(","))).size).toBe(1);
  });

  it("blurs the writing out of a real photo and re-encodes without metadata", async () => {
    const { PhotonImage } = await import("@cf-wasm/photon");
    const box = { x0: FIXTURE_BOX[1]! / 1000, y0: FIXTURE_BOX[0]! / 1000, x1: FIXTURE_BOX[3]! / 1000, y1: FIXTURE_BOX[2]! / 1000 };
    const out = await redactImage(FIXTURE, [box]);
    expect(out.contentType).toBe("image/jpeg");
    expect([out.bytes[0], out.bytes[1]]).toEqual([0xff, 0xd8]);
    expect(hasText(out.bytes, "Exif")).toBe(false);
    const before = PhotonImage.new_from_byteslice(FIXTURE);
    const after = PhotonImage.new_from_byteslice(out.bytes);
    expect([after.get_width(), after.get_height()]).toEqual([240, 160]);
    const a = before.get_raw_pixels();
    const b = after.get_raw_pixels();
    const at = (px: Uint8Array, x: number, y: number) => Array.from(px.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 3));
    const dark = (px: Uint8Array, x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (at(px, x, y).every((v) => v < 90)) n += 1;
      return n;
    };
    // The handwriting's dark strokes are gone from the padded area...
    expect(dark(a, 70, 70, 166, 87)).toBeGreaterThan(80);
    expect(dark(b, 60, 60, 180, 96)).toBe(0);
    // ...and the rest of the photo is untouched (JPEG noise aside).
    for (const [x, y] of [[20, 20], [120, 140], [220, 150], [120, 30]] as const) {
      at(a, x, y).forEach((value, i) => expect(Math.abs(value - at(b, x, y)[i]!)).toBeLessThan(18));
    }
    before.free(); after.free();
  });
});

describe("lost & found guest identity is the marketplace's", () => {
  it("one verified email works on both surfaces and is never a member session", async () => {
    const viaMarket = await guestToken("wendy@example.test", "Wendy Guest", "/market/guest");
    expect(mail.at(-1)!.subject).toMatch(/marketplace code/);
    // The marketplace token posts on Lost & Found.
    const post = await createPost(viaMarket.token, lostBody());
    expect(post.poster.name).toBe("Wendy Guest");
    expect(post.poster.kind).toBe("guest");
    // Verifying again from Lost & Found (same email) is the same identity and still works on the marketplace.
    const viaLf = await guestToken("Wendy@Example.test", "Wendy Guest", "/lost-found/guest");
    expect(mail.at(-1)!.subject).toMatch(/verification code/);
    expect(mail.at(-1)!.text).toMatch(/Lost & Found and the marketplace/);
    expect(viaLf.guest.key).toBe(viaMarket.guest.key);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM market_guests").get()).toEqual({ n: 1 });
    const wanted = await call("/market/wanted", "POST", viaLf.token, { brand: "Innova", mold: "Firebird" });
    expect(wanted.status).toBe(201);
    expect((await call("/lost-found/me", "GET", viaLf.token)).data.posts.map((row: any) => row.id)).toEqual([post.id]);
    // verifySession rejects the guest token on member routes.
    expect((await call("/me", "GET", viaLf.token)).status).toBe(401);
    expect((await call("/me/messages/summary", "GET", viaLf.token)).status).toBe(401);
    expect((await call("/admin/lost-found/overview", "GET", viaLf.token)).status).toBe(401);
  });

  it("rate-limits code requests across both surfaces", async () => {
    const ip = { "CF-Connecting-IP": "198.51.100.200" };
    for (const path of ["/market/guest/start", "/lost-found/guest/start", "/market/guest/start"]) {
      expect((await call(path, "POST", undefined, { name: "Rae", email: "rae@example.test" }, ip)).status).toBe(200);
    }
    expect((await call("/lost-found/guest/start", "POST", undefined, { name: "Rae", email: "rae@example.test" }, ip)).status).toBe(429);
  });
});

describe("lost & found photos and privacy", () => {
  it("publishes only a redacted copy, and never serves the original", async () => {
    geminiReplies = [inkReply([{ text: "ADA 555-0134", type: "phone", box_2d: FIXTURE_BOX }])];
    const finder = await token("m_bo");
    const created = await createPost(finder, foundBody());
    expect(geminiCalls).toBe(1);
    const post = await getPost(created.id);
    expect(post.photos).toHaveLength(1);
    expect(post.photoPending).toBe(0);
    // AI filled in empty details and says so.
    expect(post.title).toBe("Innova Star Destroyer");
    expect(post.aiFields).toEqual(["brand", "mold", "plastic"]);
    const row = db.raw.prepare("SELECT original_key, public_key, boxes, redaction FROM lf_photos").get() as any;
    expect(row.redaction).toBe("public");
    expect(row.boxes).toBe(1);
    expect(row.original_key).toMatch(/^lost-found\/private\//);
    const original = photos.objects.get(row.original_key)!.bytes;
    const served = await call(post.photos[0].url);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
    expect(served.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(sameBytes(served.data, original)).toBe(false);
    expect(sameBytes(served.data, photos.objects.get(row.public_key)!.bytes)).toBe(true);
    // No path reaches the original.
    for (const path of [post.photos[0].url + "/original", "/lost-found/photos/" + row.original_key, "/lost-found/originals/1"]) {
      expect((await call(path)).status).toBe(404);
    }
    // The poster can take a photo down (writing the AI missed); nobody else can.
    expect((await call(`/lost-found/posts/${created.id}/photos/${post.photos[0].id}/remove`, "POST", await token("m_cy"))).status).toBe(404);
    const removed = await call(`/lost-found/posts/${created.id}/photos/${post.photos[0].id}/remove`, "POST", finder);
    expect(removed.data.post.photos).toEqual([]);
    expect((await call(post.photos[0].url)).status).toBe(404);
    expect(photos.objects.size).toBe(0);
    // A read that puts the writing into a public field (here "mold") is not used for that field.
    geminiReplies = [inkReply([{ text: "WENDY SMITH", type: "name", box_2d: [1, 1, 50, 50] }], { brand: "Innova", mold: "Wendy Smith", plastic: "Star 2525550199" })];
    const echoed = await getPost((await createPost(finder, foundBody())).id);
    expect(echoed).toMatchObject({ brand: "Innova", mold: "", plastic: "" });
    // Ink text never reaches a public payload.
    const list = await call("/lost-found/posts?kind=found");
    expect(list.raw).not.toMatch(/555|0134|ADA/);
    expect(list.raw).not.toContain("original");
  });

  it("publishes no photo when the AI is unavailable, then a cron retry publishes it", async () => {
    env = makeEnv({ GEMINI_API_KEY: "" });
    const created = await createPost(await token("m_bo"), foundBody());
    const post = await getPost(created.id);
    expect(post.photos).toEqual([]);
    expect(post.photoPending).toBe(1);
    const photo = db.raw.prepare("SELECT id, redaction, attempts, last_error, public_key FROM lf_photos").get() as any;
    expect(photo).toMatchObject({ redaction: "pending", attempts: 1, last_error: "ai_unavailable", public_key: null });
    expect((await call("/lost-found/photos/" + photo.id)).status).toBe(404);
    expect([...photos.objects.keys()].every((key) => key.startsWith("lost-found/private/"))).toBe(true);
    // A public GET never calls the AI.
    const before = geminiCalls;
    await call("/lost-found/posts/" + created.id);
    await call("/lost-found/posts?kind=found");
    await call("/lost-found/returned");
    expect(geminiCalls).toBe(before);
    // The AI comes back; the next due cron tick publishes the redacted copy.
    env = makeEnv();
    db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute')").run();
    const tick = await runLostFoundTick(env);
    expect(tick).toMatchObject({ photos: 1, published: 1 });
    expect((await getPost(created.id)).photos).toHaveLength(1);
  });

  it("keeps the photo private when the AI is unsure or only an untrusted provider read it", async () => {
    geminiReplies = [inkReply([], { unreadable_writing: true })];
    const unsure = await createPost(await token("m_bo"), foundBody());
    expect((await getPost(unsure.id)).photos).toEqual([]);
    // Gemini down, OpenRouter says "no writing": not trusted to unlock a public photo.
    env = makeEnv({ GEMINI_API_KEY: "", OPENROUTER_API_KEY: "or_test" });
    openRouterReply = NO_INK;
    const fallback = await createPost(await token("m_cy"), foundBody());
    const post = await getPost(fallback.id);
    expect(post.photos).toEqual([]);
    expect(post.mold).toBe("Destroyer");
    expect(db.raw.prepare("SELECT source, status FROM lf_extractions ORDER BY id").all()).toEqual([
      { source: "gemini:gemini-2.5-flash", status: "unsure" },
      { source: "openrouter:nvidia/nemotron-nano-12b-v2-vl:free", status: "unsure" },
    ]);
    // Retries back off and give up into the admin queue; the photo never goes public.
    for (let i = 0; i < 8; i++) {
      db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute')").run();
      await runLostFoundTick(env);
    }
    expect(db.raw.prepare("SELECT DISTINCT redaction FROM lf_photos").all()).toEqual([{ redaction: "failed" }]);
    const admin = await call("/admin/lost-found/summary", "GET", await token("m_admin"));
    expect(admin.data.failedPhotos).toBe(2);
  });
});

describe("lost & found matching, claims, returns and karma", () => {
  async function scenario() {
    // A member finds a disc with a name and phone on it; a guest lost it and described the ink privately.
    const wendy = await guestToken();
    const lostPost = await createPost(wendy.token, lostBody());
    geminiReplies = [inkReply([
      { text: "WENDY SMITH", type: "name", box_2d: [300, 250, 420, 700] },
      { text: "252 555 0199", type: "phone", box_2d: [450, 250, 560, 700] },
    ])];
    const finder = await token("m_bo");
    const foundPost = await createPost(finder, foundBody());
    const match = db.raw.prepare("SELECT * FROM lf_matches").get() as any;
    return { wendy, lostPost, foundPost, match, finder };
  }

  it("suggests and announces a strong match, and keeps every private string out of public payloads", async () => {
    const { wendy, lostPost, foundPost, match, finder } = await scenario();
    expect(match).toMatchObject({ found_id: foundPost.id, lost_id: lostPost.id, candidate_id: expect.stringMatching(/^mg_/), status: "notified" });
    expect(JSON.parse(match.reasons)).toEqual(expect.arrayContaining(["ink_phone", "ink_name", "mold", "course"]));
    const toWendy = mail.find((row) => row.to === "wendy@example.test" && row.subject === "Is this your disc?");
    expect(toWendy?.text).toContain("lost-found.html#match/" + match.id);
    const notice = db.raw.prepare("SELECT title, body, href FROM member_notices WHERE member_id = 'm_bo'").all() as any[];
    expect(notice.map((row) => row.title)).toContain("Someone may own the disc you found");
    expect(JSON.stringify(notice)).not.toMatch(/wendy|smith|0199/i);

    const other = await token("m_cy");
    const payloads = [
      await call("/lost-found/posts?kind=found"),
      await call("/lost-found/posts?kind=lost"),
      await call("/lost-found/posts/" + foundPost.id),
      await call("/lost-found/posts/" + lostPost.id),
      await call("/lost-found/posts/" + lostPost.id, "GET", other),
      await call("/lost-found/posts/" + foundPost.id, "GET", finder),
      await call("/lost-found/me", "GET", finder),
      await call("/lost-found/returned"),
      await call("/lost-found/returned?view=strip"),
      await call("/lost-found/people/" + foundPost.poster.key),
      await call("/me/messages/summary", "GET", other),
      await call("/admin/lost-found/overview", "GET", await token("m_admin")),
    ];
    for (const res of payloads) {
      expect(res.status, res.raw).toBe(200);
      expect(res.raw).not.toMatch(/smith|0199|555|private_?ink|ink_json|original_key|lost-found\/private/i);
    }
    // The lost poster sees their own private text on their own post, and only there.
    const own = await call("/lost-found/posts/" + lostPost.id, "GET", wendy.token);
    expect(own.data.post.privateInk).toBe("Wendy Smith 252-555-0199");
    expect(own.data.post.matches).toEqual([expect.objectContaining({ id: match.id, strength: "strong" })]);
    // The finder is told someone was notified, never who or why.
    const finderView = (await call("/lost-found/posts/" + foundPost.id, "GET", finder)).data.post;
    expect(finderView.ownersNotified).toBe(1);
    expect(finderView.privateInk).toBeUndefined();
  });

  it("runs That's mine -> contact -> Returned -> confirm -> +10 karma once, with authz on every step", async () => {
    const { wendy, foundPost, match, finder } = await scenario();
    const other = await token("m_cy");
    // Only the possible owner can open the match.
    expect((await call("/lost-found/matches/" + match.id, "GET", other)).status).toBe(404);
    expect((await call("/lost-found/matches/" + match.id, "GET", finder)).status).toBe(404);
    expect((await call("/lost-found/matches/" + match.id)).status).toBe(401);
    const view = await call("/lost-found/matches/" + match.id, "GET", wendy.token);
    expect(view.data.match).toMatchObject({ strength: "strong", canDecide: true, found: { id: foundPost.id } });
    expect(view.data.match.reasons).toContain("The phone number on the disc matches");
    expect(view.raw).not.toMatch(/0199|smith/i);

    const claimed = await call(`/lost-found/matches/${match.id}/mine`, "POST", wendy.token, { message: "It has my name on the rim." });
    expect(claimed.status, claimed.raw).toBe(201);
    const claim = claimed.data.claim;
    expect(claim).toMatchObject({ status: "open", role: "owner", contact: { kind: "relay" }, canCancel: true });
    expect((await call(`/lost-found/matches/${match.id}/mine`, "POST", wendy.token, {})).status).toBe(409);
    expect((await getPost(foundPost.id)).status).toBe("claimed");
    expect(db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_bo' ORDER BY id DESC LIMIT 1").get()).toEqual({ title: "Someone says it's their disc" });

    // Contact: the finder writes; the guest gets it by email without anyone's address.
    expect((await call(`/lost-found/claims/${claim.id}`, "GET", other)).status).toBe(404);
    expect((await call(`/lost-found/claims/${claim.id}/messages`, "POST", other, { body: "hi" })).status).toBe(404);
    const sent = await call(`/lost-found/claims/${claim.id}/messages`, "POST", finder, { body: "I can drop it at the club bin Saturday." });
    expect(sent.status).toBe(201);
    const relay = mail.find((row) => row.to === "wendy@example.test" && row.subject.startsWith("Lost & Found: a message"));
    expect(relay?.text).toContain("club bin Saturday");
    expect(relay?.text).not.toMatch(/bo@|m_bo/);

    // Only the finder marks it returned; only the owner confirms.
    expect((await call(`/lost-found/claims/${claim.id}/returned`, "POST", wendy.token)).status).toBe(404);
    expect((await call(`/lost-found/claims/${claim.id}/confirm`, "POST", finder)).status).toBe(404);
    expect((await call(`/lost-found/claims/${claim.id}/confirm`, "POST", wendy.token)).status).toBe(409);
    const returned = await call(`/lost-found/claims/${claim.id}/returned`, "POST", finder);
    expect(returned.data.claim).toMatchObject({ status: "returned", canReturn: false });
    expect(mail.some((row) => row.to === "wendy@example.test" && row.subject === "Did you get your disc back?")).toBe(true);
    const confirmed = await call(`/lost-found/claims/${claim.id}/confirm`, "POST", wendy.token);
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.claim).toMatchObject({ status: "confirmed", karma: { awarded: true, points: 10 }, canCelebrate: true });
    expect((await call(`/lost-found/claims/${claim.id}/confirm`, "POST", wendy.token)).status).toBe(409);
    expect(db.raw.prepare("SELECT person_id, delta, reason FROM lf_karma").all()).toEqual([{ person_id: "m_bo", delta: 10, reason: "return_confirmed" }]);
    expect(db.raw.prepare("SELECT status FROM lf_posts ORDER BY id").all()).toEqual([{ status: "returned" }, { status: "returned" }]);
    expect(db.raw.prepare("SELECT title FROM member_notices WHERE member_id = 'm_bo' ORDER BY id DESC LIMIT 1").get()).toEqual({ title: "+10 karma: disc returned" });
    // Originals are gone once the disc is home; the redacted copy stays.
    expect(db.raw.prepare("SELECT original_key, redaction FROM lf_photos WHERE post_id = ?").get(foundPost.id)).toEqual({ original_key: null, redaction: "public" });
    const profile = await call("/lost-found/people/" + foundPost.poster.key);
    expect(profile.data.person).toMatchObject({ name: "Bo Burnham", karma: 10, returned: 1 });
    expect((await getPost(foundPost.id)).poster).toMatchObject({ karma: 10, returned: 1 });
    // The ledger is append-only.
    expect(() => db.raw.prepare("UPDATE lf_karma SET delta = 100").run()).toThrow(/append-only/);
    expect(() => db.raw.prepare("DELETE FROM lf_karma").run()).toThrow(/append-only/);
    // Admin reversal: needs a reason, once, admins only.
    const admin = await token("m_admin");
    expect((await call(`/admin/lost-found/karma/${claim.id}/reverse`, "POST", finder, { reason: "test" })).status).toBe(403);
    expect((await call(`/admin/lost-found/karma/${claim.id}/reverse`, "POST", admin, {})).status).toBe(400);
    expect((await call(`/admin/lost-found/karma/${claim.id}/reverse`, "POST", admin, { reason: "Same household" })).status).toBe(200);
    expect((await call(`/admin/lost-found/karma/${claim.id}/reverse`, "POST", admin, { reason: "Again" })).status).toBe(409);
    expect((await call("/lost-found/people/" + foundPost.poster.key)).data.person).toMatchObject({ karma: 0, returned: 0 });
    expect(db.raw.prepare("SELECT action, reason FROM lf_mod_log").all()).toEqual([{ action: "karma_reverse", reason: "Same household" }]);
  });

  it("never awards karma for your own disc, and members get a direct message thread", async () => {
    const ada = await token("m_ada");
    const bo = await token("m_bo");
    const own = await createPost(bo, foundBody());
    expect((await call(`/lost-found/posts/${own.id}/claim`, "POST", bo, { message: "This is mine, honest" })).status).toBe(403);
    expect(() => db.raw.prepare("INSERT INTO lf_claims (found_id, finder_id, owner_id) VALUES (?, 'm_bo', 'm_bo')").run(own.id)).toThrow(/CHECK/);
    // A direct claim needs a reason the finder can check.
    expect((await call(`/lost-found/posts/${own.id}/claim`, "POST", ada, { message: "mine" })).status).toBe(400);
    const claimed = await call(`/lost-found/posts/${own.id}/claim`, "POST", ada, { message: "Orange Destroyer, my initials AL on the back" });
    expect(claimed.status).toBe(201);
    expect(claimed.data.claim.contact.kind).toBe("dm");
    const thread = db.raw.prepare("SELECT body, sender_id FROM member_messages").get() as any;
    expect(thread).toMatchObject({ sender_id: "m_ada" });
    expect(thread.body).toContain("my initials AL");
    expect((await call(`/lost-found/claims/${claimed.data.claim.id}/messages`, "POST", bo, { body: "hi" })).status).toBe(409);
    // A second claimant is closed when the disc goes back to the first.
    const cy = await token("m_cy");
    const second = await call(`/lost-found/posts/${own.id}/claim`, "POST", cy, { message: "I lost an orange Destroyer there too" });
    await call(`/lost-found/claims/${claimed.data.claim.id}/returned`, "POST", bo);
    expect((await call(`/lost-found/claims/${second.data.claim.id}`, "GET", cy)).data.claim.status).toBe("declined");
    // The owner can say "not yet", and the finder can mark it again.
    await call(`/lost-found/claims/${claimed.data.claim.id}/not-yet`, "POST", ada);
    expect((await call(`/lost-found/claims/${claimed.data.claim.id}/returned`, "POST", bo)).status).toBe(200);
    expect((await call(`/lost-found/claims/${claimed.data.claim.id}/confirm`, "POST", ada)).status).toBe(200);
    expect(db.raw.prepare("SELECT person_id, delta FROM lf_karma").all()).toEqual([{ person_id: "m_bo", delta: 10 }]);
  });

  it("tells a club member whose full name is on a found disc, without telling the finder who", async () => {
    geminiReplies = [inkReply([{ text: "CY YOUNG", type: "name", box_2d: [300, 250, 420, 700] }])];
    const finder = await guestToken("finn@example.test", "Finn Finder");
    const post = await createPost(finder.token, foundBody());
    const match = db.raw.prepare("SELECT candidate_id, lost_id, status, reasons FROM lf_matches").get() as any;
    expect(match).toEqual({ candidate_id: "m_cy", lost_id: null, status: "notified", reasons: '["member_name"]' });
    const notice = db.raw.prepare("SELECT title, body, href FROM member_notices WHERE member_id = 'm_cy'").get() as any;
    expect(notice).toMatchObject({ title: "Is this your disc?", href: "/gvdg-members.html#lost-found" });
    expect(notice.body).toContain("A disc that may be yours was found at Elm Street Park");
    const finderMail = mail.find((row) => row.to === "finn@example.test" && row.subject === "Someone may own the disc you found");
    expect(finderMail?.text).not.toMatch(/young|cy\b/i);
    const finderView = await call("/lost-found/posts/" + post.id, "GET", finder.token);
    expect(finderView.raw).not.toMatch(/young/i);
    const summary = await call("/me/messages/summary", "GET", await token("m_cy"));
    expect(summary.data.lostFound.waiting).toBe(1);
  });
});

describe("lost & found celebrations and moderation", () => {
  async function confirmedReturn() {
    const ada = await token("m_ada");
    const bo = await token("m_bo");
    const post = await createPost(bo, foundBody({ brand: "Discraft", mold: "Buzzz", plastic: "ESP", color: "Blue" }));
    const claim = (await call(`/lost-found/posts/${post.id}/claim`, "POST", ada, { message: "Blue Buzzz with a smiley on it" })).data.claim;
    await call(`/lost-found/claims/${claim.id}/returned`, "POST", bo);
    await call(`/lost-found/claims/${claim.id}/confirm`, "POST", ada);
    return { ada, bo, post, claim };
  }

  it("lets the finder (and the owner) celebrate a confirmed return on the wall, Home and the homepage strip", async () => {
    const { ada, bo, claim } = await confirmedReturn();
    const cy = await token("m_cy");
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", cy, { caption: "x", photos: [PHOTO] })).status).toBe(404);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "x", photos: [] })).status).toBe(400);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "x", photos: [PHOTO, PHOTO, PHOTO] })).status).toBe(400);
    geminiReplies = [inkReply([{ text: "ADA 555-0134", type: "phone", box_2d: FIXTURE_BOX }])];
    const made = await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "Back where it belongs!", photos: [PHOTO] });
    expect(made.status, made.raw).toBe(201);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "again", photos: [PHOTO] })).status).toBe(409);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", ada, { caption: "Thank you Bo!", photos: [PHOTO] })).status).toBe(201);
    const wall = await call("/lost-found/returned");
    expect(wall.data.celebrations.map((row: any) => row.caption)).toEqual(["Thank you Bo!", "Back where it belongs!"]);
    expect(wall.data.celebrations[1]).toMatchObject({ role: "finder", disc: "Discraft ESP Buzzz", finder: { name: "Bo Burnham", karma: 10, returned: 1 } });
    expect(wall.data.celebrations[1].photos).toHaveLength(1);
    expect(wall.data.topFinders).toEqual([expect.objectContaining({ name: "Bo Burnham", karma: 10, returned: 1 })]);
    expect(wall.raw).not.toMatch(/555|0134/);
    const strip = await call("/lost-found/returned?view=strip&limit=4");
    expect(strip.data.recent[0]).toMatchObject({ disc: "Discraft ESP Buzzz", caption: "Back where it belongs!", finder: { name: "Bo Burnham" } });
    expect(strip.data.recent[0].photo.url).toMatch(/^\/lost-found\/photos\/\d+$/);
    expect(strip.data.celebrations).toBeUndefined();
    const home = await call("/me/messages/summary", "GET", cy);
    expect(home.data.lostFound.recent[0]).toMatchObject({ disc: "Discraft ESP Buzzz", finder: { name: "Bo Burnham", karma: 10 }, course: "Elm Street Park" });

    // Report -> admin queue -> hide (with a reason) -> gone from the wall and its photo 404s.
    const celebrationId = wall.data.celebrations[1].id;
    const photoUrl = wall.data.celebrations[1].photos[0].url;
    expect((await call(photoUrl)).status).toBe(200);
    expect((await call("/lost-found/reports", "POST", bo, { kind: "celebration", id: celebrationId, reason: "spam" })).status).toBe(403);
    expect((await call("/lost-found/reports", "POST", cy, { kind: "celebration", id: celebrationId, reason: "privacy", details: "Shows a face" })).status).toBe(201);
    expect((await call("/lost-found/reports", "POST", cy, { kind: "celebration", id: celebrationId, reason: "privacy" })).status).toBe(409);
    const admin = await token("m_admin");
    expect((await call("/admin/lost-found/summary", "GET", admin)).data.openReports).toBe(1);
    const overview = await call("/admin/lost-found/overview", "GET", admin);
    expect(overview.data.reports[0]).toMatchObject({ kind: "celebration", reason: "privacy", target: { text: "Back where it belongs!" } });
    expect((await call(`/admin/lost-found/celebrations/${celebrationId}/hide`, "POST", cy, { reason: "nope" })).status).toBe(403);
    expect((await call(`/admin/lost-found/celebrations/${celebrationId}/hide`, "POST", admin, { reason: "Face without consent" })).status).toBe(200);
    expect((await call("/lost-found/returned")).data.celebrations.map((row: any) => row.id)).not.toContain(celebrationId);
    expect((await call(photoUrl)).status).toBe(404);
    expect((await call("/admin/lost-found/summary", "GET", admin)).data.openReports).toBe(0);
  });

  it("admins hide, close and merge posts with a logged reason; owners close and photos are deleted with the post", async () => {
    const bo = await token("m_bo");
    const admin = await token("m_admin");
    const first = await createPost(bo, foundBody());
    const duplicate = await createPost(bo, foundBody());
    expect((await call(`/admin/lost-found/posts/${first.id}/hide`, "POST", admin, { reason: "ok" })).status).toBe(400);
    expect((await call(`/admin/lost-found/posts/${first.id}/hide`, "POST", admin, { reason: "Wrong photo" })).status).toBe(200);
    expect((await call("/lost-found/posts/" + first.id)).status).toBe(404);
    expect((await call("/lost-found/posts/" + first.id, "GET", bo)).status).toBe(200);
    await call(`/admin/lost-found/posts/${first.id}/unhide`, "POST", admin, { reason: "Fixed" });
    expect((await call(`/admin/lost-found/posts/${duplicate.id}/merge`, "POST", admin, { reason: "Duplicate", into: duplicate.id })).status).toBe(400);
    expect((await call(`/admin/lost-found/posts/${duplicate.id}/merge`, "POST", admin, { reason: "Duplicate", into: first.id })).status).toBe(200);
    expect((await call("/lost-found/posts/" + duplicate.id)).status).toBe(404);
    expect(db.raw.prepare("SELECT status, merged_into FROM lf_posts WHERE id = ?").get(duplicate.id)).toEqual({ status: "merged", merged_into: first.id });
    // Owner close: someone else can't (404), the owner can, and both copies leave R2.
    expect((await call(`/lost-found/posts/${first.id}/close`, "POST", await token("m_cy"))).status).toBe(404);
    expect((await call(`/lost-found/posts/${first.id}/close`, "POST", bo)).status).toBe(200);
    expect([...photos.objects.keys()]).toEqual([]);
    expect(db.raw.prepare("SELECT action FROM lf_mod_log ORDER BY id").all().map((row: any) => row.action)).toEqual(["hide", "unhide", "merge"]);
  });

  it("expires posts after 90 days, rate-limits posting and rejects bad input", async () => {
    const bo = await token("m_bo");
    expect((await call("/lost-found/posts", "POST", undefined, foundBody())).status).toBe(401);
    expect((await call("/lost-found/posts", "POST", bo, foundBody({ photos: [] }))).data.error).toBe("invalid_photo");
    expect((await call("/lost-found/posts", "POST", bo, foundBody({ photos: ["data:image/svg+xml;base64,PHN2Zz4="] }))).data.error).toBe("invalid_photo");
    expect((await call("/lost-found/posts", "POST", bo, foundBody({ courseId: 99999 }))).data).toEqual({ error: "invalid_post", field: "courseId" });
    const post = await createPost(bo, foundBody());
    expect(post.expiresAt).toBe(new Date(Date.now() + 90 * 86_400_000).toISOString().replace("T", " ").slice(0, 10) + post.expiresAt.slice(10));
    for (let i = 0; i < 5; i++) await createPost(bo, foundBody());
    expect((await call("/lost-found/posts", "POST", bo, foundBody())).status).toBe(429);
    db.raw.prepare("UPDATE lf_posts SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(post.id);
    expect((await call("/lost-found/posts/" + post.id)).status).toBe(404);
    const tick = await runLostFoundTick(env);
    expect(tick.expired).toBe(1);
    expect(db.raw.prepare("SELECT status FROM lf_posts WHERE id = ?").get(post.id)).toEqual({ status: "expired" });
    expect(db.raw.prepare("SELECT original_key, public_key, redaction FROM lf_photos WHERE post_id = ?").get(post.id))
      .toEqual({ original_key: null, public_key: null, redaction: "removed" });
  });
});
