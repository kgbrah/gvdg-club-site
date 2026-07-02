import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index.js";
import { putMember } from "../src/roster.js";
import { hashPin } from "../src/crypto.js";
import { arrayField, isJsonObject, jsonObject, objectField } from "./json.js";
import { d1Database, d1Statement, memoryKv, workerEnv } from "./worker-test-env.js";

const ORIGIN = "https://www.greenvillediscgolf.com";

function makeDB() {
  return d1Database(() => d1Statement());
}

function makeEnv(rosterBinding: ReturnType<typeof memoryKv>) {
  return workerEnv({ roster: rosterBinding, db: makeDB(), secret: "unit-test-secret-at-least-32-bytes-long!!", origin: ORIGIN });
}

let env: ReturnType<typeof makeEnv>;
let roster: ReturnType<typeof memoryKv>;

beforeEach(async () => {
  roster = memoryKv();
  env = makeEnv(roster);
  await putMember(roster, { memberId: "m_1", name: "Admin Person", pdgaNo: "1", pinHash: await hashPin("4821"), mustChangePin: false, isAdmin: true });
  await putMember(roster, { memberId: "m_999", name: "Normal Member", pdgaNo: "999", pinHash: await hashPin("4821"), mustChangePin: false });
});

function req(path: string, method = "GET", token?: string, body?: unknown): Request {
  const h: Record<string, string> = { Origin: ORIGIN };
  if (token) h.authorization = "Bearer " + token;
  if (body) h["content-type"] = "application/json";
  return new Request("https://w" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
}
async function login(identifier: string, pin: string): Promise<string> {
  const r = await fetchWorker(req("/login", "POST", undefined, { identifier, pin }));
  const body = await jsonObject(r);
  if (typeof body.token === "string") return body.token;
  throw new TypeError("token_missing");
}

async function fetchWorker(request: Request): Promise<Response> {
  return worker.fetch(request, env);
}

describe("admin members onboarding", () => {
  it("401 without a token, 403 for a non-admin", async () => {
    expect((await fetchWorker(req("/admin/members", "GET"))).status).toBe(401);
    const t = await login("999", "4821");
    expect((await fetchWorker(req("/admin/members", "GET", t))).status).toBe(403);
  });

  it("creates a member + issues a temp PIN that logs in with forced change", async () => {
    const t = await login("1", "4821");
    const res = await fetchWorker(req("/admin/members", "POST", t, { name: "New Player", pdgaNo: "273070" }));
    expect(res.status).toBe(201);
    const j = await jsonObject(res);
    expect(typeof j.tempPin).toBe("string");
    if (typeof j.tempPin !== "string") throw new TypeError("temp_pin_missing");
    expect(/^\d{4}$/.test(j.tempPin)).toBe(true);
    expect(objectField(j, "member")).toMatchObject({ memberId: "m_273070", name: "New Player", pdgaNo: "273070", isAdmin: false, mustChangePin: true });
    // the issued temp PIN works at /login and is flagged for forced change
    const l = await fetchWorker(req("/login", "POST", undefined, { identifier: "273070", pin: j.tempPin }));
    expect(l.status).toBe(200);
    expect((await jsonObject(l)).mustChangePin).toBe(true);
  });

  it("requires explicit confirmation before creating another admin", async () => {
    const t = await login("1", "4821");

    const blocked = await fetchWorker(req("/admin/members", "POST", t, { name: "New Admin", pdgaNo: "273071", isAdmin: true }));
    expect(blocked.status).toBe(409);
    expect(await jsonObject(blocked)).toMatchObject({ error: "admin_grant_confirmation_required" });
    expect(await roster.get("member:m_273071")).toBeNull();

    const confirmed = await fetchWorker(req("/admin/members", "POST", t, { name: "New Admin", pdgaNo: "273071", isAdmin: true, confirm_admin_grant: true }));
    expect(confirmed.status).toBe(201);
    const j = await jsonObject(confirmed);
    expect(objectField(j, "member")).toMatchObject({ memberId: "m_273071", name: "New Admin", pdgaNo: "273071", isAdmin: true, mustChangePin: true });
  });

  it("409 when the member already exists; validates input", async () => {
    const t = await login("1", "4821");
    await fetchWorker(req("/admin/members", "POST", t, { name: "A", pdgaNo: "273070" }));
    expect((await fetchWorker(req("/admin/members", "POST", t, { name: "B", pdgaNo: "273070" }))).status).toBe(409);
    expect((await fetchWorker(req("/admin/members", "POST", t, { pdgaNo: "5" }))).status).toBe(400); // no name
    expect((await fetchWorker(req("/admin/members", "POST", t, { name: "X" }))).status).toBe(400); // no pdga/udisc
    expect((await fetchWorker(req("/admin/members", "POST", t, { name: "X", pdgaNo: "abc" }))).status).toBe(400); // bad pdga
  });

  it("requires confirmation before reissuing a temp PIN for an existing member", async () => {
    const t = await login("1", "4821");
    const unconfirmed = await fetchWorker(req("/admin/members/reset-pin", "POST", t, { identifier: "999" }));
    expect(unconfirmed.status).toBe(409);
    expect(await jsonObject(unconfirmed)).toMatchObject({ error: "member_pin_reset_confirmation_required" });
  });

  it("reissues a temp PIN for an existing member (forced change), 404 unknown", async () => {
    const t = await login("1", "4821");
    const res = await fetchWorker(req("/admin/members/reset-pin", "POST", t, { identifier: "999", confirm_member_pin_reset: true }));
    expect(res.status).toBe(200);
    const j = await jsonObject(res);
    expect(typeof j.tempPin).toBe("string");
    if (typeof j.tempPin !== "string") throw new TypeError("temp_pin_missing");
    expect(/^\d{4}$/.test(j.tempPin)).toBe(true);
    const l = await fetchWorker(req("/login", "POST", undefined, { identifier: "999", pin: j.tempPin }));
    expect((await jsonObject(l)).mustChangePin).toBe(true); // old PIN replaced, forced change
    expect((await fetchWorker(req("/admin/members/reset-pin", "POST", t, { identifier: "55555", confirm_member_pin_reset: true }))).status).toBe(404);
  });

  it("lists members without leaking the PIN hash", async () => {
    const t = await login("1", "4821");
    const j = await jsonObject(await fetchWorker(req("/admin/members", "GET", t)));
    const members = arrayField(j, "members");
    expect(members.some((m) => isJsonObject(m) && m.memberId === "m_1" && m.isAdmin === true)).toBe(true);
    expect(members.every((m) => isJsonObject(m) && !("pinHash" in m))).toBe(true);
  });
});
