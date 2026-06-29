import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveEventDO } from "../src/live.js";

type Stored = {
  readonly meta?: unknown;
  readonly players?: unknown;
};

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];

  accept(): void {
    throw new Error("legacy_accept_used");
  }

  send(message: string): void {
    this.sent.push(message);
  }
}

class FakeState {
  readonly accepted: WebSocket[] = [];
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };

  constructor(stored: Stored = {}) {
    this.storage = {
      get: async <T = unknown>(key: string) => stored[key as keyof Stored] as T | undefined,
      put: async () => {},
    };
  }

  acceptWebSocket(socket: WebSocket): void {
    this.accepted.push(socket);
  }

  getWebSockets(): WebSocket[] {
    return this.accepted;
  }
}

const db = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => ({ results: [], success: true }) }) };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveEventDO WebSocket handling", () => {
  it("accepts sockets through Durable Object hibernation APIs and broadcasts snapshots", async () => {
    const state = new FakeState({
      meta: { eventId: 7, holes: [{ hole: 1, par: 3 }], status: "live", startedAt: "2026-06-26T00:00:00Z" },
      players: [{ memberId: "m_jane", name: "Jane", division: null, startingHole: null, scores: {} }],
    });
    const client = new FakeSocket();
    const server = new FakeSocket();
    vi.stubGlobal("Response", class {
      readonly status: number;

      constructor(_body: BodyInit | null = null, init?: ResponseInit) {
        this.status = init?.status ?? 200;
      }
    });
    vi.stubGlobal("WebSocketPair", function WebSocketPair() {
      return { 0: client, 1: server };
    });
    const live = new LiveEventDO(state, { DB: db });

    const upgrade = await live.fetch(new Request("https://do/ws"));
    expect(upgrade.status).toBe(101);
    expect(state.accepted).toEqual([server]);
    expect(server.sent[0]).toContain('"type":"snapshot"');

    const score = await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ index: 0, hole: 1, strokes: 3 }) }));
    expect(score.status).toBe(200);
    expect(server.sent.at(-1)).toContain('"scores":{"1":3}');
  });
});

describe("LiveEventDO card-scoped scoring", () => {
  const liveDO = () => new LiveEventDO(new FakeState({}), { DB: db });
  const start = (live: LiveEventDO, players: unknown[]) =>
    live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ eventId: 1, holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }], players }) }));
  const post = (live: LiveEventDO, headers: Record<string, string>, body: unknown) =>
    live.fetch(new Request("https://do/score", { method: "POST", headers, body: JSON.stringify(body) }));

  it("a cardmate may score within the card; a non-cardmate and a stranger are rejected (403)", async () => {
    const live = liveDO();
    await start(live, Array.from({ length: 8 }, (_, i) => ({ memberId: "m" + i, name: "P" + i }))); // buckets of 4 -> c0, c1
    expect((await post(live, { "X-Auth-Member": "m0" }, { index: 1, hole: 1, strokes: 3 })).status).toBe(200); // m0 scores m1 (both c0)
    expect((await post(live, { "X-Auth-Member": "m0" }, { index: 4, hole: 1, strokes: 3 })).status).toBe(403); // m0 (c0) scores m4 (c1)
    expect((await post(live, { "X-Auth-Member": "ghost" }, { index: 0, hole: 1, strokes: 3 })).status).toBe(403); // not on any card
  });

  it("an admin may score any card", async () => {
    const live = liveDO();
    await start(live, Array.from({ length: 8 }, (_, i) => ({ memberId: "m" + i, name: "P" + i })));
    expect((await post(live, { "X-Auth-Admin": "true" }, { index: 7, hole: 1, strokes: 4 })).status).toBe(200);
  });

  it("redacts memberId from the public snapshot; /mine reveals only the caller's card", async () => {
    const live = liveDO();
    await start(live, ["A", "B", "C", "D", "E"].map((n, i) => ({ memberId: "m" + i, name: n })));
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: Record<string, unknown>[] };
    expect(snap.players[0]).not.toHaveProperty("memberId");
    expect(snap.players[0]).toHaveProperty("cardId");
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m4" } }))).json()) as { playerIndex: number; cardId: string; cardmates: { name: string }[] };
    expect(mine.playerIndex).toBe(4);
    expect(mine.cardId).toBe("c1");
    expect(mine.cardmates.map((c) => c.name)).toEqual(["E"]);
    const mine0 = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m0" } }))).json()) as { cardmates: { name: string }[] };
    expect(mine0.cardmates.map((c) => c.name)).toEqual(["A", "B", "C", "D"]);
  });
});
