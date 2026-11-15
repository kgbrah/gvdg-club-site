import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { LiveEventDO } from "../src/live.js";
import { signSession } from "../src/jwt.js";
import type { D1Like } from "../src/db-types.js";
import type { Env } from "../src/env.js";
import type { LiveState } from "../src/live-types.js";

const SECRET = "s".repeat(40);
const ROUND = "/rounds/SAFE44/live";
const OWNER = "m_owner";
const MATE = "m_mate";
const STAFF = "m_staff";
const WATCH = "gvdg-watch-v1";
const SCORE = "gvdg-score-v1";

class Socket {
  attachment: unknown;
  messages: Record<string, unknown>[] = [];
  closed: number | null = null;
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  close(code: number) { this.closed = code; }
  send(value: string) {
    if (this.closed !== null) throw new Error("already closed");
    this.messages.push(JSON.parse(value));
  }
}

function durableState() {
  const data = new Map<string, unknown>();
  const sockets: Socket[] = [];
  const state: LiveState = {
    storage: {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") data.set(key, structuredClone(value));
        else for (const [name, stored] of Object.entries(key)) data.set(name, structuredClone(stored));
      },
      getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    },
    acceptWebSocket: (socket) => sockets.push(socket as Socket), getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn) => fn(),
  };
  return { state, sockets };
}

async function fixture() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql", "0018_live_scoring_metadata.sql", "0039_throw_clips.sql",
    "0034_hole_shot_marks.sql", "0040_round_messages.sql", "0046_throw_clip_recovery.sql", "0049_private_shot_ledgers.sql", "0055_spectator_privacy.sql"]) {
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  type Stmt = { sql: string; values: unknown[] };
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql, values: [] as unknown[],
        bind(...values: unknown[]) { stmt.values = values; return stmt; },
        async all() { return { results: sqlite.prepare(sql).all(...stmt.values), success: true }; },
        async first() { return sqlite.prepare(sql).get(...stmt.values) ?? null; },
        async run() {
          const result = sqlite.prepare(sql).run(...stmt.values);
          return { results: [], success: true, meta: { changes: result.changes, last_row_id: sqlite.prepare("SELECT last_insert_rowid() AS id").get()?.id } };
        },
      };
      return stmt;
    },
    async batch(queries: Stmt[]) {
      sqlite.exec("BEGIN");
      try {
        const rows = queries.map(({ sql, values }) => ({ success: true, results: sqlite.prepare(sql).all(...values) }));
        sqlite.exec("COMMIT");
        return rows;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Like;
  const records = new Map<string, ReturnType<typeof durableState> & { live: LiveEventDO }>();
  function get(id: string) {
    let entry = records.get(id);
    if (!entry) {
      const ready = durableState();
      entry = { ...ready, live: new LiveEventDO(ready.state, { DB: db }) };
      records.set(id, entry);
    }
    return entry;
  }
  const objects = new Map<string, Uint8Array>();
  let reads = 0;
  const env = {
    DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: "https://gvdgclub.com",
    LIVE: { idFromName: (name: string) => name, get: (id: string) => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => get(id).live.fetch(new Request(input, init)) }) },
    ROSTER: { get: async (key: string) => JSON.stringify({ memberId: key.slice(7), isAdmin: key.endsWith(STAFF), name: "QA Player", pinVer: 0 }) },
    RATELIMIT: { get: async () => null, put: async () => {} },
    PHOTOS: {
      put: async (key: string, bytes: Uint8Array) => objects.set(key, bytes),
      head: async (key: string) => { reads++; return objects.has(key) ? { size: objects.get(key)!.length } : null; },
      get: async (key: string, range?: { range: { offset: number; length: number } }) => {
        const bytes = objects.get(key);
        return bytes ? { body: range ? bytes.slice(range.range.offset, range.range.offset + range.range.length) : bytes } : null;
      },
      delete: async (key: string) => objects.delete(key),
    },
  } as unknown as Env;
  const tokens = new Map(await Promise.all([OWNER, MATE, STAFF].map(async (actor) => [actor, await signSession({ sub: actor, mustChangePin: false }, SECRET, 900)] as const)));
  function api(path: string, options: { actor?: string; key?: string; method?: string; data?: unknown; token?: string; headers?: HeadersInit; video?: Uint8Array } = {}) {
    const headers = new Headers(options.headers);
    const tok = options.token ?? (options.actor ? tokens.get(options.actor) : null);
    if (tok) headers.set("Authorization", "Bearer " + tok);
    if (options.key) headers.set("Authorization", "Watch " + options.key);
    const request = new Request("https://worker.test" + path, {
      method: options.method ?? "GET", headers,
      body: options.video ? options.video.buffer as ArrayBuffer : options.data ? JSON.stringify(options.data) : undefined,
    });
    return worker.fetch(request, env);
  }
  function internal(path: string, data?: unknown, actor = OWNER, id = "round:SAFE44") {
    return get(id).live.fetch(new Request("https://do/" + path, {
      method: data ? "POST" : "GET", headers: { "X-Auth-Member": actor, "X-Auth-Admin": String(actor === STAFF) },
      body: data ? JSON.stringify(data) : undefined,
    }));
  }
  function ws(path: string, protocol: string, detail?: string, forged?: HeadersInit) {
    const headers = new Headers(forged);
    headers.set("Upgrade", "websocket");
    headers.set("Sec-WebSocket-Protocol", [protocol, detail].filter(Boolean).join(", "));
    return api(path, { headers });
  }
  async function start() {
    const response = await internal("start", {
      casual: true, roundCode: "SAFE44", createdBy: OWNER, courseName: "River Course",
      holes: [{ hole: 1, par: 3, tee: { lat: 35.12, lng: -77.12 }, target: { lat: 35.125, lng: -77.123 } }],
      players: [{ memberId: OWNER, name: "Same Name" }, { memberId: MATE, name: "Same Name" }],
      startedAt: "2026-06-01T00:00:00Z",
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ recoveryRoundId: string }>;
  }
  async function share(visibility: string, includeMarked = false) {
    const response = await api(ROUND + "/sharing", { actor: OWNER, method: "PUT", data: { visibility, includeMarked } });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ watchKey: string }>;
  }
  return { api, tokens, internal, get, start, share, ws, sqlite, objects, reads: () => reads, resetLive: () => records.delete("round:SAFE44") };
}

const NativeResponse = Response;
function mockSocketUpgrade() {
  vi.stubGlobal("WebSocketPair", function () { return { 0: new Socket(), 1: new Socket() }; });
  vi.stubGlobal("Response", class extends NativeResponse {
    overrideStatus: number | undefined;
    override get status() { return this.overrideStatus ?? super.status; }
    constructor(body: BodyInit | null, init?: ResponseInit) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      this.overrideStatus = init?.status;
    }
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function video() {
  const bytes = new Uint8Array(40);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
}

describe("spectator authorization with SQLite and the live DO", () => {
  it("starts private, sanitizes invite bootstrap, keeps legacy public and leaves event scoring available", async () => {
    const f = await fixture();
    await f.start();
    expect(await (await f.api(ROUND + "/sharing", { actor: OWNER })).json()).toEqual({ owner: true, visibility: "card", includeMarked: false });
    expect((await f.api(ROUND)).status).toBe(404);
    expect((await f.api(ROUND, { actor: STAFF })).status).toBe(404);
    expect((await f.api(ROUND, { actor: MATE })).status).toBe(200);
    expect((await f.api(ROUND + "/sharing", { actor: STAFF, method: "PUT", data: { visibility: "public", includeMarked: true, owner: OWNER } })).status).toBe(403);
    const mine = await (await f.api(ROUND + "/mine", { actor: STAFF })).json();
    expect(mine).toEqual({ status: "live", playerIndex: null, cardId: null, cardmates: [], pendingJoin: null });
    expect((await f.api("/rounds/SAFE44/join", { actor: STAFF, method: "POST" })).status).toBe(200);

    await f.internal("start", { eventId: 5, startedAt: "2026-06-01", holes: [{ hole: 1, par: 3 }], players: [{ name: "Event player" }] }, STAFF, "event:5");
    expect(await (await f.api("/events/5/live")).json()).toMatchObject({ status: "live", players: [{ name: "Event player" }] });
    await f.internal("start", { casual: true, roundCode: "LEGACY", holes: [{ hole: 1, par: 3 }], players: [{ name: "Legacy player" }] }, OWNER, "round:LEGACY");
    expect(await (await f.api("/rounds/LEGACY/live")).json()).toMatchObject({ status: "live", viewerAudience: "public" });
  });

  it("binds socket identities, permits intentional marks, and closes old viewers on link rotation", async () => {
    mockSocketUpgrade();
    const f = await fixture();
    await f.start();
    const mark = { lat: 35.12345, lng: -77.12345, n: 1 };
    await f.internal("throws", { hole: 1, throws: [mark] });
    await f.internal("location", { lat: 35.1212, lng: -77.1212 });
    const ownerToken = f.tokens.get(OWNER)!;
    const sockets = f.get("round:SAFE44").sockets;
    expect((await f.ws(ROUND + "/ws", WATCH, undefined, { "X-Auth-Member": OWNER, "X-Watch-Key": "forged" })).status).toBe(404);
    expect((await f.ws(ROUND + "/ws", SCORE, "a." + f.tokens.get(STAFF))).status).toBe(403);
    expect((await f.ws(ROUND + "/ws", SCORE, "a." + ownerToken)).headers.get("Sec-WebSocket-Protocol")).toBe(SCORE);
    const scorer = sockets[0]!;
    expect(scorer.messages.at(-1)).toMatchObject({ roundCode: "SAFE44", playerLocations: [{ lat: 35.1212 }] });
    expect((await f.ws(ROUND + "/ws", WATCH, "a." + ownerToken)).status).toBe(101);
    const cardViewer = sockets[1]!;
    expect(cardViewer.messages.at(-1)).toMatchObject({ playerLocations: [], players: [{ scores: {} }, { scores: {} }] });
    expect(JSON.stringify(cardViewer.messages.at(-1))).not.toContain(String(mark.lat));

    const { watchKey } = await f.share("link", true);
    expect(cardViewer.closed).toBe(4403);
    expect(scorer.closed).toBeNull();
    expect((await f.api(ROUND)).status).toBe(404);
    expect((await f.api("/watch-round", { key: watchKey })).headers.get("Cache-Control")).toBe("no-store");
    const visible = await (await f.api("/watch-round", { key: watchKey })).json();
    expect(visible).toMatchObject({ roundCode: null, playerLocations: [], players: [{ throws: { 1: [mark] } }, { throws: {} }] });
    expect(JSON.stringify(visible)).not.toContain("SAFE44");
    expect((await f.api("/watch-round/join", { key: watchKey, method: "POST" })).status).toBe(404);
    expect((await f.api(ROUND + "/score", { key: watchKey, method: "POST", data: { hole: 1, strokes: 3 } })).status).toBe(401);
    expect((await f.ws("/watch-round/ws", WATCH, "w." + watchKey)).status).toBe(101);
    const watcher = sockets[2]!;
    expect(watcher.messages.at(-1)).toMatchObject({ roundCode: null, playerLocations: [] });
    const length = watcher.messages.length;
    const next = await f.share("link", false);
    expect(next.watchKey).not.toBe(watchKey);
    expect(watcher.closed).toBe(4403);
    expect((await f.ws("/watch-round/ws", WATCH, "w." + watchKey)).status).toBe(404);
    expect((await f.api("/watch-round", { key: watchKey })).status).toBe(404);
    await f.internal("score", { index: 0, hole: 1, strokes: 2 }, STAFF);
    expect(watcher.messages).toHaveLength(length);
    expect(await (await f.api("/watch-round", { key: next.watchKey })).json()).not.toMatchObject({ players: [{ throws: { 1: [mark] } }] });
    expect(JSON.stringify(f.sqlite.prepare("SELECT * FROM casual_round_sharing").all())).not.toContain(next.watchKey);
  });

  it("closes a live viewer whose authenticated card session expired", async () => {
    mockSocketUpgrade();
    const f = await fixture();
    await f.start();
    const token = await signSession({ sub: OWNER, mustChangePin: false }, SECRET, 30);
    expect((await f.ws(ROUND + "/ws", WATCH, "a." + token)).status).toBe(101);
    const socket = f.get("round:SAFE44").sockets[0]!;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    f.get("round:SAFE44").live.webSocketMessage(socket, "ping");
    expect(socket.closed).toBe(4403);
  });

  it("checks each clip request, including ranges after revocation, and survives finalized archive sorting", async () => {
    const f = await fixture();
    const { recoveryRoundId } = await f.start();
    const uploaded = await f.api(ROUND + "/clips?hole=1&playerIndex=0", { actor: OWNER, method: "POST", video: video() });
    expect(await uploaded.json()).toMatchObject({ id: 1, visibility: "private" });
    const media = ROUND + "/clips/1/media";
    const change = ROUND + "/clips/1/visibility";
    expect((await f.api(media, { actor: MATE })).status).toBe(404);
    expect((await f.api(media, { actor: STAFF })).status).toBe(404);
    expect((await f.api(change, { actor: STAFF, method: "PUT", data: { visibility: "round" } })).status).toBe(404);
    const own = await f.api(media, { actor: OWNER, headers: { Range: "bytes=0-3" } });
    expect(own.status).toBe(206);
    expect(own.headers.get("Cache-Control")).toBe("private, no-store");
    expect(own.headers.get("Content-Range")).toBe("bytes 0-3/40");
    expect((await f.api(change, { actor: OWNER, method: "PUT", data: { visibility: "round" } })).status).toBe(200);
    const { watchKey } = await f.share("link");
    const list = await (await f.api("/watch-round/clips", { key: watchKey })).json();
    expect(list).toMatchObject({ clips: [{ id: 1, hole: 1, playerIndex: 0, generation: recoveryRoundId, mediaPath: "/watch-round/clips/1/media" }] });
    expect(JSON.stringify(list)).not.toContain("SAFE44");
    const remote = "/watch-round/clips/1/media?wl=" + watchKey;
    expect((await f.api(remote)).status).toBe(200);
    expect((await f.api(change, { actor: OWNER, method: "PUT", data: { visibility: "private" } })).status).toBe(200);
    const accesses = f.reads();
    expect((await f.api(remote, { headers: { Range: "bytes=0-3", "If-None-Match": "*" } })).status).toBe(404);
    expect(f.reads()).toBe(accesses);
    expect((await f.api(change, { actor: OWNER, method: "PUT", data: { visibility: "round" } })).status).toBe(200);

    await f.internal("score", { index: 0, hole: 1, strokes: 4 }, STAFF);
    await f.internal("score", { index: 1, hole: 1, strokes: 2 }, STAFF);
    expect((await f.internal("finalize", { force: true }, STAFF)).status).toBe(200);
    f.resetLive();
    const archived = await (await f.api("/watch-round", { key: watchKey })).json();
    expect(archived).toMatchObject({ status: "final", archived: true, recoveryRoundId,
      standings: [{ playerIndexes: [1], clipPlayerIndexes: [1] }, { playerIndexes: [0], clipPlayerIndexes: [0] }] });
    expect((await f.api(remote)).status).toBe(200);
    await f.share("card");
    expect((await f.api(remote)).status).toBe(404);
    expect((await f.api("/watch-round/results", { key: watchKey })).status).toBe(404);
    expect((await f.api(media, { actor: OWNER })).status).toBe(200);
  });

  it("keeps hidden mark coordinates off the public heatmap", async () => {
    const f = await fixture();
    await f.start();
    f.sqlite.exec(`INSERT INTO hole_shot_harvest (layout_id) VALUES (3);
        INSERT INTO hole_shot_marks(layout_id,hole,throw_n,lat,lng,member_id,round_code) VALUES
        (3,1,1,35.1231,-77.1221,'m_owner','SAFE44'),
        (3,1,1,35.1232,-77.1222,'m_owner','event:2'),
        (3,1,1,35.1233,-77.1223,'someone','LEGACY')`);
    const heatmap = "/layouts/3/heatmap?hole=1";
    const legacy = await (await f.api(heatmap)).json();
    expect(legacy).toMatchObject({ samples: 2, lies: [{ lat: 35.1232 }, { lat: 35.1233 }] });
    expect(await (await f.api(heatmap, { actor: OWNER })).json()).toMatchObject({ you: [{ lat: 35.1231 }, { lat: 35.1232 }] });
    await f.share("link", true);
    expect(await (await f.api(heatmap)).json()).toEqual(legacy);
    await f.share("public", true);
    expect(await (await f.api(heatmap)).json()).toMatchObject({ samples: 3 });
    await f.share("public", false);
    expect(await (await f.api(heatmap)).json()).toEqual(legacy);
  });
});
