import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { OfflineRound } from "../../src/shared/offline-round.js";
import { requireAuth, requireRoundActor } from "../src/authz.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { signOfflineOpenSession } from "../src/offline-round-auth.js";
import { handleOfflineRoundRoute } from "../src/offline-round-routes.js";
import { handleMyPlayExport, handleMyPlayHistory } from "../src/play-history-routes.js";

const SECRET = "archive-secret".repeat(4);
const OPEN = "op_f7f4d2a4048b3309c2524e88";
const MINE = "m_offline";
const OTHER = "m_other";
const pinVer = 5;
const PLAYER = "10000000-0000-4000-8000-000000000001";
const CLIP = "10000000-0000-4000-8000-000000000010";
const CARD = "10000000-0000-4000-8000-000000000020";
const ORIGIN = "https://gvdgclub.com";

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql",
    "0018_live_scoring_metadata.sql", "0038_udisc_history.sql", "0039_throw_clips.sql", "0049_private_shot_ledgers.sql", "0053_offline_rounds.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  const objects = new Map<string, Uint8Array>();
  const env = {
    JWT_SECRET: SECRET,
    RATELIMIT: { async get() { return null; }, async put() {} },
    ROSTER: { async get(key: string) {
      const id = key.slice(7);
      return /^member:/.test(key) && [MINE, OTHER].includes(id)
        ? JSON.stringify({ memberId: id, name: id, pinHash: "x", pinVer, mustChangePin: false }) : null;
    } },
    DB: { prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      let values: never[] = [];
      return {
        bind(...args: never[]) { values = args; return this; },
        async first() { return stmt.get(...values) ?? null; },
        async all() { return { success: true, results: stmt.all(...values) }; },
      };
    } },
    PHOTOS: {
      async put(key: string, bytes: Uint8Array) { objects.set(key, bytes.slice()); },
      async delete(key: string) { objects.delete(key); },
      async get(key: string, { range }: { range?: { offset: number; length: number } } = {}) {
        const bytes = objects.get(key);
        return bytes ? { body: range ? bytes.slice(range.offset, range.offset + range.length) : bytes } : null;
      },
    },
  } as unknown as Env;
  const mine = await signSession({ sub: MINE, pinVer, mustChangePin: false }, SECRET, 300);
  const other = await signSession({ sub: OTHER, pinVer, mustChangePin: false }, SECRET, 300);
  const openArchive = await signOfflineOpenSession(OPEN, SECRET);
  function request(path: string, token?: string, init: RequestInit = {}) {
    return new Request("https://api.test" + path, { ...init, headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}), ...(init.headers || {}),
    } });
  }
  async function route(path: string, token?: string, init?: RequestInit) {
    const req = request(path, token, init);
    const result = await handleOfflineRoundRoute(req, env, ORIGIN, new URL(req.url).pathname, req.method);
    expect(result).not.toBeNull();
    return result!;
  }
  const upload = (round: OfflineRound, token = mine) => route("/offline-rounds/import", token, {
    method: "POST", body: JSON.stringify(round), headers: { "Content-Type": "application/json" },
  });
  return { env, sqlite, objects, mine, other, openArchive, request, route, upload };
}

function card(owner: OfflineRound["owner"] = { id: MINE, kind: "member" }): OfflineRound {
  return {
    version: 1, localId: CARD, owner, startedAs: "account",
    source: { courseId: 922, courseName: "Offline Pines", layoutId: 802, layoutName: "Old basket",
      savedAt: "2026-04-21T18:00:00.000Z", revision: "r-2026-04", contentRevision: "layout-2026-04",
      holes: [{ hole: 1, par: 3, par_source: "official", distance_ft: 331, distance_source: "survey",
        tee: { label: "Tee", lat: 35.001, lng: -77 }, target: { label: "Old basket", lat: 35, lng: -77 } }] },
    format: { groupFormat: "singles", scoringStyle: "stroke" },
    players: [{ id: PLAYER, name: "Owner" }],
    startedAt: "2026-04-22T19:00:00.000Z", finishedAt: "2026-04-22T20:00:00.000Z",
    scores: { "player:0": { 1: 2 } },
    marks: { 1: [{ lat: 35.00005, lng: -77, n: 1 }] },
    shots: { 1: [
      { kind: "throw", id: PLAYER, recordedAt: 1776884460000, attempt: "throw", outcome: "missed",
        originLie: "tee", landingLie: "unknown", origin: { lat: 35.001, lng: -77 }, landing: { lat: 35.00005, lng: -77 } },
      { kind: "throw", id: CLIP, recordedAt: 1776884465000, attempt: "putt", outcome: "made",
        originLie: "unknown", landingLie: "basket", puttDistanceFt: 18 },
    ] },
  };
}

describe("offline round archive", () => {
  it("returns one receipt on retries and keeps an edited or foreign snapshot out", async () => {
    const { upload, route, sqlite, other, mine } = await fixture();
    const round = card();
    const initial = await upload(round);
    expect(initial.status).toBe(201);
    const receipt = await initial.json() as { id: number };
    const replay = await upload(round);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const different = structuredClone(round);
    different.scores["player:0"]![1] = 3;
    expect((await upload(different)).status).toBe(409);
    expect((await upload(round, other)).status).toBe(403);
    different.owner.id = OTHER;
    expect((await upload(different, other)).status).toBe(409);
    expect((await route("/offline-rounds/" + receipt.id, other)).status).toBe(404);
    expect(await (await route("/offline-rounds", other)).json()).toEqual({ rounds: [], before: null });
    const archive = await (await route("/offline-rounds/" + receipt.id, mine)).json() as { round: OfflineRound };
    expect(archive.round.source).toEqual(round.source);
    expect(archive.round.scores).toEqual(round.scores);
    expect(archive.round.shots[1]).toHaveLength(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM offline_rounds").get()?.n).toEqual(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM results").get()?.n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM casual_results").get()?.n).toBe(0);
  });

  it("keeps open play archive proof scoped and rejects expired and ordinary member-looking substitutions", async () => {
    const { upload, route, env, request, openArchive } = await fixture();
    const round = card({ id: OPEN, kind: "open" });
    const expiredArchive = await signOfflineOpenSession(OPEN, SECRET, -300);
    const expiredMember = await signSession({ sub: MINE, pinVer, mustChangePin: false }, SECRET, -300);
    const expiredOpen = await signOpenPlaySession({ sub: OPEN, name: "Owner" }, SECRET, -300);
    const live = await signOpenPlaySession({ sub: OPEN, name: "Owner" }, SECRET, 60);
    const misleading = await new SignJWT({ offlinePlay: true }).setProtectedHeader({ alg: "HS256" })
      .setIssuer("gvdg:offline-archive").setAudience("gvdg:offline-round-archive:v1")
      .setSubject(OPEN).setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(SECRET));
    for (const token of [expiredArchive, expiredMember, expiredOpen, misleading]) {
      expect((await route("/offline-rounds", token)).status).toBe(401);
    }
    expect((await upload(round, openArchive)).status).toBe(201);
    expect((await upload(round, openArchive)).status).toBe(200);
    expect(await requireAuth(request("/me", openArchive), env)).toBeNull();
    expect(await requireRoundActor(request("/rounds/ABCDEF/live/score", openArchive), env)).toBeNull();
    expect((await route("/offline-rounds/open-session", openArchive, { method: "POST" })).status).toBe(401);
    const refresh = await route("/offline-rounds/open-session", live, { method: "POST" });
    expect(refresh.status).toBe(200);
    const { offlineToken } = await refresh.json() as { offlineToken: string };
    expect((await upload(round, offlineToken)).status).toBe(200);
    expect((await route("/offline-rounds?token=" + openArchive)).status).toBe(401);
  });

  it("keeps clips keyed to the owner, round and roster slot, and includes them in private exports", async () => {
    const { upload, route, objects, env, request, mine, other } = await fixture();
    const round = card();
    round.startedAs = "device";
    round.format.groupFormat = "doubles";
    round.players.push({ id: "10000000-0000-4000-8000-000000000002", name: "Partner" });
    round.scores = { "pair:team 1": { 1: 2 } };
    const { id } = await (await upload(round)).json() as { id: number };
    const bytes = new Uint8Array(40);
    bytes.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70], 0);
    const path = `/offline-rounds/${id}/clips?clientId=${CLIP}&hole=1&playerIndex=1&highlight=1&moment=parked`;
    const post = (url: string, token = mine, body = bytes) => route(url, token, { method: "POST", body });
    const first = await post(path);
    expect(first.status).toBe(201);
    const info = await first.json() as { playerName: string; mediaPath: string; clientId: string };
    expect(info).toMatchObject({ playerName: "Partner", clientId: CLIP });
    const repeat = await post(path);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(info);
    expect((await post(path.replace("playerIndex=1", "playerIndex=0"))).status).toBe(409);
    expect((await post(path, other)).status).toBe(404);
    expect((await route(info.mediaPath, other)).status).toBe(404);
    const partial = await route(info.mediaPath, mine, { headers: { Range: "bytes=2-8" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Array.from(new Uint8Array(await partial.arrayBuffer()))).toEqual(Array.from(bytes.slice(2, 9)));
    expect(objects.size).toBe(1);

    const exportFor = async (token: string) => (await handleMyPlayExport(request("/me/play-export", token), env, ORIGIN)).json();
    const own = await exportFor(mine) as { schemaVersion: string; rounds: Array<{ offlineSnapshot: OfflineRound }>; clips: unknown[] };
    expect(own.schemaVersion).toBe("gvdg-play-export-2");
    expect(own.rounds[0]?.offlineSnapshot).toMatchObject({ localId: CARD, startedAs: "device", scores: round.scores });
    expect(own.clips[0]).toMatchObject({ scope: "offline", mediaPath: info.mediaPath, clientId: CLIP, playerIndex: 1 });
    expect(await exportFor(other)).toMatchObject({ rounds: [], clips: [] });
    const params = "window=all&source=offline&group=doubles";
    const history = await handleMyPlayHistory(request("/me/play-history?" + params, mine), env, ORIGIN);
    expect(await history.json()).toMatchObject({ roundCount: 1, scoreTrend: { rounds: 1, c1x: { made: 1, attempts: 1 } },
      recentRounds: [{ source: "offline", resultId: id, explicitLedgerHoles: 1 }] });
    expect((await handleMyPlayHistory(request("/me/play-history?shotResult=offline:" + id, other), env, ORIGIN)).status).toBe(404);
    const csv = await handleMyPlayExport(request("/me/play-export?format=csv", mine), env, ORIGIN);
    expect(await csv.text()).toContain(info.mediaPath);
  });
});
