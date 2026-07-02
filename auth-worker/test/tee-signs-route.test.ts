import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { jsonObject, objectField } from "./json.js";
import { call, env, lastLayoutHolesJson, mockDb, PNG_DATAURL, resetLastLayoutHolesJson, r2, tok } from "./tee-signs-fixture.js";

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
    expect(objectField(await jsonObject(res), "teeSign").status).toBe("candidate");
  });
});

describe("admin approve/reject", () => {
  it("403 for a non-admin approving", async () => {
    expect((await call("/admin/tee-signs/1/approve", "POST", tok("m_jane"), { rows: [{ par: 3 }] })).status).toBe(403);
  });
  it("requires confirmation before approving and applying tee sign rows", async () => {
    resetLastLayoutHolesJson();
    const res = await call("/admin/tee-signs/1/approve", "POST", tok("m_admin"), { rows: [{ newLayoutName: "Long", par: 4, distance_ft: 420 }] });
    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "tee_sign_approval_confirmation_required" });
    expect(lastLayoutHolesJson()).toBe("");
  });
  it("approves with manual rows (admin)", async () => {
    resetLastLayoutHolesJson();
    const res = await call("/admin/tee-signs/1/approve", "POST", tok("m_admin"), { rows: [{ newLayoutName: "Long", par: 4, distance_ft: 420 }], confirm_tee_sign_approval: true });
    expect(res.status).toBe(200);
    const holes = JSON.parse(lastLayoutHolesJson()) as { verified?: { tee_sign_id?: number | null }; tee_sign_id?: number | null }[];
    const [firstHole] = holes;
    expect(firstHole?.verified?.tee_sign_id).toBe(1);
    expect(firstHole?.tee_sign_id).toBe(1);
  });
});

describe("admin reject/delete reclaim the R2 blob", () => {
  it("requires confirmation before rejecting and reclaiming a tee sign image", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/u.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const res = await call("/admin/tee-signs/1/reject", "POST", tok("m_admin"), {}, photos);
    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "tee_sign_reject_confirmation_required" });
    expect(photos._store.has("tee-signs/3/5/u.png")).toBe(true);
  });
  it("reject deletes the stored object (admin)", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/u.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const res = await call("/admin/tee-signs/1/reject", "POST", tok("m_admin"), { confirm_tee_sign_reject: true }, photos);
    expect(res.status).toBe(200);
    expect(photos._store.has("tee-signs/3/5/u.png")).toBe(false);
  });
  it("requires confirmation before deleting and reclaiming a tee sign image", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/u.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const res = await call("/admin/tee-signs/1", "DELETE", tok("m_admin"), undefined, photos);
    expect(res.status).toBe(409);
    expect(await jsonObject(res)).toMatchObject({ error: "tee_sign_delete_confirmation_required" });
    expect(photos._store.has("tee-signs/3/5/u.png")).toBe(true);
  });
  it("delete reclaims the stored object (admin)", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/u.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const res = await call("/admin/tee-signs/1", "DELETE", tok("m_admin"), { confirm_tee_sign_delete: true }, photos);
    expect(res.status).toBe(200);
    expect(photos._store.has("tee-signs/3/5/u.png")).toBe(false);
  });
});

describe("GET /tee-signs/:id/image — rejected blobs are never served (IDOR)", () => {
  it("404s a rejected sign even for a logged-in member", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/r.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const e = env(photos, mockDb("rejected", "tee-signs/3/5/r.png"));
    const res = await worker.fetch(
      new Request("https://w/tee-signs/9/image", { headers: { Origin: "http://localhost:8080", authorization: "Bearer " + (await tok("m_jane")) } }),
      e,
    );
    expect(res.status).toBe(404);
  });
});

describe("admin tee-signs list with suggestedRows", () => {
  it("GET /admin/tee-signs?status=candidate returns suggestedRows from extracted_json", async () => {
    const res = await call("/admin/tee-signs?status=candidate", "GET", tok("m_admin"));
    expect(res.status).toBe(200);
    const body = await res.json() as { teeSigns: { suggestedRows: { label: string; layoutId: null; suggestedLayoutName: string }[] }[] };
    expect(Array.isArray(body.teeSigns)).toBe(true);
    expect(body.teeSigns.length).toBeGreaterThan(0);
    const [sign] = body.teeSigns;
    expect(Array.isArray(sign?.suggestedRows)).toBe(true);
    expect(sign?.suggestedRows.length).toBe(1);
    const [row] = sign?.suggestedRows ?? [];
    expect(row?.label).toBe("Long");
    expect(row?.layoutId).toBeNull(); // no layout in mock DB
    expect(row?.suggestedLayoutName).toBe("Long"); // defaultLayoutName("Long")
  });
});

describe("GET /courses/:id/tee-signs (T4 render)", () => {
  it("unauthed sees official tee signs only", async () => {
    const res = await call("/courses/3/tee-signs", "GET", undefined);
    expect(res.status).toBe(200);
    const body = await res.json() as { teeSigns: { id: number; hole_number: number; status: string }[] };
    expect(body.teeSigns.map((t) => t.status)).toEqual(["official"]);
  });
  it("a logged-in member also sees candidates", async () => {
    const res = await call("/courses/3/tee-signs", "GET", tok("m_jane"));
    expect(res.status).toBe(200);
    const body = await res.json() as { teeSigns: { status: string }[] };
    expect(body.teeSigns.map((t) => t.status).sort()).toEqual(["candidate", "official"]);
  });
});

describe("POST /admin/tee-signs/:id/extract", () => {
  it("403 for non-admin", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/u.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect((await call("/admin/tee-signs/1/extract", "POST", tok("m_jane"), undefined, photos)).status).toBe(403);
  });
  it("200 for admin re-extracts and returns extracted vision result", async () => {
    const photos = r2();
    photos._store.set("tee-signs/3/5/u.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const res = await call("/admin/tee-signs/1/extract", "POST", tok("m_admin"), undefined, photos);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; extracted: { hole: unknown; layouts: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.extracted).toBeDefined();
    expect(Array.isArray(body.extracted.layouts)).toBe(true);
  });
});
