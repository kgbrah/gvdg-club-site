import { handicapKey } from "../src/handicap.js";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { parsePost } from "../src/lf-input.js";
import { nameMatch, privateKeys, rosterNameMatch, scoreMatch, type FoundSide, type LostSide } from "../src/lf-match.js";
import { DEFAULT_DAILY_VISION_BUDGET, MAX_ATTEMPTS, dailyVisionBudget, runLostFoundTick, visionPerMinute } from "../src/lf-process.js";
import { base64Of, extractionStatus, inkKeys, normalizeName, parseCompare, parseDiscExtraction, phoneDigits, showsPersonalInfo } from "../src/lf-vision.js";
import { dataUrl, testJpeg } from "./lf-harness.js";
import { clubDayOf, runKarmaWatch } from "../src/karma-watch.js";

/** Admin alerts sent (the real sender needs push subscriptions; these tests only need to see the note). */
const adminPushes = vi.hoisted(() => [] as Array<{ title: string; body: string; url: string; tag: string }>);
vi.mock("../src/admin-push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admin-push.js")>();
  return { ...actual, notifyAdmins: (_ctx: unknown, _env: unknown, note: (typeof adminPushes)[number]) => { adminPushes.push(note); } };
});

/** Public trader keys are random hex, so they can contain "555", "0199" or "ada" by chance. Blank them before
 * asserting that ink, phone digits or private text never reach a payload. */
const scrubKeys = (raw: string) => raw.replace(/"key":"[0-9a-f]+"/g, '"key":"-"').replace(/(\?gl=)[A-Za-z0-9_-]+/g, "$1-");


const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const FIXTURE = testJpeg();

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
/** What the mocked Gemini says next about a disc photo (defaults to "no writing"). */
let geminiReplies: string[];
/** Set to 429 to make Gemini answer "too many requests". */
let geminiStatus: number;
let geminiCalls: number;
let openRouterReply: string | null;
/** Gemini's answer to "is this the SAME physical disc?" (defaults to yes). */
let compareReply: string;

const NO_INK = JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "Star Destroyer", ink: [], unreadable_writing: false, ink_confidence: "high" });
function inkReply(ink: Array<{ text: string; type: string }>, extra: Record<string, unknown> = {}) {
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
  // Background work (the private AI read, matching, notices) finishes before the test looks.
  while (pending.length) await Promise.all(pending.splice(0));
  return { status: response.status, data, raw: raw ?? "", headers: response.headers };
}

const PHOTO = dataUrl(FIXTURE);

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

function photoIdsOf(postId: number): number[] {
  return (db.raw.prepare("SELECT id FROM lf_photos WHERE post_id = ? ORDER BY sort_order, id").all(postId) as Array<{ id: number }>).map((row) => row.id);
}

beforeEach(async () => {
  db = await sqliteDb();
  photos = r2();
  mail = [];
  geminiReplies = [];
  geminiStatus = 200;
  geminiCalls = 0;
  openRouterReply = null;
  compareReply = '{"same":"yes"}';
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
      if (geminiStatus !== 200) return new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: geminiStatus });
      const prompt = String(init?.body || "");
      const text = prompt.includes("SAME physical disc") ? compareReply : geminiReplies.shift() ?? NO_INK;
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
  it("parses a Gemini disc read and validates every field", () => {
    const read = parseDiscExtraction("```json\n" + inkReply([
      { text: "WENDY SMITH", type: "name" },
      { text: "252 555 0199", type: "phone" },
      { text: "??", type: "weird" },
      { text: "", type: "name" },
    ], { colors: ["Orange / Grey", "chartreuse"] }) + "\n```");
    expect(read.parsed).toBe(true);
    expect(read.brand).toBe("Innova");
    expect(read.colors).toEqual(["orange", "gray"]);
    expect(read.ink).toEqual([{ text: "WENDY SMITH", type: "name" }, { text: "252 555 0199", type: "phone" }, { text: "??", type: "other" }]);
    expect(parseDiscExtraction("no json here").parsed).toBe(false);
    expect(parseDiscExtraction('{"ink": "nope"}').ink).toEqual([]);
  });

  it("rates a read: a confident Gemini read is ok, a fallback or unsure one is kept as unsure, nothing usable is empty", () => {
    const named = parseDiscExtraction(inkReply([{ text: "WENDY", type: "name" }]));
    expect(extractionStatus(named, "gemini:gemini-2.5-flash")).toBe("ok");
    expect(extractionStatus(named, "openrouter:any")).toBe("unsure");
    expect(extractionStatus(named, null)).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(inkReply([], { unreadable_writing: true })), "gemini:x")).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(inkReply([{ text: "W", type: "initials" }], { ink_confidence: "low" })), "gemini:x")).toBe("unsure");
    expect(extractionStatus(parseDiscExtraction(NO_INK), "gemini:x")).toBe("ok");
    expect(extractionStatus(parseDiscExtraction(""), "gemini:x")).toBe("empty");
  });

  it("nudges the uploader only for a name or a phone number, not initials or notes", () => {
    expect(showsPersonalInfo([{ text: "WENDY SMITH", type: "name" }])).toBe(true);
    expect(showsPersonalInfo([{ text: "call 252 555 0199", type: "other" }])).toBe(true);
    expect(showsPersonalInfo([{ text: "Smith", type: "name" }])).toBe(true);
    expect(showsPersonalInfo([{ text: "WS", type: "initials" }, { text: "#7", type: "other" }])).toBe(false);
    expect(showsPersonalInfo([])).toBe(false);
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
    // Weight and hole from the pick-lists: close weights and the same hole on the same course add up; far weights subtract.
    const picked = scoreMatch(found({ weightG: 174, hole: 7 }), lost({ weightG: 175, hole: 7 }));
    expect(picked.reasons).toEqual(expect.arrayContaining(["weight", "hole"]));
    expect(picked.score).toBe(scoreMatch(found(), lost()).score + 10);
    expect(scoreMatch(found({ weightG: 150 }), lost({ weightG: 175 })).reasons).toContain("weight_mismatch");
    expect(scoreMatch(found({ hole: 7, courseId: 2 }), lost({ hole: 7 })).reasons).not.toContain("hole");
    expect(scoreMatch(found({ weightG: null }), lost({ weightG: 175 })).reasons).not.toContain("weight");
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
    expect(parsePost({ kind: "found", weightG: "175", hole: 7 })).toMatchObject({ ok: true, value: { weightG: 175, hole: 7 } });
    expect(parsePost({ kind: "found", weightG: "", hole: null })).toMatchObject({ ok: true, value: { weightG: null, hole: null } });
    expect(parsePost({ kind: "found", weightG: 99 })).toEqual({ ok: false, field: "weightG" });
    expect(parsePost({ kind: "found", weightG: 175.5 })).toEqual({ ok: false, field: "weightG" });
    expect(parsePost({ kind: "found", hole: 41 })).toEqual({ ok: false, field: "hole" });
    expect(parsePost({ kind: "found", holding: "club_bin" })).toEqual({ ok: false, field: "binNote" });
    expect(parsePost({ kind: "lost" })).toEqual({ ok: false, field: "mold" });
    expect(parsePost({ kind: "lost", privateInk: "Wendy" }).ok).toBe(true);
    expect(parsePost({ kind: "lost", color: "Red", eventDate: "2099-01-01" })).toEqual({ ok: false, field: "eventDate" });
    expect(parsePost({ kind: "stolen" })).toEqual({ ok: false, field: "kind" });
  });
});

describe("lost & found AI cost helpers", () => {
  it("base64-encodes in pieces that join exactly like one call", () => {
    for (const size of [0, 1, 2, 3, 24_575, 24_576, 24_577, 100_001]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 37) & 255);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      expect(base64Of(bytes)).toBe(btoa(bin));
    }
  });

  it("keeps the Lost & Found vision budget configurable, defaulting to 150 a day and 4 a minute", () => {
    expect(DEFAULT_DAILY_VISION_BUDGET).toBe(150);
    expect(dailyVisionBudget(makeEnv())).toBe(150);
    expect(dailyVisionBudget(makeEnv({ LF_DAILY_VISION_BUDGET: "40" }))).toBe(40);
    expect(dailyVisionBudget(makeEnv({ LF_DAILY_VISION_BUDGET: "lots" }))).toBe(150);
    expect(visionPerMinute(makeEnv())).toBe(4);
    expect(visionPerMinute(makeEnv({ LF_VISION_PER_MINUTE: "8" }))).toBe(8);
    expect(visionPerMinute(makeEnv({ LF_VISION_PER_MINUTE: "0" }))).toBe(4);
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
  const nudgeOf = (photoId: number) => (db.raw.prepare("SELECT nudge FROM lf_photos WHERE id = ?").get(photoId) as { nudge: string }).nudge;

  it("a photo is public as uploaded, without its metadata; the private read nudges the uploader and nobody else", async () => {
    geminiReplies = [inkReply([{ text: "ADA 555-0134", type: "phone" }])];
    const finder = await token("m_bo");
    const other = await token("m_cy");
    const created = await createPost(finder, foundBody());
    expect(geminiCalls).toBe(1);
    const [photoId] = photoIdsOf(created.id);
    // Up at once: the stored file is the upload minus its EXIF / GPS segment, and that is what is served.
    expect(created.photos).toEqual([{ id: photoId, url: "/lost-found/photos/" + photoId }]);
    const stored = [...photos.objects.values()];
    expect(stored).toHaveLength(1);
    expect(hasText(FIXTURE, "GPSLatitude")).toBe(true);
    expect(hasText(stored[0]!.bytes, "GPSLatitude")).toBe(false);
    expect(hasText(stored[0]!.bytes, "Exif")).toBe(false);
    const served = await call("/lost-found/photos/" + photoId);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
    expect(served.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect([...served.data]).toEqual([...stored[0]!.bytes]);
    expect([...photos.objects.keys()][0]).toMatch(new RegExp(`^lost-found/post-${created.id}/[0-9a-f-]{36}\\.jpg$`));

    // The read filled in empty details (and says so), and found a phone number: the uploader is nudged.
    let post = await getPost(created.id);
    expect(post.title).toBe("Innova Star Destroyer");
    expect(post.aiFields).toEqual(["brand", "mold", "plastic"]);
    expect(db.raw.prepare("SELECT read_state, nudge, attempts FROM lf_photos").get()).toEqual({ read_state: "done", nudge: "shown", attempts: 1 });
    const own = await call("/lost-found/posts/" + created.id, "GET", finder);
    expect(own.data.post.myPhotos).toEqual([{ id: photoId, url: "/lost-found/photos/" + photoId, nudge: true }]);
    const mine = await call("/lost-found/me", "GET", finder);
    expect(mine.data.nudges).toEqual([{ id: photoId, url: "/lost-found/photos/" + photoId, postId: created.id, celebrationId: null, title: "Innova Star Destroyer" }]);
    expect((await call("/me/messages/summary", "GET", finder)).data.lostFound.waiting).toBe(1);
    // ...and never told what was read. Nobody else sees a nudge, a myPhotos list or the ink.
    for (const res of [own, mine]) expect(scrubKeys(res.raw)).not.toMatch(/ADA|555|0134|phone|ink/i);
    for (const res of [await call("/lost-found/posts/" + created.id), await call("/lost-found/posts/" + created.id, "GET", other),
      await call("/lost-found/posts?kind=found"), await call("/admin/lost-found/overview", "GET", await token("m_admin"))]) {
      expect(res.status).toBe(200);
      expect(scrubKeys(res.raw)).not.toMatch(/nudge|myPhotos|ADA|555|0134|lost-found\/post-/i);
    }
    const othersMine = await call("/lost-found/me", "GET", other);
    expect(othersMine.data.nudges).toEqual([]);
    expect(scrubKeys(othersMine.raw)).not.toMatch(/ADA|555|0134|lost-found\/post-/i);
    expect((await call("/me/messages/summary", "GET", other)).data.lostFound.waiting).toBe(0);

    // Keep it: the uploader only; the nudge goes away and stays away.
    for (const bearer of [other, undefined]) expect((await call(`/lost-found/photos/${photoId}/keep`, "POST", bearer)).status).toBe(404);
    expect(nudgeOf(photoId!)).toBe("shown");
    expect((await call(`/lost-found/photos/${photoId}/keep`, "POST", finder)).data.photo).toEqual({ id: photoId, url: "/lost-found/photos/" + photoId, nudge: false });
    expect((await call(`/lost-found/photos/${photoId}/keep`, "POST", finder)).status).toBe(409);
    expect(nudgeOf(photoId!)).toBe("kept");
    expect((await call("/lost-found/me", "GET", finder)).data.nudges).toEqual([]);
    post = await getPost(created.id);
    expect(post.photos).toHaveLength(1);

    // A read that puts the writing into a public field (here "mold") is not used for that field.
    geminiReplies = [inkReply([{ text: "WENDY SMITH", type: "name" }], { brand: "Innova", mold: "Wendy Smith", plastic: "Star 2525550199" })];
    const echoed = await getPost((await createPost(finder, foundBody())).id);
    expect(echoed).toMatchObject({ brand: "Innova", mold: "", plastic: "" });
    const list = await call("/lost-found/posts?kind=found");
    expect(scrubKeys(list.raw)).not.toMatch(/555|0134|ADA|wendy/i);
  });

  it("Replace photo swaps the file (the old one leaves R2), keeps the old read for matching, and reads the new one", async () => {
    geminiReplies = [inkReply([{ text: "WENDY SMITH", type: "name" }, { text: "252 555 0199", type: "phone" }])];
    const finder = await token("m_bo");
    const other = await token("m_cy");
    const created = await createPost(finder, foundBody({ photos: [PHOTO, dataUrl(testJpeg(1))] }));
    const [first, second] = photoIdsOf(created.id);
    const oldKey = (db.raw.prepare("SELECT photo_key FROM lf_photos WHERE id = ?").get(first) as { photo_key: string }).photo_key;
    expect(nudgeOf(first!)).toBe("shown");
    expect(nudgeOf(second!)).toBe("");
    // Not theirs, not signed in, or not an image: no.
    for (const bearer of [other, undefined]) expect((await call(`/lost-found/photos/${first}/replace`, "POST", bearer, { image: PHOTO })).status).toBe(404);
    expect((await call(`/lost-found/photos/${first}/replace`, "POST", finder, { image: "data:image/svg+xml;base64,PHN2Zz4=" })).data.error).toBe("invalid_photo");
    // The new photo (the poster covered the writing): it takes the same place, and its read finds nothing.
    geminiReplies = [NO_INK];
    const replaced = await call(`/lost-found/photos/${first}/replace`, "POST", finder, { image: dataUrl(testJpeg(2)) });
    expect(replaced.status, replaced.raw).toBe(201);
    const newId = replaced.data.photo.id as number;
    expect(replaced.data).toEqual({ photo: { id: newId, url: "/lost-found/photos/" + newId, nudge: false }, replaced: first });
    expect(photos.objects.has(oldKey)).toBe(false);
    expect((await call("/lost-found/photos/" + first)).status).toBe(404);
    expect((await call("/lost-found/photos/" + newId)).status).toBe(200);
    expect((await getPost(created.id)).photos.map((row: any) => row.id)).toEqual([newId, second]);
    expect(db.raw.prepare("SELECT read_state, nudge FROM lf_photos WHERE id = ?").get(newId)).toEqual({ read_state: "done", nudge: "" });
    // The first read stays with the post: the writing on the disc still helps find its owner.
    expect(db.raw.prepare("SELECT photo_id, ink_phones FROM lf_extractions WHERE post_id = ? ORDER BY id").all(created.id))
      .toEqual([{ photo_id: first, ink_phones: "2525550199" }, { photo_id: second, ink_phones: "" }, { photo_id: newId, ink_phones: "" }]);
    expect((await call(`/lost-found/photos/${first}/replace`, "POST", finder, { image: PHOTO })).status).toBe(404);
    // A replacement that still shows a name brings the nudge back.
    geminiReplies = [inkReply([{ text: "WENDY SMITH", type: "name" }])];
    const again = await call(`/lost-found/photos/${newId}/replace`, "POST", finder, { image: dataUrl(testJpeg(3)) });
    expect(nudgeOf(again.data.photo.id)).toBe("shown");
    // Removing: the uploader only; the file leaves R2 at once.
    expect((await call(`/lost-found/posts/${created.id}/photos/${second}/remove`, "POST", other)).status).toBe(404);
    expect((await call(`/lost-found/photos/${second}/remove`, "POST", other)).status).toBe(404);
    const removed = await call(`/lost-found/posts/${created.id}/photos/${second}/remove`, "POST", finder);
    expect(removed.data.post.photos.map((row: any) => row.id)).toEqual([again.data.photo.id]);
    expect((await call("/lost-found/photos/" + second)).status).toBe(404);
    expect(photos.objects.size).toBe(1);
  });

  it("shows the photo even when the AI is unavailable; the cron reads it later; public GETs never call the AI", async () => {
    env = makeEnv({ GEMINI_API_KEY: "" });
    const finder = await token("m_bo");
    const created = await createPost(finder, foundBody());
    const post = await getPost(created.id);
    expect(post.photos).toHaveLength(1);
    const photo = db.raw.prepare("SELECT id, read_state, attempts, last_error FROM lf_photos").get() as any;
    expect(photo).toMatchObject({ read_state: "pending", attempts: 1, last_error: "ai_unavailable" });
    expect((await call("/lost-found/photos/" + photo.id)).status).toBe(200);
    const before = geminiCalls;
    await call("/lost-found/posts/" + created.id);
    await call("/lost-found/posts?kind=found");
    await call("/lost-found/returned");
    await call("/lost-found/returned?view=strip");
    await call("/lost-found/photos/" + photo.id);
    expect(geminiCalls).toBe(before);
    // The AI comes back; the next due cron tick reads the photo and matches the post.
    env = makeEnv();
    geminiReplies = [inkReply([{ text: "BO BURNHAM", type: "name" }])];
    db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute')").run();
    expect(await runLostFoundTick(env)).toMatchObject({ reads: 1, matched: 1 });
    expect(db.raw.prepare("SELECT read_state, nudge FROM lf_photos").get()).toEqual({ read_state: "done", nudge: "shown" });
  });

  it("keeps a fallback provider's read, and gives up an unreadable photo after the retries without hiding it", async () => {
    // Gemini down, OpenRouter answers: it fills in details and is kept (no retry spent on it).
    env = makeEnv({ GEMINI_API_KEY: "", OPENROUTER_API_KEY: "or_test" });
    openRouterReply = NO_INK;
    const fallback = await createPost(await token("m_cy"), foundBody());
    expect((await getPost(fallback.id)).mold).toBe("Destroyer");
    expect(db.raw.prepare("SELECT source, status FROM lf_extractions").all()).toEqual([{ source: "openrouter:nvidia/nemotron-nano-12b-v2-vl:free", status: "unsure" }]);
    expect(db.raw.prepare("SELECT read_state, attempts FROM lf_photos").get()).toEqual({ read_state: "done", attempts: 1 });
    // No provider at all: the read backs off and gives up; the photo stays up throughout.
    env = makeEnv({ GEMINI_API_KEY: "" });
    const unread = await createPost(await token("m_bo"), foundBody());
    for (let i = 0; i < 8; i++) {
      for (const key of [...(env.RATELIMIT as any).rows.keys()]) if (String(key).startsWith("lfai:m:")) env.RATELIMIT.delete(key);
      db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute')").run();
      await runLostFoundTick(env);
    }
    expect(db.raw.prepare("SELECT read_state, attempts FROM lf_photos WHERE post_id = ?").get(unread.id)).toEqual({ read_state: "failed", attempts: MAX_ATTEMPTS });
    expect((await getPost(unread.id)).photos).toHaveLength(1);
    const summary = await call("/admin/lost-found/summary", "GET", await token("m_admin"));
    expect(summary.data).toEqual({ openReports: 0, karmaFlags: 0 });
  });

  it("a free-tier quota answer is 'try later': it never uses up an attempt", async () => {
    geminiStatus = 429;
    const finder = await token("m_bo");
    await createPost(finder, foundBody());
    expect(db.raw.prepare("SELECT read_state, attempts, last_error FROM lf_photos").get()).toEqual({ read_state: "pending", attempts: 0, last_error: "ai_quota" });
    // A cool-down follows a 429, then the per-minute cap and the daily budget hold calls back too.
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      env.RATELIMIT.delete("lfai:cooldown");
      db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute')").run();
      await runLostFoundTick(env);
    }
    expect(db.raw.prepare("SELECT read_state, attempts FROM lf_photos").get()).toEqual({ read_state: "pending", attempts: 0 });
    expect(geminiCalls).toBeLessThanOrEqual(5);
    // Quota is back: the read succeeds.
    geminiStatus = 200;
    for (const key of [...(env.RATELIMIT as any).rows.keys()]) if (String(key).startsWith("lfai:")) env.RATELIMIT.delete(key);
    db.raw.prepare("UPDATE lf_photos SET next_attempt_at = datetime('now', '-1 minute')").run();
    await runLostFoundTick(env);
    expect(db.raw.prepare("SELECT read_state, attempts FROM lf_photos").get()).toEqual({ read_state: "done", attempts: 1 });
  });

  it("holds Lost & Found to its daily vision budget so tee-sign OCR keeps room", async () => {
    env = makeEnv({ LF_DAILY_VISION_BUDGET: "2" });
    const finder = await token("m_bo");
    for (let i = 0; i < 3; i++) await createPost(finder, foundBody());
    expect(geminiCalls).toBe(2);
    const waiting = db.raw.prepare("SELECT read_state, attempts, last_error FROM lf_photos ORDER BY id DESC LIMIT 1").get();
    expect(waiting).toEqual({ read_state: "pending", attempts: 0, last_error: "ai_budget" });
  });
});

describe("lost & found matching, claims, returns and karma", () => {
  async function scenario() {
    // A member finds a disc with a name and phone on it; a guest lost it and described the ink privately.
    const wendy = await guestToken();
    const lostPost = await createPost(wendy.token, lostBody());
    geminiReplies = [inkReply([
      { text: "WENDY SMITH", type: "name" },
      { text: "252 555 0199", type: "phone" },
    ])];
    const finder = await token("m_bo");
    const foundPost = await createPost(finder, foundBody());
    const match = db.raw.prepare("SELECT * FROM lf_matches").get() as any;
    expect(match?.status).toBe("notified");
    return { wendy, lostPost, foundPost, match, finder };
  }

  it("suggests and announces a strong match, and keeps every private string out of public payloads", async () => {
    const { wendy, lostPost, foundPost, match, finder } = await scenario();
    expect(match).toMatchObject({ found_id: foundPost.id, lost_id: lostPost.id, candidate_id: expect.stringMatching(/^mg_/), status: "notified" });
    expect(JSON.parse(match.reasons)).toEqual(expect.arrayContaining(["ink_phone", "ink_name", "mold", "course"]));
    const toWendy = mail.find((row) => row.to === "wendy@example.test" && row.subject === "Is this your disc?");
    // Wendy is a guest: the link signs her in wherever she opens it.
    expect(toWendy?.text).toMatch(new RegExp("lost-found\\.html\\?gl=[^#\\s]+#match/" + match.id));
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
      expect(scrubKeys(res.raw)).not.toMatch(/smith|0199|555|private_?ink|ink_json|ink_names|photo_key|lost-found\/post-/i);
    }
    // Only the finder's own views carry their photo nudge; nobody else's ever does.
    for (const res of payloads.filter((_, i) => i !== 5 && i !== 6)) expect(scrubKeys(res.raw)).not.toMatch(/nudge|myPhotos|nudges/);
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
    expect(scrubKeys(view.raw)).not.toMatch(/0199|smith/i);

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

    // Wendy verified once. The link in the email signs her in wherever she opens it (mail app, laptop): no second code.
    const linkUrl = /Reply on the claim page: (\S+)/.exec(relay!.text)![1]!;
    expect(linkUrl).toMatch(/\/lost-found\.html\?gl=[^#]+#claim\/\d+$/);
    const link = decodeURIComponent(/gl=([^#&]+)/.exec(linkUrl)![1]!);
    // The link is never a session by itself, as a guest or as a member.
    expect((await call(`/lost-found/claims/${claim.id}`, "GET", link)).status).toBe(401);
    expect((await call("/me", "GET", link)).status).toBe(401);
    const exchanged = await call("/market/guest/link", "POST", undefined, { token: link });
    expect(exchanged.status, exchanged.raw).toBe(200);
    expect(exchanged.data.guest).toEqual({ key: wendy.guest.key, name: "Wendy Guest" });
    expect((await call(`/lost-found/claims/${claim.id}`, "GET", exchanged.data.token)).status).toBe(200);
    expect((await call("/market/guest/link", "POST", undefined, { token: "nope" })).data.error).toBe("link_expired");
    expect((await call("/market/guest/link", "POST", undefined, { token: wendy.token })).data.error).toBe("link_expired");

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
    // The photo stays up once the disc is home (the Returned wall and the homepage use it).
    expect(db.raw.prepare("SELECT photo_key IS NOT NULL AS kept, status FROM lf_photos WHERE post_id = ?").get(foundPost.id)).toEqual({ kept: 1, status: "public" });
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
    geminiReplies = [inkReply([{ text: "CY YOUNG", type: "name" }])];
    const finder = await guestToken("finn@example.test", "Finn Finder");
    const post = await createPost(finder.token, foundBody());
    const match = db.raw.prepare("SELECT candidate_id, lost_id, status, reasons FROM lf_matches").get() as any;
    expect(match).toEqual({ candidate_id: "m_cy", lost_id: null, status: "notified", reasons: '["member_name"]' });
    const notice = db.raw.prepare("SELECT title, body, href FROM member_notices WHERE member_id = 'm_cy'").get() as any;
    expect(notice).toMatchObject({ title: "Is this your disc?", href: "/gvdg-members.html#lost-found" });
    expect(notice.body).toContain("A disc that may be yours was found at Elm Street Park");
    const finderMail = mail.find((row) => row.to === "finn@example.test" && row.subject === "Someone may own the disc you found");
    expect(scrubKeys(finderMail?.text ?? "")).not.toMatch(/young|cy\b/i);
    const finderView = await call("/lost-found/posts/" + post.id, "GET", finder.token);
    expect(scrubKeys(finderView.raw)).not.toMatch(/young/i);
    const summary = await call("/me/messages/summary", "GET", await token("m_cy"));
    expect(summary.data.lostFound.waiting).toBe(1);
  });
});

describe("lost & found and My Bag", () => {
  /** A member's bag disc, as the practice sync stores it. */
  function bagDiscRow(owner: string, record: Record<string, unknown>) {
    const id = crypto.randomUUID();
    db.raw.prepare(`INSERT INTO member_practice_records (owner, id, kind, revision, occurred_on, payload, last_op, updated_at)
      VALUES (?, ?, 'disc', 1, '2026-11-01', ?, 'op-' || ?, ?)`)
      .run(owner, id, JSON.stringify({ brand: "", model: "", plastic: "", weightGrams: null, notes: "", inBag: true, archived: false, ...record }), id, Date.now());
    return id;
  }

  it("keeps bag photos private to their owner, three a disc, with matching on by default", async () => {
    const ada = await token("m_ada");
    const bo = await token("m_bo");
    const disc = bagDiscRow("m_ada", { brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange" });
    expect((await call("/me/bag")).status).toBe(401);
    expect((await call("/me/bag", "GET", ada)).data).toEqual({ matchFound: true, photos: [], bagPhotos: [], accessories: [], lost: [], listings: [] });
    expect((await call("/me/bag/photos", "POST", ada, { discId: crypto.randomUUID(), image: PHOTO })).status).toBe(404);
    expect((await call("/me/bag/photos", "POST", bo, { discId: disc, image: PHOTO })).status).toBe(404);
    expect((await call("/me/bag/photos", "POST", ada, { discId: disc, image: "data:image/svg+xml;base64,PHN2Zz4=" })).data.error).toBe("invalid_photo");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const added = await call("/me/bag/photos", "POST", ada, { discId: disc, image: PHOTO });
      expect(added.status).toBe(201);
      ids.push(added.data.photo.id);
    }
    expect((await call("/me/bag/photos", "POST", ada, { discId: disc, image: PHOTO })).data.error).toBe("too_many_photos");
    const key = (db.raw.prepare("SELECT photo_key FROM bag_photos WHERE id = ?").get(ids[0]) as any).photo_key;
    expect(key).toMatch(/^bag\/m_ada\//);
    const image = await call("/me/bag/photos/" + ids[0], "GET", ada);
    expect(image.status).toBe(200);
    expect(image.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await call("/me/bag/photos/" + ids[0], "GET", bo)).status).toBe(404);
    expect((await call("/me/bag/photos/" + ids[0])).status).toBe(401);
    expect((await call("/me/bag/photos/" + ids[2], "DELETE", ada)).status).toBe(200);
    expect(photos.objects.has((db.raw.prepare("SELECT photo_key FROM bag_photos WHERE id = ?").get(ids[1]) as any).photo_key)).toBe(true);
    expect((await call("/me/bag", "GET", ada)).data.photos).toEqual([{ id: ids[0], discId: disc }, { id: ids[1], discId: disc }]);
    expect((await call("/me/bag/settings", "PUT", ada, { matchFound: false })).data).toEqual({ matchFound: false });
    expect((await call("/me/bag", "GET", ada)).data.matchFound).toBe(false);
    expect((await call("/me/bag/settings", "PUT", ada, { matchFound: "no" })).status).toBe(400);
    // A deleted bag disc's photos leave storage on the next cron tick.
    db.raw.prepare("UPDATE member_practice_records SET payload = NULL WHERE id = ?").run(disc);
    await runLostFoundTick(env);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM bag_photos").get()).toEqual({ n: 0 });
    expect([...photos.objects.keys()].some((name) => name.startsWith("bag/"))).toBe(false);
  });

  it("keeps photos of the whole bag and of accessories private too, with their own limits", async () => {
    const ada = await token("m_ada");
    const bo = await token("m_bo");
    // The whole bag: up to six.
    for (let i = 0; i < 6; i++) expect((await call("/me/bag/photos", "POST", ada, { bag: true, image: PHOTO })).status).toBe(201);
    expect((await call("/me/bag/photos", "POST", ada, { bag: true, image: PHOTO })).data.error).toBe("too_many_photos");
    // Accessories: create, edit, photos (three each), private, deleted with their photos.
    expect((await call("/me/bag/accessories", "POST", ada, { kind: "jetpack", name: "x" })).status).toBe(400);
    const towel = (await call("/me/bag/accessories", "POST", ada, { kind: "towel", name: "Club towel", notes: "Green, GVDG logo" })).data.accessory;
    expect(towel).toMatchObject({ kind: "towel", name: "Club towel", notes: "Green, GVDG logo", photos: [] });
    const cart = (await call("/me/bag/accessories", "POST", ada, { kind: "cart", name: "" })).data.accessory;
    expect((await call("/me/bag/accessories/" + towel.id, "PATCH", ada, { name: "Big towel" })).data.accessory)
      .toEqual({ id: towel.id, kind: "towel", name: "Big towel", notes: "Green, GVDG logo" });
    expect((await call("/me/bag/accessories/" + towel.id, "PATCH", bo, { name: "mine" })).status).toBe(404);
    const towelPhotos: number[] = [];
    for (let i = 0; i < 3; i++) towelPhotos.push((await call("/me/bag/photos", "POST", ada, { accessoryId: towel.id, image: PHOTO })).data.photo.id);
    expect((await call("/me/bag/photos", "POST", ada, { accessoryId: towel.id, image: PHOTO })).data.error).toBe("too_many_photos");
    expect((await call("/me/bag/photos", "POST", bo, { accessoryId: towel.id, image: PHOTO })).status).toBe(404);
    await call("/me/bag/photos", "POST", ada, { accessoryId: cart.id, image: PHOTO });
    expect((await call("/me/bag/photos/" + towelPhotos[0], "GET", bo)).status).toBe(404);
    const overview = (await call("/me/bag", "GET", ada)).data;
    expect(overview.bagPhotos).toHaveLength(6);
    expect(overview.photos).toEqual([]);
    expect(overview.accessories.map((row: any) => [row.kind, row.name, row.photos.length])).toEqual([["towel", "Big towel", 3], ["cart", "", 1]]);
    expect((await call("/me/bag", "GET", bo)).data.accessories).toEqual([]);
    // The cron's orphan sweep is for deleted bag discs only.
    await runLostFoundTick(env);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM bag_photos WHERE owner = 'm_ada'").get()).toEqual({ n: 10 });
    const keys = (db.raw.prepare("SELECT photo_key FROM bag_photos WHERE disc_id = ?").all("acc-" + towel.id) as any[]).map((row) => row.photo_key);
    expect((await call("/me/bag/accessories/" + towel.id, "DELETE", ada)).status).toBe(200);
    expect(keys.some((key) => photos.objects.has(key))).toBe(false);
    expect((await call("/me/bag", "GET", ada)).data.accessories.map((row: any) => row.kind)).toEqual(["cart"]);
  });

  it("reports a bag disc lost with only the photos its owner picks, and the bag shows the post", async () => {
    const ada = await token("m_ada");
    const disc = bagDiscRow("m_ada", { brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange", ink: "Ada L 252-555-0101" });
    const one = (await call("/me/bag/photos", "POST", ada, { discId: disc, image: PHOTO })).data.photo.id;
    await call("/me/bag/photos", "POST", ada, { discId: disc, image: PHOTO });
    const post = await createPost(ada, lostBody({ privateInk: "Ada L 252-555-0101", bagDiscId: disc, bagPhotoIds: [one] }));
    expect(post.photos).toHaveLength(1);
    expect(db.raw.prepare("SELECT bag_disc_id FROM lf_posts WHERE id = ?").get(post.id)).toEqual({ bag_disc_id: disc });
    // The post has its own copy; the bag keeps its private original.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM bag_photos WHERE disc_id = ?").get(disc)).toEqual({ n: 2 });
    expect((await call("/me/bag", "GET", ada)).data.lost).toEqual([{ discId: disc, postId: post.id, status: "open", title: "Innova Star Destroyer" }]);
    // Someone else's bag disc or photo, or a found post, can't be used.
    expect((await call("/lost-found/posts", "POST", await token("m_bo"), lostBody({ bagDiscId: disc }))).data.field).toBe("bagDiscId");
    expect((await call("/lost-found/posts", "POST", ada, foundBody({ bagDiscId: disc }))).data.field).toBe("bagDiscId");
    expect((await call("/lost-found/posts", "POST", ada, lostBody({ bagDiscId: disc, bagPhotoIds: [999] }))).data.error).toBe("invalid_photo");
  });

  it("tells a member about a found disc that matches their bag only on strong evidence, and nobody else learns why", async () => {
    // Ada wrote her phone number on hers; Cy has a photo of his; the admin's only shares the mold and colour.
    const adaDisc = bagDiscRow("m_ada", { brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange", ink: "Ada L 252-555-0101" });
    const cyDisc = bagDiscRow("m_cy", { brand: "Innova", model: "destroyer ", plastic: "Star", color: "Orange" });
    await call("/me/bag/photos", "POST", await token("m_cy"), { discId: cyDisc, image: PHOTO });
    bagDiscRow("m_admin", { brand: "Innova", model: "Destroyer", color: "Orange" });
    bagDiscRow("m_ada", { brand: "Discraft", model: "Buzzz", color: "Orange", ink: "Ada L 252-555-0101" });
    geminiReplies.push(inkReply([{ text: "252-555-0101", type: "phone" }]));
    const bo = await token("m_bo");
    const found = await createPost(bo, foundBody({ brand: "Innova", mold: "Destroyer", plastic: "Star" }));
    const matches = db.raw.prepare("SELECT candidate_id, lost_id, bag_disc_id, status, reasons FROM lf_matches WHERE found_id = ? ORDER BY candidate_id").all(found.id) as any[];
    expect(matches.map((row) => [row.candidate_id, row.bag_disc_id, row.status])).toEqual([["m_ada", adaDisc, "notified"], ["m_cy", cyDisc, "notified"]]);
    expect(JSON.parse(matches[0].reasons)).toEqual(expect.arrayContaining(["ink_phone", "bag"]));
    expect(JSON.parse(matches[1].reasons)).toEqual(expect.arrayContaining(["photo_same", "bag"]));
    const toAda = db.raw.prepare("SELECT title, body FROM member_notices WHERE member_id = 'm_ada'").get() as any;
    expect(toAda).toMatchObject({ title: "Is this your disc?" });
    expect(toAda.body).toContain("looks like the Orange Innova Star Destroyer in your bag");
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM member_notices WHERE member_id = 'm_admin'").get()).toEqual({ n: 0 });
    // The owner's match view names their bag disc; the finder can't open it; no payload carries the bag ink.
    const adaMatch = await call("/lost-found/matches/" + (db.raw.prepare("SELECT id FROM lf_matches WHERE candidate_id = 'm_ada'").get() as any).id, "GET", await token("m_ada"));
    expect(adaMatch.data.match).toMatchObject({ bagDisc: "Orange Innova Star Destroyer", strength: "strong", canDecide: true });
    expect(adaMatch.data.match.reasons).toContain("The phone number on the disc matches");
    expect((await call("/lost-found/matches/" + (db.raw.prepare("SELECT id FROM lf_matches WHERE candidate_id = 'm_ada'").get() as any).id, "GET", bo)).status).toBe(404);
    for (const res of [await call("/lost-found/posts/" + found.id, "GET", bo), await call("/lost-found/posts?kind=found"), await call("/lost-found/me", "GET", bo)]) {
      expect(scrubKeys(res.raw)).not.toMatch(/Ada L|0101|bag_disc|bagDisc|in your bag/i);
    }
    const toFinder = db.raw.prepare("SELECT body FROM member_notices WHERE member_id = 'm_bo'").all() as any[];
    expect(JSON.stringify(toFinder)).not.toMatch(/Ada|bag/i);
  });

  it("leaves bags alone when the owner turned matching off, the disc is archived, or the photo isn't the same disc", async () => {
    const ada = await token("m_ada");
    bagDiscRow("m_ada", { brand: "Innova", model: "Destroyer", color: "Orange", ink: "Ada L 252-555-0101" });
    await call("/me/bag/settings", "PUT", ada, { matchFound: false });
    bagDiscRow("m_cy", { brand: "Innova", model: "Destroyer", color: "Orange", ink: "Cy 252-555-0102", archived: true, inBag: false });
    const withPhoto = bagDiscRow("m_admin", { brand: "Innova", model: "Destroyer", color: "Orange" });
    await call("/me/bag/photos", "POST", await token("m_admin"), { discId: withPhoto, image: PHOTO });
    compareReply = '{"same":"no"}';
    geminiReplies.push(inkReply([{ text: "252-555-0101", type: "phone" }, { text: "252-555-0102", type: "phone" }]));
    const found = await createPost(await token("m_bo"), foundBody({ brand: "Innova", mold: "Destroyer" }));
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM lf_matches WHERE found_id = ? AND bag_disc_id IS NOT NULL").get(found.id)).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM member_notices WHERE member_id IN ('m_ada', 'm_cy', 'm_admin')").get()).toEqual({ n: 0 });
  });
});

describe("marketplace listings checked against lost posts", () => {
  // These checks make several AI calls in a row; the free-tier pacing (4 a minute) is covered elsewhere.
  beforeEach(() => { env = makeEnv({ LF_VISION_PER_MINUTE: "100" }); });
  function listingBody(overrides: Record<string, unknown> = {}) {
    return { brand: "Innova", mold: "Destroyer", plastic: "Star", discType: "driver", weightG: 175, color: "Orange", condition: 8, priceCents: 1800,
      quantity: 1, photos: [PHOTO], ...overrides };
  }
  async function sellerToken(id: string) {
    db.raw.prepare("INSERT OR REPLACE INTO market_seller_settings (member_id, notify_email) VALUES (?, ?)").run(id, id + "@example.test");
    return token(id);
  }
  async function list(bearer: string, body: Record<string, unknown>) {
    const res = await call("/market/listings", "POST", bearer, body);
    expect(res.status, res.raw).toBe(201);
    return res.data.listing;
  }
  const notices = (id: string) => db.raw.prepare("SELECT title, body FROM member_notices WHERE member_id = ? ORDER BY id").all(id) as any[];

  it("alerts the seller (and the admins' review list) when the listing photo carries the lost owner's writing", async () => {
    const lost = await createPost(await token("m_ada"), lostBody({ privateInk: "Ada L 252-555-0101" }));
    const before = geminiCalls;
    geminiReplies.push(inkReply([{ text: "252-555-0101", type: "phone" }]));
    const bo = await sellerToken("m_bo");
    const listing = await list(bo, listingBody());
    expect(geminiCalls - before).toBe(1);
    expect(db.raw.prepare("SELECT verdict, reasons FROM market_lost_checks WHERE listing_id = ? AND lost_id = ?").get(listing.id, lost.id))
      .toMatchObject({ verdict: "strong" });
    const toSeller = notices("m_bo").find((row) => row.title === "A disc you listed may be someone's lost disc");
    expect(toSeller?.body).toContain("Your Innova Star Destroyer listing looks a lot like an Innova Star Destroyer someone reported lost at Elm Street Park");
    expect(JSON.stringify(notices("m_bo"))).not.toMatch(/Ada|0101/);
    expect(notices("m_ada").some((row) => /listed|sale/i.test(row.title + row.body))).toBe(false);
    // Admins see it for review (and on the badge); the lost owner's private text never shows.
    const admin = await token("m_admin");
    const overview = await call("/admin/market/overview", "GET", admin);
    expect(overview.data.lostMatches).toEqual([expect.objectContaining({
      listing: expect.objectContaining({ id: listing.id }), lost: expect.objectContaining({ id: lost.id, href: "lost-found.html#post/" + lost.id }),
      reasons: expect.arrayContaining(["The phone number on the disc matches"]),
    })]);
    expect(overview.raw).not.toMatch(/Ada L|0101/);
    expect((await call("/admin/market/summary", "GET", admin)).data.openReports).toBe(1);
    expect((await call(`/admin/market/lost-matches/${listing.id}/${lost.id}/review`, "POST", admin, { reason: "Asked the seller" })).status).toBe(200);
    expect((await call("/admin/market/overview", "GET", admin)).data.lostMatches).toEqual([]);
    expect((await call("/admin/market/summary", "GET", admin)).data.openReports).toBe(0);
    expect((await call(`/admin/market/lost-matches/${listing.id}/${lost.id}/review`, "POST", admin, { reason: "again" })).status).toBe(409);
    expect((await call(`/admin/market/lost-matches/${listing.id}/${lost.id}/review`, "POST", bo, { reason: "me" })).status).toBe(403);
    // Editing the listing doesn't alert twice.
    await call("/market/listings/" + listing.id, "PATCH", bo, { priceCents: 1500 });
    expect(notices("m_bo").filter((row) => row.title === "A disc you listed may be someone's lost disc")).toHaveLength(1);
  });

  it("matches photos when the lost post has one, and stays quiet on details alone", async () => {
    // A lost post with a photo but no writing: the AI compares the two photos.
    const lost = await createPost(await token("m_ada"), lostBody({ privateInk: "", photos: [PHOTO] }));
    const cy = await sellerToken("m_cy");
    const same = await list(cy, listingBody());
    expect(db.raw.prepare("SELECT verdict, reasons FROM market_lost_checks WHERE listing_id = ?").get(same.id)).toMatchObject({ verdict: "strong" });
    compareReply = '{"same":"no"}';
    const other = await list(cy, listingBody({ color: "Orange" }));
    expect(db.raw.prepare("SELECT verdict FROM market_lost_checks WHERE listing_id = ?").get(other.id)).toEqual({ verdict: "weak" });
    expect(notices("m_cy").filter((row) => row.title.startsWith("A disc you listed"))).toHaveLength(1);
    // Different colour or mold: decided without the AI. The seller's own lost post never counts.
    const before = geminiCalls;
    const blue = await list(cy, listingBody({ color: "Blue" }));
    expect(db.raw.prepare("SELECT verdict FROM market_lost_checks WHERE listing_id = ?").get(blue.id)).toEqual({ verdict: "weak" });
    await list(cy, listingBody({ mold: "Firebird" }));
    const mine = await list(await sellerToken("m_ada"), listingBody());
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM market_lost_checks WHERE listing_id = ?").get(mine.id)).toEqual({ n: 0 });
    expect(geminiCalls).toBe(before);
    expect(lost.id).toBeGreaterThan(0);
  });

  it("checks a new lost post against discs already for sale, alerting only their sellers", async () => {
    // Nothing lost of that mold yet: the listing is not read (no AI spent).
    const before = geminiCalls;
    const listing = await list(await sellerToken("m_bo"), listingBody({ color: "Orange" }));
    expect(geminiCalls).toBe(before);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM market_lost_checks").get()).toEqual({ n: 0 });
    // A matching lost post arrives: the listing photo is read once, and its seller hears.
    geminiReplies.push(inkReply([{ text: "Wendy Smith", type: "name" }]));
    const lost = await createPost(await token("m_ada"), lostBody({ privateInk: "Wendy Smith" }));
    expect(geminiCalls - before).toBe(1);
    expect(db.raw.prepare("SELECT verdict FROM market_lost_checks WHERE listing_id = ? AND lost_id = ?").get(listing.id, lost.id)).toEqual({ verdict: "strong" });
    expect(notices("m_bo").some((row) => row.title === "A disc you listed may be someone's lost disc")).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM market_listing_reads").get()).toEqual({ n: 1 });
  });
});

describe("Sell this: marketplace listings from My Bag (discs, the bag, accessories)", () => {
  function bagDiscRow(owner: string, record: Record<string, unknown>) {
    const id = crypto.randomUUID();
    db.raw.prepare(`INSERT INTO member_practice_records (owner, id, kind, revision, occurred_on, payload, last_op, updated_at)
      VALUES (?, ?, 'disc', 1, '2026-11-01', ?, 'op-' || ?, ?)`)
      .run(owner, id, JSON.stringify({ brand: "", model: "", plastic: "", weightGrams: null, notes: "", inBag: true, archived: false, ...record }), id, Date.now());
    return id;
  }
  async function sellerToken(id: string) {
    db.raw.prepare("INSERT OR REPLACE INTO market_seller_settings (member_id, notify_email) VALUES (?, ?)").run(id, id + "@example.test");
    return token(id);
  }
  const sell = (bearer: string, body: Record<string, unknown>) => call("/market/listings", "POST", bearer, {
    condition: 8, priceCents: 2500, quantity: 1, ...body,
  });
  async function bagPhoto(bearer: string, target: Record<string, unknown>) {
    const res = await call("/me/bag/photos", "POST", bearer, { ...target, image: PHOTO });
    expect(res.status, res.raw).toBe(201);
    return res.data.photo.id as number;
  }
  const listingKeys = (id: number) => (db.raw.prepare("SELECT r2_key FROM market_listing_photos WHERE listing_id = ? ORDER BY sort_order").all(id) as any[]).map((row) => row.r2_key);

  it("lists a bag disc with its bag photos (copied; the bag keeps its private originals) and shows it for sale in My Bag", async () => {
    const ada = await sellerToken("m_ada");
    const disc = bagDiscRow("m_ada", { brand: "Innova", model: "Destroyer", plastic: "Star", color: "Orange", weightGrams: 175 });
    const other = bagDiscRow("m_ada", { model: "Buzzz" });
    const ids = [await bagPhoto(ada, { discId: disc }), await bagPhoto(ada, { discId: disc })];
    const otherPhoto = await bagPhoto(ada, { discId: other });
    const body = { itemKind: "disc", brand: "Innova", mold: "Destroyer", plastic: "Star", discType: "driver", weightG: 175, color: "Orange", bagRef: "disc:" + disc };
    // Photos must be the seller's own photos of this disc, one to four in all.
    expect((await sell(ada, { ...body, bagPhotoIds: [] })).data.error).toBe("invalid_photo");
    expect((await sell(ada, { ...body, bagPhotoIds: [otherPhoto] })).data.error).toBe("invalid_photo");
    expect((await sell(ada, { ...body, bagPhotoIds: [ids[0], ids[0]] })).data.error).toBe("invalid_photo");
    expect((await sell(ada, { ...body, bagPhotoIds: ids, photos: [PHOTO, PHOTO, PHOTO] })).data.error).toBe("invalid_photo");
    const bo = await sellerToken("m_bo");
    expect((await sell(bo, { ...body, bagPhotoIds: ids })).data).toMatchObject({ error: "invalid_listing", field: "bagRef" });
    expect((await sell(bo, { ...body, bagRef: "disc:" + bagDiscRow("m_bo", { model: "Wraith" }), bagPhotoIds: ids })).data.error).toBe("invalid_photo");
    expect((await sell(ada, { ...body, itemKind: "bag", bagPhotoIds: ids })).data).toMatchObject({ error: "invalid_listing" });
    expect((await sell(ada, { ...body, bagRef: "disc:not-a-uuid", bagPhotoIds: ids })).data).toMatchObject({ field: "bagRef" });

    const created = await sell(ada, { ...body, bagPhotoIds: ids, photos: [PHOTO] });
    expect(created.status, created.raw).toBe(201);
    const listing = created.data.listing;
    expect(listing).toMatchObject({ itemKind: "disc", gearType: "", title: "Innova Star Destroyer", discType: "driver", weightG: 175 });
    expect(listing.photos).toHaveLength(3);
    expect(JSON.stringify(listing)).not.toContain(disc);
    const keys = listingKeys(listing.id);
    expect(keys.every((key) => key.startsWith("market/"))).toBe(true);
    for (const id of ids) {
      const original = (db.raw.prepare("SELECT photo_key FROM bag_photos WHERE id = ?").get(id) as any).photo_key;
      expect(photos.objects.has(original)).toBe(true);
      expect(keys).not.toContain(original);
    }
    expect((await call("/market/photos/" + listing.photos[0].id)).status).toBe(200);
    expect((await call("/me/bag", "GET", ada)).data.listings).toEqual([{ ref: "disc:" + disc, listingId: listing.id, status: "active" }]);
    expect((await call("/me/bag", "GET", bo)).data.listings).toEqual([]);
    // Taken down: no longer "for sale" in My Bag.
    expect((await call("/market/listings/" + listing.id + "/withdraw", "POST", ada)).status).toBe(200);
    expect((await call("/me/bag", "GET", ada)).data.listings).toEqual([]);
  });

  it("sells the bag and accessories without disc details, never checks them against lost discs, and filters by kind", async () => {
    const ada = await sellerToken("m_ada");
    await createPost(await token("m_cy"), lostBody({ mold: "AX5" }));
    const aiBefore = geminiCalls;
    const whole = await bagPhoto(ada, { bag: true });
    const bag = await sell(ada, {
      itemKind: "bag", brand: "Grip", mold: "AX5", color: "Black", bagRef: "bag", bagPhotoIds: [whole],
      // Disc-only details are dropped for a bag, whatever the form sent.
      plastic: "Star", discType: "driver", weightG: 175, speed: 12,
    });
    expect(bag.status, bag.raw).toBe(201);
    expect(bag.data.listing).toMatchObject({ itemKind: "bag", title: "Grip AX5", discType: "", plastic: "", weightG: null, flight: null });

    const cart = (await call("/me/bag/accessories", "POST", ada, { kind: "cart", name: "Zuca cart" })).data.accessory;
    const cartPhoto = await bagPhoto(ada, { accessoryId: cart.id });
    const accessoryBody = { itemKind: "accessory", mold: "Zuca cart", bagRef: "accessory:" + cart.id, bagPhotoIds: [cartPhoto] };
    expect((await sell(ada, accessoryBody)).data).toMatchObject({ error: "invalid_listing", field: "gearType" });
    expect((await sell(ada, { ...accessoryBody, gearType: "jetpack" })).data).toMatchObject({ field: "gearType" });
    expect((await sell(ada, { ...accessoryBody, gearType: "cart", mold: "" })).data).toMatchObject({ field: "mold" });
    const bo = await sellerToken("m_bo");
    expect((await sell(bo, { ...accessoryBody, gearType: "cart" })).data).toMatchObject({ field: "bagRef" });
    expect((await sell(ada, { ...accessoryBody, gearType: "cart", bagPhotoIds: [whole] })).data.error).toBe("invalid_photo");
    const accessory = await sell(ada, { ...accessoryBody, gearType: "cart" });
    expect(accessory.status, accessory.raw).toBe(201);
    expect(accessory.data.listing).toMatchObject({ itemKind: "accessory", gearType: "cart", title: "Zuca cart" });
    // A disc listing still needs its disc type.
    expect((await sell(bo, { mold: "Destroyer", photos: [PHOTO] })).data).toMatchObject({ field: "discType" });
    const disc = await sell(bo, { mold: "AX5", discType: "putter", photos: [PHOTO] });
    expect(disc.status).toBe(201);

    // Neither the bag nor the cart was read by the AI or checked against the lost AX5 (a disc listing of that name was).
    expect(db.raw.prepare("SELECT listing_id FROM market_lost_checks ORDER BY listing_id").all().map((row: any) => row.listing_id)).toEqual([disc.data.listing.id]);
    expect(geminiCalls - aiBefore).toBeGreaterThan(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM market_listing_reads WHERE listing_id IN (?, ?)").get(bag.data.listing.id, accessory.data.listing.id)).toEqual({ n: 0 });

    const titles = async (query: string) => (await call("/market/listings" + query)).data.listings.map((row: any) => row.title);
    expect(await titles("?kind=bag")).toEqual(["Grip AX5"]);
    expect(await titles("?kind=accessory")).toEqual(["Zuca cart"]);
    expect(await titles("?kind=disc")).toEqual(["AX5"]);
    expect((await titles("?kind=hat")).length).toBe(3);

    // Editing keeps what it sells; an accessory can change what kind of accessory it is.
    const edited = await call("/market/listings/" + accessory.data.listing.id, "PATCH", ada, { itemKind: "disc", discType: "driver", gearType: "seat", mold: "Cart seat" });
    expect(edited.status, edited.raw).toBe(200);
    expect(edited.data.listing).toMatchObject({ itemKind: "accessory", gearType: "seat", title: "Cart seat", discType: "" });
    expect((await call("/me/bag", "GET", ada)).data.listings.map((row: any) => row.ref).sort()).toEqual(["accessory:" + cart.id, "bag"]);
  });
});

describe("editing your own lost & found post", () => {
  it("lets the poster edit an open post (never its kind), keeps an old date, and matches again on the new details", async () => {
    const finder = await token("m_bo");
    // The found disc has a guest's name and number on it; nobody on the roster has that name, so only her lost post can match.
    geminiReplies = [inkReply([{ text: "WENDY SMITH", type: "name" }, { text: "252 555 0199", type: "phone" }])];
    const found = await createPost(finder, foundBody({ brand: "Discraft", mold: "Buzzz", color: "Blue" }));
    const ada = (await guestToken()).token;
    const lost = await createPost(ada, lostBody({ brand: "Innova", mold: "Wraith", color: "Red", privateInk: "", rewardNote: "" }));
    const matchFor = () => db.raw.prepare("SELECT status FROM lf_matches WHERE found_id = ? AND lost_id = ?").get(found.id, lost.id) as any;
    const before = matchFor();

    const edit = (bearer: string, id: number, body: Record<string, unknown>) => call("/lost-found/posts/" + id, "PATCH", bearer, body);
    expect((await edit(finder, lost.id, { area: "mine now" })).status).toBe(404);
    expect((await edit(ada, lost.id, { courseId: 424242 })).data).toMatchObject({ error: "invalid_post", field: "courseId" });
    expect((await edit(ada, lost.id, { eventDate: "2001-01-01" })).data).toMatchObject({ field: "eventDate" });
    expect((await edit(ada, lost.id, { brand: "", mold: "", color: "" })).data).toMatchObject({ field: "mold" });
    const saved = await edit(ada, lost.id, {
      kind: "found", brand: "Discraft", mold: "Buzzz", color: "Blue", courseId: 9002, area: "Hole 3 creek", hole: 3, weightG: 177,
      rewardNote: "Pizza", privateInk: "Wendy Smith 252-555-0199",
    });
    expect(saved.status, saved.raw).toBe(200);
    expect(saved.data.post).toMatchObject({ kind: "lost", title: "Discraft Star Buzzz", course: { id: 9002, name: "Green Mill Run" }, area: "Hole 3 creek", hole: 3, weightG: 177,
      rewardNote: "Pizza", privateInk: "Wendy Smith 252-555-0199" });
    expect((await getPost(lost.id)).privateInk).toBeUndefined();
    expect(db.raw.prepare("SELECT action FROM lf_claim_log WHERE post_id = ? ORDER BY id DESC LIMIT 1").get(lost.id)).toEqual({ action: "edit" });
    // The new details match the found Buzzz with her name and number on it.
    expect(before?.status ?? "none").not.toBe("notified");
    expect(matchFor()?.status).toBe("notified");

    // A date older than a new post may give is kept when it isn't changed.
    db.raw.prepare("UPDATE lf_posts SET event_date = '2025-01-02' WHERE id = ?").run(lost.id);
    const kept = await edit(ada, lost.id, { area: "Hole 4", eventDate: "2025-01-02" });
    expect(kept.status, kept.raw).toBe(200);
    expect(kept.data.post).toMatchObject({ area: "Hole 4", date: "2025-01-02" });

    // Found posts: where it's held can change; a closed post can't be edited.
    expect((await edit(finder, found.id, { holding: "club_bin", binNote: "" })).data).toMatchObject({ field: "binNote" });
    expect((await edit(finder, found.id, { holding: "club_bin", binNote: "Club bin at the shelter" })).data.post).toMatchObject({ holding: "club_bin", kind: "found" });
    expect((await call(`/lost-found/posts/${lost.id}/close`, "POST", ada)).status).toBe(200);
    expect((await edit(ada, lost.id, { area: "Hole 5" })).status).toBe(409);
  });

  it("lets the poster add photos to an open post, up to its limit", async () => {
    const ada = await token("m_ada");
    const lost = await createPost(ada, lostBody());
    const add = (bearer: string) => call(`/lost-found/posts/${lost.id}/photos`, "POST", bearer, { image: PHOTO });
    expect((await add(await token("m_bo"))).status).toBe(404);
    expect((await call(`/lost-found/posts/${lost.id}/photos`, "POST", ada, { image: "data:image/png;base64,AAAA" })).data.error).toBe("invalid_photo");
    const first = await add(ada);
    expect(first.status, first.raw).toBe(200);
    expect(first.data.post.myPhotos).toHaveLength(1);
    expect((await add(ada)).data.post.myPhotos).toHaveLength(2);
    expect((await add(ada)).data.error).toBe("too_many_photos");
    // Taking one down makes room again.
    const [photoId] = photoIdsOf(lost.id);
    expect((await call(`/lost-found/posts/${lost.id}/photos/${photoId}/remove`, "POST", ada)).status).toBe(200);
    expect((await add(ada)).status).toBe(200);
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

  it("publishes karma for every name in the app, keyed anonymously (returns + confirmed club donations)", async () => {
    const { bo } = await confirmedReturn();
    expect(bo).toBeTruthy();
    // A confirmed club donation adds its whole dollars to the same total.
    db.raw.exec(`INSERT INTO market_listings (id, seller_id, mold, disc_type, condition, price_cents) VALUES (900, 'm_bo', 'Buzzz', 'midrange', 8, 2000)`);
    db.raw.exec(`INSERT INTO market_deals (id, listing_id, seller_id, buyer_id, kind, price_cents, listing_title, status, outcome) VALUES (900, 900, 'm_bo', 'm_ada', 'buy', 2000, 'Buzzz', 'completed', 'sold')`);
    db.raw.exec(`INSERT INTO market_donations (deal_id, seller_id, amount_cents, status, karma) VALUES (900, 'm_bo', 500, 'confirmed', 5)`);
    const res = await call("/karma");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const boKey = (db.raw.prepare("SELECT trader_key FROM market_traders WHERE owner_id = 'm_bo'").get() as any).trader_key;
    expect(res.data).toEqual({ players: { [handicapKey("m_bo")]: 15 }, traders: { [boKey]: 15 } });
    expect(res.raw).not.toMatch(/m_bo|m_ada/);
    // The app computes the same key (tests/karma.test.mjs pins this value too).
    expect(handicapKey("m_80024")).toBe("9f54821bf08584f9");
  });

  it("lets the finder (and the owner) celebrate a confirmed return on the wall, Home and the homepage strip", async () => {
    const { ada, bo, claim } = await confirmedReturn();
    const cy = await token("m_cy");
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", cy, { caption: "x", photos: [PHOTO] })).status).toBe(404);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "x", photos: [] })).status).toBe(400);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "x", photos: [PHOTO, PHOTO, PHOTO] })).status).toBe(400);
    geminiReplies = [inkReply([{ text: "ADA 555-0134", type: "phone" }])];
    const made = await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "Back where it belongs!", photos: [PHOTO] });
    expect(made.status, made.raw).toBe(201);
    // Public at once, like a post's photo; the private read (after the response) nudges the author only.
    const celebrationPhoto = made.data.celebration.photos[0].id as number;
    expect(made.data.myPhotos).toEqual([{ id: celebrationPhoto, url: "/lost-found/photos/" + celebrationPhoto, nudge: false }]);
    expect((await call("/lost-found/me", "GET", bo)).data.nudges).toEqual([expect.objectContaining({ id: celebrationPhoto, celebrationId: made.data.celebration.id })]);
    expect((await call("/lost-found/me", "GET", ada)).data.nudges).toEqual([]);
    expect((await call(`/lost-found/photos/${celebrationPhoto}/keep`, "POST", ada)).status).toBe(404);
    expect((await call(`/lost-found/photos/${celebrationPhoto}/keep`, "POST", bo)).status).toBe(200);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", bo, { caption: "again", photos: [PHOTO] })).status).toBe(409);
    expect((await call(`/lost-found/claims/${claim.id}/celebrations`, "POST", ada, { caption: "Thank you Bo!", photos: [PHOTO] })).status).toBe(201);
    const wall = await call("/lost-found/returned");
    expect(wall.data.celebrations.map((row: any) => row.caption)).toEqual(["Thank you Bo!", "Back where it belongs!"]);
    expect(wall.data.celebrations[1]).toMatchObject({ role: "finder", disc: "Discraft ESP Buzzz", finder: { name: "Bo Burnham", karma: 10, returned: 1 } });
    expect(wall.data.celebrations[1].photos).toHaveLength(1);
    expect(wall.data.topFinders).toEqual([expect.objectContaining({ name: "Bo Burnham", karma: 10, returned: 1 })]);
    expect(scrubKeys(wall.raw)).not.toMatch(/555|0134/);
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
    expect(overview.data.reports[0]).toMatchObject({ kind: "celebration", reason: "privacy", target: { text: "Back where it belongs!", photos: [{ id: celebrationPhoto }] } });
    expect(overview.data.photos).toBeUndefined();
    // An admin can take a photo down (with a reason); it leaves R2 and 404s.
    expect((await call(`/admin/lost-found/photos/${celebrationPhoto}/remove`, "POST", cy, { reason: "nope" })).status).toBe(403);
    expect((await call(`/admin/lost-found/photos/${celebrationPhoto}/remove`, "POST", admin, {})).status).toBe(400);
    expect((await call(`/admin/lost-found/photos/${celebrationPhoto}/remove`, "POST", admin, { reason: "Shows a phone number" })).status).toBe(200);
    expect((await call(`/admin/lost-found/photos/${celebrationPhoto}/remove`, "POST", admin, { reason: "again" })).status).toBe(409);
    expect((await call(photoUrl)).status).toBe(404);
    expect((await call("/lost-found/returned")).data.celebrations.find((row: any) => row.id === celebrationId).photos).toEqual([]);
    expect((await call(`/admin/lost-found/celebrations/${celebrationId}/hide`, "POST", cy, { reason: "nope" })).status).toBe(403);
    expect((await call(`/admin/lost-found/celebrations/${celebrationId}/hide`, "POST", admin, { reason: "Face without consent" })).status).toBe(200);
    expect((await call("/lost-found/returned")).data.celebrations.map((row: any) => row.id)).not.toContain(celebrationId);
    // The other celebration (and its photo) is untouched.
    const adaPhoto = (await call("/lost-found/returned")).data.celebrations[0].photos[0].url;
    expect((await call(adaPhoto)).status).toBe(200);
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
    // Owner close: someone else can't (404), the owner can, and its photos leave R2.
    expect((await call(`/lost-found/posts/${first.id}/close`, "POST", await token("m_cy"))).status).toBe(404);
    expect((await call(`/lost-found/posts/${first.id}/close`, "POST", bo)).status).toBe(200);
    expect([...photos.objects.keys()]).toEqual([]);
    expect(db.raw.prepare("SELECT action FROM lf_mod_log ORDER BY id").all().map((row: any) => row.action)).toEqual(["hide", "unhide", "merge"]);
    expect(db.raw.prepare("SELECT DISTINCT status FROM lf_photos").all()).toEqual([{ status: "removed" }]);
  });

  it("keeps the picked weight and hole, shows them on the card and counts them in matching", async () => {
    const lost = await createPost(await token("m_ada"), lostBody({ weightG: 175, hole: 7, area: "Hole 7 · pond" }));
    const found = await createPost(await token("m_bo"), foundBody({ weightG: "174", hole: "7" }));
    expect(found).toMatchObject({ weightG: 174, hole: 7 });
    expect(await getPost(lost.id)).toMatchObject({ weightG: 175, hole: 7, area: "Hole 7 · pond" });
    const match = db.raw.prepare("SELECT reasons FROM lf_matches WHERE found_id = ? AND lost_id = ?").get(found.id, lost.id) as any;
    expect(JSON.parse(match.reasons)).toEqual(expect.arrayContaining(["weight", "hole"]));
    // An older post without them still reads fine.
    const plain = await createPost(await token("m_cy"), foundBody());
    expect(plain).toMatchObject({ weightG: null, hole: null });
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
    expect(db.raw.prepare("SELECT photo_key, status FROM lf_photos WHERE post_id = ?").get(post.id)).toEqual({ photo_key: null, status: "removed" });
  });
});

describe("round karma: +1 for every round finished in the app, and the gaming watch", () => {
  let roundId = 0;
  /** A finalized casual round; each player is [memberId or guest id, place (null = didn't finish)]. */
  function casualRound(finalizedAt: string, players: Array<[string, number | null]>) {
    roundId += 1;
    db.raw.prepare("INSERT INTO casual_rounds (id, round_code, course_name, layout_name, created_by, finalized_at) VALUES (?, ?, 'Pinebrook', 'Main', ?, ?)")
      .run(9000 + roundId, "KR" + roundId, players[0]?.[0] ?? null, finalizedAt);
    for (const [id, place] of players) {
      db.raw.prepare("INSERT INTO casual_results (casual_round_id, member_id, name, place, total) VALUES (?, ?, ?, ?, 54)").run(9000 + roundId, id, id, place);
    }
  }
  const karmaFor = async (memberId: string) => (await call("/karma")).data.players[handicapKey(memberId)] ?? 0;
  const NOW = Date.parse("2026-11-15T16:00:00Z");

  beforeEach(() => { adminPushes.length = 0; roundId = 0; });

  it("counts casual, live-scored event and offline rounds a member finished, never imported results, guests or unfinished cards", async () => {
    casualRound("2026-11-10 14:00:00", [["m_bo", 1], ["m_ada", 2], ["g_walkon", 3], ["m_cy", null]]);
    db.raw.exec(`INSERT INTO events (id, type, name, status, source) VALUES
      (50, 'league_round', 'Tuesday league', 'final', 'manual'),
      (51, 'tournament', 'UDisc import', 'final', 'udisc'),
      (52, 'league_round', 'Still going', 'live', 'manual'),
      (53, 'tournament', 'From the DGS import, scored live', 'final', 'dgs'),
      (54, 'league_round', 'Ryder Cup sheet backfill', 'final', 'ryder-import')`);
    db.raw.exec(`INSERT INTO results (event_id, member_id, name, place, total) VALUES
      (50, 'm_bo', 'Bo', 1, 50), (50, 'm_cy', 'Cy', NULL, NULL), (51, 'm_bo', 'Bo', 1, 50), (52, 'm_ada', 'Ada', 1, 50),
      (53, 'm_bo', 'Bo', 2, 52), (54, 'm_ada', 'Ada', 1, 50)`);
    db.raw.exec(`INSERT INTO offline_rounds (local_id, owner_id, owner_kind, payload_hash, course_name, layout_name, finished_at, snapshot) VALUES
      ('off-1', 'm_ada', 'member', 'h1', 'Pinebrook', 'Main', '2026-11-11T15:00:00Z', '{}'),
      ('off-2', 'open-guest', 'open', 'h2', 'Pinebrook', 'Main', '2026-11-11T15:00:00Z', '{}')`);
    const res = await call("/karma");
    expect(res.data.players).toEqual({ [handicapKey("m_bo")]: 3, [handicapKey("m_ada")]: 2 });
    expect(res.raw).not.toMatch(/m_bo|m_ada|g_walkon/);
    // The same total everywhere a member's karma shows (Lost & Found, the marketplace).
    expect((await call("/lost-found/me", "GET", await token("m_bo"))).data.karma).toMatchObject({ karma: 3 });
  });

  it("reads the day in club time", () => {
    expect(clubDayOf("2026-11-15 03:30:00")).toBe("2026-11-14");
    expect(clubDayOf("2026-11-15T16:00:00Z")).toBe("2026-11-15");
    expect(clubDayOf("")).toBe("");
  });

  it("alerts the admins once when a member finishes more than 3 rounds in a day; an admin removes it and gives 3x as a penalty", async () => {
    for (const at of ["2026-11-14 13:00:00", "2026-11-14 15:00:00", "2026-11-14 18:00:00"]) casualRound(at, [["m_bo", 1], ["m_ada", 2]]);
    // 10:30 pm in Greenville is the next day in UTC: still Bo's 14th.
    casualRound("2026-11-15 03:30:00", [["m_bo", 1]]);
    expect(await karmaFor("m_bo")).toBe(4);

    expect(await runKarmaWatch(env, NOW)).toMatchObject({ flagged: 1 });
    expect(adminPushes).toEqual([expect.objectContaining({
      title: "Unusual karma", url: "/admin.html#lost-found",
      body: "Bo Burnham finished 4 rounds on Sat, Nov 14 (more than 3 a day). Please review it.",
    })]);
    // Ada (3 rounds) isn't flagged, and the next sweep doesn't alert again.
    expect(await runKarmaWatch(env, NOW)).toMatchObject({ flagged: 0 });
    expect(adminPushes).toHaveLength(1);
    // A late-synced 5th round keeps the flag's count current, still without a second alert.
    casualRound("2026-11-14 20:00:00", [["m_bo", 1]]);
    await runKarmaWatch(env, NOW);
    expect(adminPushes).toHaveLength(1);

    const admin = await token("m_admin");
    expect((await call("/admin/lost-found/summary", "GET", admin)).data).toEqual({ openReports: 0, karmaFlags: 1 });
    const overview = await call("/admin/lost-found/overview", "GET", admin);
    expect(overview.data.karmaFlags).toEqual([expect.objectContaining({ name: "Bo Burnham", day: "2026-11-14", dayLabel: "Sat, Nov 14", rounds: 5, removes: 5, penalty: 15 })]);
    expect(overview.raw).not.toMatch(/m_bo/);
    const flagId = overview.data.karmaFlags[0].id;

    expect((await call(`/admin/lost-found/karma-flags/${flagId}/penalize`, "POST", await token("m_ada"), { reason: "x" })).status).toBe(403);
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/penalize`, "POST", admin, {})).status).toBe(400);
    const done = await call(`/admin/lost-found/karma-flags/${flagId}/penalize`, "POST", admin, { reason: "Five 1-minute rounds in one evening" });
    expect(done.status, done.raw).toBe(200);
    expect(done.data).toEqual({ ok: true, removed: 5, penalty: 15 });
    // 5 rounds earned, 5 taken back, 15 penalty: below zero, and it shows that way.
    expect(await karmaFor("m_bo")).toBe(-15);
    expect(await karmaFor("m_ada")).toBe(3);
    expect(db.raw.prepare("SELECT title, body FROM member_notices WHERE member_id = 'm_bo'").get()).toEqual({
      title: "Karma adjusted",
      body: "A club admin reviewed your 5 rounds on Sat, Nov 14 and took back their 5 karma, plus a 15 karma penalty for gaming the system. Contact a club admin if this is a mistake.",
    });
    // Decided once; the ledger can't be edited or deleted.
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/penalize`, "POST", admin, { reason: "again" })).status).toBe(409);
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/clear`, "POST", admin, { reason: "undo" })).status).toBe(409);
    expect(() => db.raw.exec("UPDATE karma_adjustments SET delta = 0")).toThrow(/append-only/);
    expect(() => db.raw.exec("DELETE FROM karma_adjustments")).toThrow(/append-only/);
    expect((await call("/admin/lost-found/summary", "GET", admin)).data.karmaFlags).toBe(0);
    // Future rounds still earn karma back.
    casualRound("2026-11-16 15:00:00", [["m_bo", 1]]);
    expect(await karmaFor("m_bo")).toBe(-14);

    // Undo: the penalty is listed for 60 days; one entry gives back everything it took, and Bo is told.
    const penalties = (await call("/admin/lost-found/overview", "GET", admin)).data.karmaPenalties;
    expect(penalties).toEqual([expect.objectContaining({ id: flagId, name: "Bo Burnham", dayLabel: "Sat, Nov 14", rounds: 5, taken: 20, admin: "Ann Admin", note: "Five 1-minute rounds in one evening" })]);
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/undo`, "POST", await token("m_ada"), { reason: "x" })).status).toBe(403);
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/undo`, "POST", admin, {})).status).toBe(400);
    const undone = await call(`/admin/lost-found/karma-flags/${flagId}/undo`, "POST", admin, { reason: "It was a putting league" });
    expect(undone.status, undone.raw).toBe(200);
    expect(undone.data).toEqual({ ok: true, restored: 20 });
    expect(await karmaFor("m_bo")).toBe(6);
    expect(db.raw.prepare("SELECT title, body FROM member_notices WHERE member_id = 'm_bo' AND title = 'Karma restored'").get()).toEqual({
      title: "Karma restored",
      body: "A club admin took another look at your rounds on Sat, Nov 14 and gave back the 20 karma that was removed. Sorry about that!",
    });
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/undo`, "POST", admin, { reason: "again" })).status).toBe(409);
    expect((await call("/admin/lost-found/overview", "GET", admin)).data.karmaPenalties).toEqual([]);
    // The day stays decided: the next sweep doesn't flag it again.
    await runKarmaWatch(env, NOW);
    expect(adminPushes).toHaveLength(1);
  });

  it("can't undo a flag that was never penalized", async () => {
    for (let i = 0; i < 4; i++) casualRound(`2026-11-15 1${i}:00:00`, [["m_ada", 1]]);
    await runKarmaWatch(env, NOW);
    const admin = await token("m_admin");
    const flagId = (await call("/admin/lost-found/overview", "GET", admin)).data.karmaFlags[0].id;
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/undo`, "POST", admin, { reason: "still open" })).status).toBe(409);
    await call(`/admin/lost-found/karma-flags/${flagId}/clear`, "POST", admin, { reason: "fine" });
    expect((await call(`/admin/lost-found/karma-flags/${flagId}/undo`, "POST", admin, { reason: "was cleared" })).status).toBe(409);
    expect(await karmaFor("m_ada")).toBe(4);
  });

  it("counts offline rounds on the day they reached the server, so back-dated uploads still trip the watch", async () => {
    for (let i = 1; i <= 4; i++) {
      db.raw.prepare(`INSERT INTO offline_rounds (local_id, owner_id, owner_kind, payload_hash, course_name, layout_name, finished_at, snapshot, created_at)
        VALUES (?, 'm_cy', 'member', ?, 'Pinebrook', 'Main', ?, '{}', ?)`).run("bulk-" + i, "h" + i, `2026-10-0${i}T15:00:00Z`, `2026-11-15T15:0${i}:00.000Z`);
    }
    expect(await karmaFor("m_cy")).toBe(4);
    expect(await runKarmaWatch(env, NOW)).toMatchObject({ flagged: 1 });
    expect(adminPushes[0]?.body).toBe("Cy Young finished 4 rounds on Sun, Nov 15 (more than 3 a day). Please review it.");
  });

  it("lets an admin clear a flag that looks fine, leaving the karma alone", async () => {
    for (let i = 0; i < 4; i++) casualRound(`2026-11-15 1${i}:00:00`, [["m_ada", 1]]);
    await runKarmaWatch(env, NOW);
    const admin = await token("m_admin");
    const flagId = (await call("/admin/lost-found/overview", "GET", admin)).data.karmaFlags[0].id;
    const cleared = await call(`/admin/lost-found/karma-flags/${flagId}/clear`, "POST", admin, { reason: "Ran a 4-round tournament day" });
    expect(cleared.data).toEqual({ ok: true, removed: 0, penalty: 0 });
    expect(await karmaFor("m_ada")).toBe(4);
    expect(db.raw.prepare("SELECT status, review_note, reviewed_by FROM karma_flags WHERE id = ?").get(flagId))
      .toEqual({ status: "cleared", review_note: "Ran a 4-round tournament day", reviewed_by: "m_admin" });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM karma_adjustments").get()).toEqual({ n: 0 });
    // Cleared stays cleared: the next sweep doesn't flag that day again.
    await runKarmaWatch(env, NOW);
    expect(adminPushes).toHaveLength(1);
  });
});
