import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { requireAuth, requireRoundActor } from "../src/authz.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { handlePhoneActivityRoute } from "../src/phone-activity-routes.js";
import { activityGpx, activityTotals, parseActivityTrack, type ActivityTrack } from "../src/phone-activity-model.js";

const OWNER = "m_owner";
const OTHER = "m_other";
const SECRET = "activity-device-secret".repeat(3);
const DATE = Date.UTC(2026, 10, 15, 15);
const ID = "30000000-0000-4000-8000-000000000001";
const GENERATION = "30000000-0000-4000-8000-000000000005";
const ORIGIN = "https://gvdgclub.com";

function track(ownerId = OWNER): ActivityTrack {
  return {
    version: 1, clientId: ID, ownerId, startedAt: DATE, stoppedAt: DATE + 290_000, round: null,
    segments: [
      [{ lat: 35, lng: -82, accuracyM: 6, at: DATE }, { lat: 35, lng: -81.9999, accuracyM: 6, at: DATE + 10_000 }],
      [{ lat: 36, lng: -82, accuracyM: 8, at: DATE + 100_000 }, { lat: 36, lng: -81.9999, accuracyM: 8, at: DATE + 110_000 },
        { lat: 36, lng: -81.99, accuracyM: 10, at: DATE + 250_000 }],
    ],
  };
}

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0056_phone_activity.sql", import.meta.url), "utf8"));
  let memberPin = 2;
  let removed = false;
  const doRequests: Array<{ key: string; owner: string | null; body: Record<string, unknown> }> = [];
  const env = {
    JWT_SECRET: SECRET,
    ROSTER: { async get(key: string) {
      const id = key.slice(7);
      return key.startsWith("member:") && [OWNER, OTHER].includes(id)
        ? JSON.stringify({ memberId: id, pinHash: "x", name: id, pinVer: memberPin, mustChangePin: false }) : null;
    } },
    RATELIMIT: { async get() { return null; }, async put() {} },
    DB: { prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: never[] = [];
      return {
        bind(...args: never[]) { values = args; return this; },
        async all() { return { results: statement.all(...values), success: true }; },
        async first() { return statement.get(...values) ?? null; },
        async run() { return statement.run(...values); },
      };
    } },
    LIVE: {
      idFromName(key: string) { return key; },
      get(key: string) {
        return { async fetch(url: string, init: RequestInit) {
          const req = new Request(url, init);
          const owner = req.headers.get("X-Auth-Member");
          const body = await req.json() as Record<string, unknown>;
          doRequests.push({ key, owner, body });
          if (owner !== OWNER || removed || key !== "round:TEST42") return Response.json({ error: "not_on_card" }, { status: 403 });
          return Response.json({
            scope: { roundId: GENERATION, cardId: "C", actorIndex: 1 }, status: "live", startingHole: 1,
            courseName: "My course", layoutName: "Saved positions", revision: 99,
            holes: [{ hole: 1, par: 3, basket: { lat: 35.001, lng: -82 } }],
            targets: [{ id: "private-target", votes: { 1: 2 } }],
          });
        } };
      },
    },
  } as unknown as Env;
  const member = await signSession({ sub: OWNER, pinVer: 2, mustChangePin: false }, SECRET, 900);
  const other = await signSession({ sub: OTHER, pinVer: 2, mustChangePin: false }, SECRET, 900);
  function request(path: string, token?: string, body?: unknown, method = body == null ? "GET" : "POST") {
    return new Request("https://api.test" + path, { method, headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}), ...(body == null ? {} : { "Content-Type": "application/json" }),
    }, body: body == null ? undefined : JSON.stringify(body) });
  }
  async function call(path: string, token?: string, body?: unknown, method?: string) {
    const req = request(path, token, body, method);
    const response = await handlePhoneActivityRoute(req, env, ORIGIN, new URL(req.url).pathname, req.method);
    expect(response).not.toBeNull();
    return response!;
  }
  async function newPair(roundKey?: string, approvedBy = member) {
    const begin = await call("/activity/pairings", undefined, { platform: "ios" });
    expect(begin.status).toBe(201);
    const pair = await begin.json() as { code: string; token: string; expiresAt: number };
    const pending = await call("/activity/device", pair.token);
    expect(pending.status).toBe(409);
    const approved = await call("/activity/pairings/approve", approvedBy, { code: pair.code, roundKey });
    expect(approved.status).toBe(200);
    const { deviceId } = await approved.json() as { deviceId: string };
    return { ...pair, deviceId };
  }
  return { sqlite, env, member, other, request, call, newPair, doRequests,
    moveActor() { removed = true; }, pinChanged() { memberPin = 3; } };
}

describe("native phone activity API", () => {
  it("requires a member to approve a fresh one-use code and keeps opaque credentials purpose scoped", async () => {
    const { sqlite, env, member, call, request, newPair, pinChanged } = await setup();
    const open = await signOpenPlaySession({ sub: "op_open", name: "Open player" }, SECRET, 900);
    expect((await call("/activity/pairings/approve", open, { code: "12345678" })).status).toBe(401);
    expect((await call("/activity/pairings", undefined, { platform: "desktop" })).status).toBe(400);
    const pair = await newPair();
    expect((await call("/activity/pairings/approve", member, { code: pair.code })).status).toBe(400);
    expect((await call("/activity/device?token=" + pair.token)).status).toBe(401);
    expect(await requireAuth(request("/me", pair.token), env)).toBeNull();
    expect(await requireRoundActor(request("/rounds", pair.token), env)).toBeNull();
    expect((await call("/activity/tracks", pair.token)).status).toBe(401);
    const raw = sqlite.prepare("SELECT token_hash, code_hash FROM phone_activity_devices WHERE id = ?").get(pair.deviceId);
    expect(raw?.token_hash).not.toBe(pair.token);
    expect(raw?.code_hash).toBeNull();
    expect(await (await call("/activity/device", pair.token)).json()).toMatchObject({ memberId: OWNER, round: null });
    pinChanged();
    expect((await call("/activity/device", pair.token)).status).toBe(401);
  });

  it("only returns approved basket positions and rechecks the actor generation and card", async () => {
    const { call, newPair, doRequests, moveActor, member, other } = await setup();
    const pair = await newPair("round:TEST42");
    const state = await call("/activity/device", pair.token);
    const payload = await state.json() as { round: unknown };
    expect(payload.round).toEqual({
      key: "round:TEST42", generation: GENERATION, status: "live", startingHole: 1,
      courseName: "My course", layoutName: "Saved positions", holes: [{ hole: 1, basket: { lat: 35.001, lng: -82 } }],
    });
    expect(doRequests[1]).toMatchObject({
      key: "round:TEST42", owner: OWNER, body: { scope: { roundId: GENERATION, cardId: "C", actorIndex: 1 } },
    });
    moveActor();
    expect(await (await call("/activity/device", pair.token)).json()).toMatchObject({ round: null, roundUnavailable: true });
    const start = await call("/activity/pairings", undefined, { platform: "android" });
    const { code } = await start.json() as { code: string };
    expect((await call("/activity/pairings/approve", other, { code, roundKey: "round:TEST42" })).status).toBe(409);
    expect((await call("/activity/pairings/" + pair.deviceId, other, undefined, "DELETE")).status).toBe(404);
    expect((await call("/activity/pairings/" + pair.deviceId, member, undefined, "DELETE")).status).toBe(200);
    expect((await call("/activity/device", pair.token)).status).toBe(401);
  });

  it("scopes upload and private exports and never recreates a removed route on retry", async () => {
    const { sqlite, call, newPair, member, other } = await setup();
    const { token } = await newPair("round:TEST42");
    const original = track();
    original.round = { key: "round:TEST42", generation: GENERATION };
    expect((await call("/activity/tracks", token, { ...original, ownerId: OTHER })).status).toBe(403);
    expect((await call("/activity/tracks", token, { ...original, round: { key: "round:ELSE", generation: GENERATION } })).status).toBe(403);
    const saved = await call("/activity/tracks", token, original);
    expect(saved.status).toBe(201);
    const receipt = await saved.json() as { id: number; distanceM: number; pointCount: number };
    expect(receipt).toMatchObject({ distanceM: 18, pointCount: 5 });
    const retry = await call("/activity/tracks", token, original);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(receipt);
    expect((await call("/activity/tracks", token, { ...original, stoppedAt: original.stoppedAt + 1 })).status).toBe(409);
    const url = "/activity/tracks/" + receipt.id;
    expect((await call(url, token)).status).toBe(401);
    expect((await call(url, other)).status).toBe(404);
    expect(await (await call("/activity/tracks", other)).json()).toEqual({ tracks: [], before: null });
    const data = await call(url + "?format=json", member);
    expect(data.headers.get("Cache-Control")).toBe("private, no-store");
    expect(data.headers.get("Content-Disposition")).toBe('attachment; filename="gvdg-activity.json"');
    expect(await data.json()).toMatchObject({ track: original });
    const gpx = await call(url + "?format=gpx", member);
    const markup = await gpx.text();
    expect(markup.match(/<trkseg>/g)).toHaveLength(3);
    expect(markup).not.toContain(OWNER);
    expect((await call(url, member, undefined, "DELETE")).status).toBe(200);
    expect((await call(url, member)).status).toBe(404);
    expect((await call("/activity/tracks", token, original)).status).toBe(410);
    expect(sqlite.prepare("SELECT snapshot FROM phone_activity_tracks").get()?.snapshot).toBe("{}");
  });

  it("rejects invalid course references and coordinates without bridging paused or interrupted GPS segments", () => {
    const original = track();
    expect(activityTotals(original)).toEqual({ pointCount: 5, distanceM: 18 });
    expect(activityGpx(original)).toContain("2026-11-15T15:00:00.000Z");
    expect(parseActivityTrack({ ...original, segments: [[{ at: DATE, lat: 91, lng: 0, accuracyM: 3 }]] })).toBeNull();
    expect(parseActivityTrack({ ...original, segments: [[original.segments[0]![1], original.segments[0]![0]]] })).toBeNull();
    expect(parseActivityTrack({ ...original, segments: [[]] })).toBeNull();
    expect(parseActivityTrack({ ...original, round: { key: "https://example.test", generation: "f" } })).toBeNull();
    expect(parseActivityTrack({ ...original, token: "discard" })).toEqual(original);
  });
});
