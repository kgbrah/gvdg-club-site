import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { readWatchCard, watchActor, beginWatchScore, addWatchReceipt, checkWatchScore } from "../src/watch-do.js";
import { handleWatchRoute } from "../src/watch-routes.js";
import type { LiveMeta } from "../src/live-types.js";
import type { PlayerState } from "../src/scoring.js";

const SECRET = "watch-secret-for-protocol-tests-only!!!";
const member = (id: string, pinVer = 0) => JSON.stringify({ memberId: id, name: id, pinVer, pinHash: "test", mustChangePin: false });
const meta: LiveMeta = { eventId: 8, startedAt: "2026-07-09T11:00:00Z", status: "live", holes: [{ hole: 1, par: 3 }] };
const firstRound = { eventId: 8 };
const op = { sequence: 1, targetId: "player:0", binding: "0", hole: 1, previous: null, strokes: 4 };
const players = (): PlayerState[] => [
  { memberId: "m_player", name: "Card member", cardId: "a", division: null, scores: {} },
  { memberId: "m_other", name: "Other card", cardId: "b", division: null, scores: {} },
];

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return { get: async (key: string) => rows.get(key) ?? null, put: async (key: string, value: string) => void rows.set(key, value) };
}

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0047_watch_pairings.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql: string) {
      const prepared = sqlite.prepare(sql);
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { params = values; return stmt; },
        all: async () => ({ results: prepared.all(...params) }),
        first: async () => prepared.get(...params) ?? null,
        run: async () => prepared.run(...params),
      };
      return stmt;
    },
  };
  const roster = kv({ "member:m_player": member("m_player"), "member:m_other": member("m_other") });
  const seen: { path: string; key: string; actor: string | null; admin: string | null; body: unknown }[] = [];
  const cardPlayers = [...players(), { memberId: "op_a", name: "Open play", cardId: "a", division: null, scores: {} }];
  const env = {
    DB: db, ROSTER: roster, RATELIMIT: kv(), JWT_SECRET: SECRET,
    LIVE: { idFromName: (name: string) => name, get: (key: string) => ({
      fetch: async (url: string, init: RequestInit) => {
        const request = new Request(url, init);
        const { pathname: path } = new URL(request.url);
        const actor = request.headers.get("X-Auth-Member");
        const body = await request.json() as { scope?: { roundId: string; cardId: string | null; actorIndex: number } };
        seen.push({ key, path, actor, admin: request.headers.get("X-Auth-Admin"), body });
        if (path === "/watch-score") return Response.json({ sequence: 1 });
        return readWatchCard(meta, cardPlayers, actor, `generation:${key}`, body.scope);
      },
    }) },
  } as unknown as Env;
  async function phoneToken(sub: string) { return signSession({ sub, mustChangePin: false }, SECRET, 900); }
  async function request(path: string, method: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = { "CF-Connecting-IP": "192.0.2.2" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = new Request(`https://watch.example${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    return (await handleWatchRoute(req, env, null, path.split("?")[0]!, method))!;
  }
  async function start() {
    const res = await request("/watch/pairings", "POST");
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const data = await res.json() as { code: string; token: string };
    expect(data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(data.token).toMatch(/^gvdgw_[A-Za-z0-9_-]{43}$/);
    return data;
  }
  async function approve(code: string, token: string, round: { roundCode: string } | { eventId: number } = firstRound) {
    return request("/watch/pairings/approve", "POST", token, { code, ...round });
  }
  return { sqlite, roster, seen, start, approve, request, phoneToken };
}

describe("native watch pairing and scope", () => {
  let fx: Awaited<ReturnType<typeof fixture>>;
  let phone: string;
  beforeEach(async () => {
    fx = await fixture();
    phone = await fx.phoneToken("m_player");
  });

  it("one concurrent approval wins, stores hashes, and never trusts watch-provided identity", async () => {
    const { code, token } = await fx.start();
    const keys = fx.sqlite.prepare("SELECT token_hash, code_hash FROM watch_pairings").get();
    expect(keys?.token_hash).not.toBe(token);
    expect(keys?.code_hash).not.toBe(code);
    expect((await fx.request("/watch/card", "GET", token)).status).toBe(409);
    const responses = await Promise.all([fx.approve(code.toLowerCase(), phone), fx.approve(code, phone)]);
    expect(responses.filter((res) => res.ok)).toHaveLength(1);
    expect([400, 409]).toContain(responses.find((res) => !res.ok)?.status);
    expect((await fx.approve(code, phone)).status).toBe(400);
    expect(fx.sqlite.prepare("SELECT code_hash FROM watch_pairings").get()?.code_hash).toBeNull();
    const card = await fx.request("/watch/card", "GET", token);
    expect(card.status).toBe(200);
    expect((await card.json() as { targets: unknown[] }).targets).toMatchObject([
      { id: "player:0", name: "Card member", binding: "0" }, { id: "player:2", name: "Open play", binding: "2" },
    ]);
    const score = await fx.request("/watch/score", "POST", token, { ...op, scorerIndex: 99, scope: {}, authAdmin: true, eventId: 10 });
    expect(score.status).toBe(200);
    expect(fx.seen.at(-1)).toMatchObject({ key: "event:8", path: "/watch-score", actor: "m_player", admin: null,
      body: { scope: { actorIndex: 0, cardId: "a", roundId: "generation:event:8" }, op } });
    expect((fx.seen.at(-1)?.body as { op: unknown }).op).toEqual(op);
    expect((await fx.approve("AAAAAAAA", token)).status).toBe(401);
    expect((await fx.request("/watch/score", "POST", phone, op)).status).toBe(401);
  });

  it("expires pending and approved sessions, and revokes only the owner's device", async () => {
    const pending = await fx.start();
    fx.sqlite.exec("UPDATE watch_pairings SET expires_at = 0");
    expect((await fx.approve(pending.code, phone)).status).toBe(400);
    expect((await fx.request("/watch/card", "GET", pending.token)).status).toBe(401);
    const device = await fx.start();
    const pair = await fx.approve(device.code, phone);
    const { deviceId } = await pair.json() as { deviceId: string };
    const other = await fx.phoneToken("m_other");
    expect((await fx.request(`/watch/pairings/${deviceId}`, "DELETE", other)).status).toBe(404);
    const list = await fx.request("/watch/pairings?eventId=8", "GET", phone);
    expect(await list.json()).toMatchObject({ devices: [{ deviceId }] });
    expect((await fx.request(`/watch/pairings/${deviceId}`, "DELETE", phone)).status).toBe(200);
    expect((await fx.request("/watch/card", "GET", device.token)).status).toBe(401);
    expect((await fx.request("/watch/score", "POST", device.token, op)).status).toBe(401);
    const expired = await fx.start();
    expect((await fx.approve(expired.code, phone)).status).toBe(200);
    fx.sqlite.exec("UPDATE watch_pairings SET expires_at = 0");
    expect((await fx.request("/watch/score", "POST", expired.token, op)).status).toBe(401);
  });

  it("requires card membership, respects member PIN resets, and allows open play only on casual cards", async () => {
    const device = await fx.start();
    const absent = await fx.phoneToken("m_absent");
    expect((await fx.approve(device.code, absent)).status).toBe(401);
    await fx.roster.put("member:m_absent", member("m_absent"));
    expect((await fx.approve(device.code, absent)).status).toBe(403);
    const open = await signOpenPlaySession({ sub: "op_a", name: "Open play" }, SECRET, 900);
    expect((await fx.approve(device.code, open)).status).toBe(401);
    expect((await fx.approve(device.code, open, { roundCode: "PLAY22" })).status).toBe(200);
    const memberDevice = await fx.start();
    expect((await fx.approve(memberDevice.code, phone)).status).toBe(200);
    await fx.roster.put("member:m_player", member("m_player", 1));
    expect((await fx.request("/watch/card", "GET", memberDevice.token)).status).toBe(401);
  });
});

describe("watch score preconditions", () => {
  it("rejects moved actors, restarted rounds, stale phone votes, and pair slot changes", async () => {
    const rows = players();
    const scope = { roundId: "first", cardId: "a", actorIndex: 0 };
    expect(watchActor(meta, rows, "m_player", "first", scope)).toEqual(scope);
    expect((watchActor(meta, rows, "m_player", "second", scope) as Response).status).toBe(409);
    rows[0]!.cardId = "b";
    expect((watchActor(meta, rows, "m_player", "first", scope) as Response).status).toBe(409);
    const row = rows[0]!;
    const target = { type: "player", playerIndexes: [0], memberIds: ["m_player"], id: "player:0", label: "Player" } as const;
    expect(checkWatchScore(op, target, row, "player:0")).toBeNull();
    row.scorecards = { 1: { "player:0": 3 } };
    expect(await checkWatchScore(op, target, row, "player:0")?.json()).toEqual({ error: "watch_score_conflict", previous: 3 });
    expect(await checkWatchScore({ ...op, binding: "1" }, target, row, "player:0")?.json()).toEqual({ error: "watch_target_changed" });
  });

  it("acknowledges exact prior writes while rejecting changed payloads and skipped sequences", async () => {
    expect(beginWatchScore([], op)).toBeNull();
    const receipts = addWatchReceipt([], op);
    expect(await beginWatchScore(receipts, op)?.json()).toEqual({ sequence: 1 });
    expect(await beginWatchScore(receipts, { ...op, strokes: 5 })?.json()).toEqual({ error: "watch_sequence_reused" });
    expect(beginWatchScore(receipts, { ...op, sequence: 2 })).toBeNull();
    expect(await beginWatchScore(receipts, { ...op, sequence: 3 })?.json()).toEqual({ error: "watch_sequence_out_of_order", lastSequence: 1 });
  });
});
