// Shared in-memory Worker harness for the Lost & Found tests: SQLite with every migration, KV and R2 stand-ins,
// captured email, a scripted Gemini and a small JPEG-shaped test photo. Each test file builds its own harness.
import { readdirSync, readFileSync } from "node:fs";
import { vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";

export const SECRET = "x".repeat(40);
export const ORIGIN = "http://localhost:8080";

/** A small JPEG-shaped file (the Worker never decodes pixels, it only checks the magic bytes and strips metadata):
 *  JFIF header, an EXIF segment carrying a GPS position (which must never be served), a frame header, a scan.
 *  `seed` varies the scan bytes so two photos differ. */
export function testJpeg(seed = 0): Uint8Array {
  const exif = new TextEncoder().encode("Exif\0\0GPSLatitude 35.6123N GPSLongitude 77.3712W");
  const scan = Array.from({ length: 64 }, (_, i) => (i * 31 + seed * 7) % 250);
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xe1, 0, exif.length + 2, ...exif,
    0xff, 0xc0, 0, 17, 8, 0, 160, 0, 240, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, ...scan,
    0xff, 0xd9,
  ]);
}

export function dataUrl(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "data:image/jpeg;base64," + btoa(bin);
}
export const NO_INK = JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "", ink: [], unreadable_writing: false, ink_confidence: "high" });

export function inkReply(ink: Array<{ text: string; type: string }>): string {
  return JSON.stringify({ brand: "Innova", mold: "Destroyer", plastic: "Star", colors: ["orange"], stamp: "", ink, unreadable_writing: false, ink_confidence: "high" });
}

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })), list_complete: true,
    }),
  };
}

function r2() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: Uint8Array) { objects.set(key, new Uint8Array(value)); },
    async get(key: string) {
      const hit = objects.get(key);
      return hit ? { body: new Blob([hit as BlobPart]).stream(), arrayBuffer: async () => hit.slice().buffer } : null;
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
        async run() { const info = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      };
      return stmt;
    },
  };
}

const member = (memberId: string, name: string, isAdmin = false) =>
  JSON.stringify({ memberId, name, isAdmin, pinHash: "secret-pin", mustChangePin: false });

export async function createHarness() {
  const db = await sqliteDb();
  db.raw.prepare("INSERT INTO courses (id, name, lat, lng) VALUES (9001, 'Elm Street Park', 35.61, -77.37)").run();
  const photos = r2();
  const mail: Array<{ to: string; subject: string; text: string }> = [];
  /** Every outside call in order: "gemini", "email:<subject>". Tests add their own markers too. */
  const events: string[] = [];
  const gemini = { replies: [] as string[], calls: 0 };
  const env = {
    ROSTER: kv({ "member:m_bo": member("m_bo", "Bo Burnham"), "member:m_admin": member("m_admin", "Ann Admin", true) }),
    RATELIMIT: kv(), DB: db, PHOTOS: photos, JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN,
    RESEND_API_KEY: "re_test", GEMINI_API_KEY: "gk_test", EXPECTED_ORIGIN: "https://gvdgclub.com",
  } as unknown as Env & { GEMINI_API_KEY: string };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body));
      mail.push({ to: body.to[0], subject: body.subject, text: body.text });
      events.push("email:" + body.subject);
      return new Response("{}", { status: 200 });
    }
    if (target.startsWith("https://generativelanguage.googleapis.com/")) {
      gemini.calls += 1;
      events.push("gemini");
      const prompt = String(init?.body || "");
      const text = prompt.includes("SAME physical disc") ? '{"same":"unsure"}' : gemini.replies.shift() ?? NO_INK;
      return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
    }
    return new Response("not mocked", { status: 500 });
  }));

  async function call(path: string, method = "GET", bearer?: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9", ...headers };
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    const response = await worker.fetch(new Request("https://worker.example" + path, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, ctx as unknown as ExecutionContext);
    const raw = (response.headers.get("Content-Type") || "").includes("json") ? await response.text() : "";
    while (pending.length) await Promise.all(pending.splice(0));
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  }

  async function guestToken(email: string, name: string) {
    await call("/lost-found/guest/start", "POST", undefined, { name, email }, { "CF-Connecting-IP": "198.51.100." + (mail.length + 1) });
    const code = /code is (\d{6})/.exec(mail.at(-1)!.text)![1];
    return (await call("/lost-found/guest/verify", "POST", undefined, { email, code })).data.token as string;
  }

  const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
  const photo = dataUrl(testJpeg());

  return { db, env, photos, mail, events, gemini, call, guestToken, token, photo };
}

export function today(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
