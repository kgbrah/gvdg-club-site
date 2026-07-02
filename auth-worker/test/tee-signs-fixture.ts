import type { RawEnv } from "../src/env.js";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};

const kv = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async (opts?: { prefix?: string }) => ({
      keys: Array.from(m.keys()).filter((name) => !opts?.prefix || name.startsWith(opts.prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
};

export type TestR2Bucket = R2Bucket & { readonly _store: Map<string, Uint8Array> };

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function r2Object(key: string, bytes: Uint8Array): R2ObjectBody {
  const data = new Uint8Array(copiedArrayBuffer(bytes));
  return {
    key,
    version: "test",
    size: data.byteLength,
    etag: "test",
    httpEtag: "test",
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(0),
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: {},
    storageClass: "Standard",
    body: new ReadableStream(),
    bodyUsed: false,
    writeHttpMetadata: () => undefined,
    arrayBuffer: async () => copiedArrayBuffer(data),
    bytes: async () => new Uint8Array(copiedArrayBuffer(data)),
    text: async () => "",
    json: async <T>() => JSON.parse("{}") as T,
    blob: async () => new Blob([copiedArrayBuffer(data)]),
  };
}

function storedR2Object(store: Map<string, Uint8Array>, key: string): R2ObjectBody | null {
  const bytes = store.get(key);
  return bytes ? r2Object(key, bytes) : null;
}

export const r2 = (): TestR2Bucket => {
  const store = new Map<string, Uint8Array>();
  return {
    head: async (k: string) => storedR2Object(store, k),
    put: async (k: string, v: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null) => {
      const bytes = v instanceof Uint8Array ? v : new Uint8Array();
      store.set(k, bytes);
      return r2Object(k, bytes);
    },
    get: async (k: string) => storedR2Object(store, k),
    createMultipartUpload: async () => { throw new Error("not implemented"); },
    resumeMultipartUpload: () => { throw new Error("not implemented"); },
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    _store: store,
  };
};

export const PNG_DATAURL = "data:image/png;base64," + btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));

let layoutHolesJson = "";

export function resetLastLayoutHolesJson(): void {
  layoutHolesJson = "";
}

export function lastLayoutHolesJson(): string {
  return layoutHolesJson;
}

function d1Meta(): D1Meta & Record<string, unknown> {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 };
}

function d1Result<T>(results: T[]): D1Result<T> {
  return { results, success: true, meta: d1Meta() };
}

function d1Raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
function d1Raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
async function d1Raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
  return options?.columnNames ? ([[]] as [string[], ...T[]]) : ([] as T[]);
}

export function mockDb(signStatus = "candidate", signKey = "tee-signs/3/5/u.png"): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    let bound: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...vals: unknown[]) { bound = vals; return stmt; },
      all: async <T = Record<string, unknown>>() => {
        let rows: Record<string, unknown>[] = [];
        if (/SELECT \* FROM tee_signs WHERE status/i.test(sql)) {
          rows = [{ id: 1, course_id: 3, hole_number: 5, status: "candidate", r2_key: signKey, content_type: "image/png", uploaded_by: "m_jane", extracted_json: '{"hole":7,"layouts":[{"label":"Long","par":4,"distance_ft":420}]}', extract_source: "dev-stub" }];
        } else if (/SELECT id, hole_number, status FROM tee_signs WHERE course_id/i.test(sql)) {
          const official = { id: 1, hole_number: 7, status: "official" };
          const candidate = { id: 2, hole_number: 8, status: "candidate" };
          rows = /IN \(\?,\?\)/.test(sql) ? [official, candidate] : [official];
        }
        return d1Result(rows as T[]);
      },
      first: async <T = Record<string, unknown>>() => {
        let row: Record<string, unknown> | null = null;
        if (/SELECT \* FROM courses WHERE id/i.test(sql)) row = { id: 3, name: "Test Course" };
        else if (/INSERT INTO tee_signs/i.test(sql)) row = { id: 1, status: "candidate", r2_key: signKey };
        else if (/SELECT \* FROM tee_signs WHERE id/i.test(sql)) row = { id: 1, course_id: 3, hole_number: 5, status: signStatus, r2_key: signKey, content_type: "image/png", uploaded_by: "m_jane", extracted_json: null, extract_source: null };
        else if (/INSERT INTO course_layouts/i.test(sql)) row = { id: 99, course_id: 3, name: "Long", holes: "[]", total_par: null };
        else if (/SELECT \* FROM course_layouts WHERE id/i.test(sql)) row = { id: 99, course_id: 3, name: "Long", holes: "[]", total_par: null };
        else if (/UPDATE course_layouts/i.test(sql)) { layoutHolesJson = String(bound[1] ?? ""); row = { id: 99 }; }
        else if (/DELETE FROM tee_signs/i.test(sql)) row = { r2_key: signKey };
        else if (/UPDATE tee_signs/i.test(sql)) row = { id: 1, status: "official" };
        return row as T | null;
      },
      run: async <T = Record<string, unknown>>() => d1Result<T>([]),
      raw: d1Raw,
    };
    return stmt;
  };
  return {
    prepare,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => ({ prepare, batch: async () => [], getBookmark: () => null }),
    dump: async () => new ArrayBuffer(0),
  };
}

function unavailable(): never {
  throw new Error("not implemented");
}

function fakeLiveNamespace(): Cloudflare.Env["LIVE"] {
  const live = {
    newUniqueId: unavailable,
    idFromName: unavailable,
    idFromString: unavailable,
    get: unavailable,
    getByName: unavailable,
    jurisdiction: () => live,
  };
  return live;
}

function fakeAi(): Ai {
  return {
    aiGatewayLogId: null,
    gateway: unavailable,
    aiSearch: unavailable,
    autorag: unavailable,
    run: unavailable,
    models: unavailable,
    toMarkdown: unavailable,
  };
}

export const env = (photos?: TestR2Bucket, database = mockDb()): RawEnv => ({
  ROSTER: kv(members),
  RATELIMIT: kv(),
  DB: database,
  PHOTOS: photos ?? r2(),
  AI: fakeAi(),
  SESSION_TTL_SEC: "900",
  OPENROUTER_MODEL: "",
  OPENROUTER_FALLBACK_MODEL: "",
  ASSISTANT_MODEL: "",
  PAYPAL_ENV: "sandbox",
  ORDER_NOTIFY_EMAIL: "",
  ORDER_NOTIFY_FROM: "",
  REGISTER_NOTIFY_FROM: "",
  EMAIL_REPLY_TO: "",
  RP_ID: "localhost",
  RP_NAME: "GVDG",
  EXPECTED_ORIGIN: "http://localhost:8080",
  GEMINI_VISION_MODEL: "",
  OPENROUTER_VISION_MODEL: "",
  VISION_MODEL: "",
  JWT_SECRET: SECRET,
  GEMINI_API_KEY: "",
  OPENROUTER_API_KEY: "",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_SECRET: "",
  VISION_DEV_STUB: "1",
  ALLOWED_ORIGINS: "http://localhost:8080",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  LIVE: fakeLiveNamespace(),
  ASSISTANT_RL: { limit: async () => ({ success: true }) },
});

export const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

export async function call(path: string, method: string, token: string | Promise<string> | undefined, body?: unknown, photos?: TestR2Bucket) {
  const h: Record<string, string> = { Origin: "http://localhost:8080" };
  const resolved = token ? await token : undefined;
  if (resolved) h.authorization = "Bearer " + resolved;
  if (body) h["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env(photos));
}
