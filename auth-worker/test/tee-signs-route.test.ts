import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
  "member:m_admin": JSON.stringify({ memberId: "m_admin", name: "Admin", isAdmin: true, pinHash: "x", mustChangePin: false }),
};
const kv = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
};
const r2 = () => {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (k: string, v: Uint8Array) => void store.set(k, v),
    get: async (k: string) => store.has(k) ? { body: null, httpMetadata: { contentType: "image/jpeg" } } : null,
    delete: async (k: string) => void store.delete(k),
    _store: store,
  };
};
const PNG_DATAURL = "data:image/png;base64," + btoa(String.fromCharCode(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a));
function mockDb() {
  return { prepare: (sql: string) => ({
    bind() { return this; },
    all: async () => ({ results: [], success: true }),
    first: async () => {
      if (/INSERT INTO tee_signs/i.test(sql)) return { id: 1, status: "candidate", r2_key: "tee-signs/3/5/u.png" };
      if (/SELECT \* FROM tee_signs WHERE id/i.test(sql)) return { id: 1, course_id: 3, hole_number: 5, status: "candidate", r2_key: "tee-signs/3/5/u.png", content_type: "image/png", uploaded_by: "m_jane" };
      if (/INSERT INTO course_layouts/i.test(sql)) return { id: 99, course_id: 3, name: "Long", holes: "[]", total_par: null };
      if (/SELECT \* FROM course_layouts WHERE id/i.test(sql)) return { id: 99, course_id: 3, name: "Long", holes: "[]", total_par: null };
      if (/UPDATE course_layouts/i.test(sql)) return { id: 99 };
      if (/UPDATE tee_signs/i.test(sql)) return { id: 1, status: "official" };
      return null;
    },
    run: async () => ({ success: true }),
  }) };
}
const env = () => ({ ROSTER: kv(members), RATELIMIT: kv(), DB: mockDb(), PHOTOS: r2(), JWT_SECRET: SECRET, ALLOWED_ORIGINS: "http://localhost:8080" } as unknown as Parameters<typeof worker.fetch>[1]);
const tok = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);
async function call(path: string, method: string, token: string | Promise<string> | undefined, body?: unknown) {
  const h: Record<string, string> = { Origin: "http://localhost:8080" };
  const resolved = token ? await token : undefined;
  if (resolved) h.authorization = "Bearer " + resolved;
  if (body) h["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env());
}

describe("POST /tee-signs", () => {
  it("401 without auth", async () => {
    expect((await call("/tee-signs", "POST", undefined, { courseId: 3, hole: 5, image: PNG_DATAURL })).status).toBe(401);
  });
  it("400 on a bad image", async () => {
    const res = await call("/tee-signs", "POST", tok("m_jane"), { courseId: 3, hole: 5, image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
    expect(res.status).toBe(400);
  });
  it("201 stores a candidate for a valid png", async () => {
    const res = await call("/tee-signs", "POST", tok("m_jane"), { courseId: 3, hole: 5, image: PNG_DATAURL });
    expect(res.status).toBe(201);
    expect((await res.json()).teeSign.status).toBe("candidate");
  });
});

describe("admin approve/reject", () => {
  it("403 for a non-admin approving", async () => {
    expect((await call("/admin/tee-signs/1/approve", "POST", tok("m_jane"), { rows: [{ par: 3 }] })).status).toBe(403);
  });
  it("approves with manual rows (admin)", async () => {
    const res = await call("/admin/tee-signs/1/approve", "POST", tok("m_admin"), { rows: [{ newLayoutName: "Long", par: 4, distance_ft: 420 }] });
    expect(res.status).toBe(200);
  });
});
