import { describe, expect, it } from "vitest";
import { handleThrowClips } from "../src/throw-clip-routes.js";
import { cardFromMine, clipTarget, byteRange, sniffVideo } from "../src/throw-clips.js";
import type { Env } from "../src/env.js";

const CARD = {
  status: "live",
  holes: [{ hole: 7 }],
  cardmates: [{ index: 1, name: "Jane Doe" }],
};

function webm(): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
}

function memoryDb() {
  const rows: Record<string, unknown>[] = [];
  let nextId = 1;
  return {
    rows,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      const stmt = {
        binds: [] as unknown[],
        bind(...values: unknown[]) {
          stmt.binds = values;
          return stmt;
        },
        async all() {
          if (text.startsWith("SELECT id, hole")) {
            const [scope, scopeKey] = stmt.binds;
            return { results: rows.filter((row) => row.scope === scope && row.scope_key === scopeKey), success: true };
          }
          return { results: [], success: true };
        },
        async first() {
          if (text.startsWith("SELECT COUNT")) {
            const [scope, scopeKey] = stmt.binds;
            const onlyStars = text.includes("highlight = 1");
            const matched = rows.filter((row) => row.scope === scope && row.scope_key === scopeKey && (!onlyStars || row.highlight === 1));
            return { n: matched.length };
          }
          if (text.includes("filmed_by = ? AND client_id = ?")) {
            const [scope, scopeKey, actor, clientId] = stmt.binds;
            return rows.find((row) => row.scope === scope && row.scope_key === scopeKey && row.filmed_by === actor && row.client_id === clientId) ?? null;
          }
          if (text.startsWith("SELECT id, hole")) {
            const [id, scope, scopeKey] = stmt.binds;
            return rows.find((row) => row.id === id && row.scope === scope && row.scope_key === scopeKey) ?? null;
          }
          return null;
        },
        async run() {
          if (text.startsWith("INSERT")) {
            const [scope, scopeKey, hole, playerName, playerIndex, filmedBy, r2Key, contentType, bytes, highlight, moment, clientId, roundGeneration] = stmt.binds;
            if (clientId && rows.some((row) => row.scope === scope && row.scope_key === scopeKey && row.filmed_by === filmedBy && row.client_id === clientId)) {
              return { success: true, results: [], meta: { changes: 0 } };
            }
            const id = nextId++;
            rows.push({
              id, scope, scope_key: scopeKey, hole, player_name: playerName, player_index: playerIndex,
              filmed_by: filmedBy, r2_key: r2Key, content_type: contentType, bytes, highlight, moment,
              created_at: "2026-11-02", client_id: clientId, visibility: "private", round_generation: roundGeneration,
            });
            return { success: true, results: [], meta: { last_row_id: id, changes: 1 } };
          }
          if (text.startsWith("UPDATE")) {
            const [highlight, moment, id, scope, scopeKey] = stmt.binds;
            const row = rows.find((item) => item.id === id && item.scope === scope && item.scope_key === scopeKey);
            if (row) {
              row.highlight = highlight;
              row.moment = moment;
            }
            return { success: true, results: [] };
          }
          if (text.startsWith("DELETE")) {
            const [id, scope, scopeKey] = stmt.binds;
            const index = rows.findIndex((item) => item.id === id && item.scope === scope && item.scope_key === scopeKey);
            if (index >= 0) rows.splice(index, 1);
            return { success: true, results: [] };
          }
          return { success: true, results: [] };
        },
      };
      return stmt;
    },
  };
}

function photos() {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    objects,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: value, type: opts?.httpMetadata?.contentType || "" });
    },
    async head(key: string) {
      const found = objects.get(key);
      if (!found) return null;
      return { size: found.bytes.byteLength, httpMetadata: { contentType: found.type } };
    },
    async get(key: string, options?: { range?: { offset?: number; length?: number } }) {
      const found = objects.get(key);
      if (!found) return null;
      const size = found.bytes.byteLength;
      const range = options && options.range;
      if (range && typeof range.offset === "number") {
        const offset = range.offset;
        const length = range.length == null ? size - offset : range.length;
        return { body: found.bytes.slice(offset, offset + length), size, range: { offset, length }, httpMetadata: { contentType: found.type } };
      }
      return { body: found.bytes, size, httpMetadata: { contentType: found.type } };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

function env() {
  return { DB: memoryDb(), PHOTOS: photos(), RATELIMIT: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
}

describe("throw clip rules", () => {
  it("sniffs webm and mp4 and rejects a jpeg", () => {
    expect(sniffVideo(webm())?.ext).toBe("webm");
    const mp4 = new Uint8Array(12);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    expect(sniffVideo(mp4)?.contentType).toBe("video/mp4");
    expect(sniffVideo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it("answers the byte range Safari asks for before it will play", () => {
    expect(byteRange(null, 100)).toBeNull();
    expect(byteRange("bytes=0-1", 40)).toEqual({ offset: 0, length: 2 });
    expect(byteRange("bytes=8-", 40)).toEqual({ offset: 8, length: 32 });
    expect(byteRange("bytes=-4", 40)).toEqual({ offset: 36, length: 4 });
    expect(byteRange("bytes=40-50", 40)).toBe("invalid");
  });

  it("only accepts a player who is on the live card", () => {
    expect(clipTarget(CARD, 7, 1, "Jane Doe")).toEqual({ ok: true, name: "Jane Doe" });
    expect(clipTarget(CARD, 7, 1, "Jane Doe (you)").ok).toBe(false);
    expect(clipTarget(CARD, 3, 1, "").ok).toBe(false);
    expect(clipTarget({ ...CARD, status: "final" }, 7, 1, "").ok).toBe(true);
    expect(cardFromMine(200, { status: "live", holes: [{ hole: 7 }], cardmates: [{ index: 1, name: "Jane Doe" }] })?.cardmates[0]?.name).toBe("Jane Doe");
  });

  it("stores a clip and lists it back without the filmer id", async () => {
    const used = env();
    const response = await handleThrowClips({
      request: new Request("https://w/rounds/ABCD/live/clips?hole=7&playerIndex=1&playerName=Jane%20Doe&highlight=1&moment=ace", {
        method: "POST",
        body: webm().buffer as ArrayBuffer,
      }),
      env: used,
      origin: "https://gvdgclub.com",
      method: "POST",
      scope: "round",
      scopeKey: "ABCD",
      tail: [],
      authMember: "m_jane",
      card: CARD,
    });
    expect(response.status).toBe(201);
    const saved = await response.json() as { id: number; highlight: boolean; moment: string };
    expect(saved.highlight).toBe(true);
    expect(saved.moment).toBe("ace");

    const list = await handleThrowClips({
      request: new Request("https://w/rounds/ABCD/live/clips"),
      env: used,
      origin: null,
      method: "GET",
      scope: "round",
      scopeKey: "ABCD",
      tail: [],
      authMember: "m_jane",
      card: null,
    });
    const body = await list.json() as { clips: { playerName: string; mediaPath: string; filmed_by?: string }[] };
    expect(body.clips[0]?.playerName).toBe("Jane Doe");
    expect(body.clips[0]?.mediaPath).toBe("/rounds/ABCD/live/clips/" + saved.id + "/media");
    expect(JSON.stringify(body)).not.toMatch(/m_jane/);
  });

  it("serves a clip as a byte range so Apple can play it", async () => {
    const used = env();
    const savedResponse = await handleThrowClips({
      request: new Request("https://w/rounds/ABCD/live/clips?hole=7&playerIndex=1&playerName=Jane%20Doe", {
        method: "POST",
        body: webm().buffer as ArrayBuffer,
      }),
      env: used,
      origin: "https://gvdgclub.com",
      method: "POST",
      scope: "round",
      scopeKey: "ABCD",
      tail: [],
      authMember: "m_jane",
      card: CARD,
    });
    const saved = await savedResponse.json() as { id: number };
    const media = await handleThrowClips({
      request: new Request("https://w/rounds/ABCD/live/clips/" + saved.id + "/media", {
        headers: { Range: "bytes=0-3" },
      }),
      env: used,
      origin: "https://gvdgclub.com",
      method: "GET",
      scope: "round",
      scopeKey: "ABCD",
      tail: [String(saved.id), "media"],
      authMember: "m_jane",
      card: null,
    });
    expect(media.status).toBe(206);
    expect(media.headers.get("Accept-Ranges")).toBe("bytes");
    expect(media.headers.get("Content-Range")).toBe("bytes 0-3/40");
    expect(media.headers.get("Content-Type")).toBe("video/webm");
    const bytes = new Uint8Array(await media.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });
});

describe("throw clip recovery", () => {
  it("deduplicates interrupted/concurrent POSTs and scopes clip IDs to the authenticated actor and original card", async () => {
    const db = memoryDb();
    const bucket = photos();
    const testEnv = { ...env(), DB: db, PHOTOS: bucket } as unknown as Env;
    const clientId = "90e04432-2cd8-4da8-a666-5a585249d948";
    const card = { ...CARD, recoveryRoundId: "round-1", cardId: "c1", actorIndex: 1 };
    function post(actor: string, uploadCard = card, recoveryRoundId = card.recoveryRoundId) {
      const query = new URLSearchParams({
        hole: "7", playerIndex: "1", clientId, recoveryRoundId, recoveryCardId: "c1", recoveryActorIndex: "1",
      });
      return handleThrowClips({
        request: new Request("https://test/clips?" + query, { method: "POST", body: webm().buffer as ArrayBuffer }),
        env: testEnv, origin: null, method: "POST", scope: "round", scopeKey: "TEST", tail: [], card: uploadCard, authMember: actor,
      });
    }
    const firstPair = await Promise.all([post("ana"), post("ana")]);
    expect(firstPair.map((response) => response.status).sort()).toEqual([200, 201]);
    const retry = await post("ana", { ...card, status: "final" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: 1, mediaPath: "/rounds/TEST/live/clips/1/media" });
    expect(db.rows).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
    expect((await post("cam", { ...card, actorIndex: 2 })).status).toBe(409);
    expect((await post("ana", { ...card, recoveryRoundId: "round-2" })).status).toBe(409);
    expect((await post("cam")).status).toBe(201);
    expect(db.rows).toHaveLength(2);
    expect(bucket.objects.size).toBe(2);
  });
});
