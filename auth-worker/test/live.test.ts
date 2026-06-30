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

type ConflictRow = {
  readonly cardId: string | null;
  readonly playerIndex: number;
  readonly playerName: string;
  readonly hole: number;
  readonly values: number[];
};
type SnapshotBody = {
  readonly players: { readonly scores: Record<string, number> }[];
  readonly conflicts: ConflictRow[];
};

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

  it("lets cardmates enter guest-token scorecards but not another member's scorecard", async () => {
    const live = liveDO();
    await start(live, [
      { memberId: "m0", name: "A" },
      { memberId: "g_guest", name: "Guest" },
      { memberId: "m1", name: "B" },
    ]);
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m0" } }))).json()) as { cardmates: { name: string; canEnterScorecard: boolean }[] };
    expect(mine.cardmates.map((c) => [c.name, c.canEnterScorecard])).toEqual([["A", true], ["Guest", true], ["B", false]]);
    expect((await post(live, { "X-Auth-Member": "m0" }, { index: 0, scorerIndex: 1, hole: 1, strokes: 3 })).status).toBe(200);
    expect((await post(live, { "X-Auth-Member": "m0" }, { index: 0, scorerIndex: 2, hole: 1, strokes: 3 })).status).toBe(403);
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

  it("keeps a player/hole conflicted until all cardmate scorecards match", async () => {
    const state = new FakeState({});
    const live = new LiveEventDO(state, { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }] }) }));
    const sock = new FakeSocket();
    state.acceptWebSocket(sock as unknown as WebSocket);
    sock.sent.length = 0;
    const first = (await (await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 3 }) }))).json()) as SnapshotBody;
    expect(first.conflicts).toEqual([]);
    expect(first.players[1]?.scores).toMatchObject({ 1: 3 });

    const disagreed = (await (await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 4 }) }))).json()) as SnapshotBody;
    expect(disagreed.conflicts).toEqual([{ cardId: "c0", playerIndex: 1, playerName: "B", hole: 1, values: [3, 4] }]);
    expect(disagreed.players[1]?.scores).not.toHaveProperty("1");
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m0" } }))).json()) as { conflicts: ConflictRow[] };
    expect(mine.conflicts).toEqual(disagreed.conflicts);
    const conflict = sock.sent.find((m) => m.includes('"type":"conflict"'));
    expect(conflict).toBeTruthy();
    expect(conflict).toContain('"values":[3,4]');

    const matched = (await (await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 3 }) }))).json()) as SnapshotBody;
    expect(matched.conflicts).toEqual([]);
    expect(matched.players[1]?.scores).toMatchObject({ 1: 3 });
  });

  it("lets one scorer edit their own unopposed entry without creating a conflict", async () => {
    const state = new FakeState({});
    const live = new LiveEventDO(state, { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }] }) }));
    const sock = new FakeSocket();
    state.acceptWebSocket(sock as unknown as WebSocket);
    sock.sent.length = 0;

    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 4 }) }));
    const corrected = (await (await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 5 }) }))).json()) as SnapshotBody;
    expect(sock.sent.some((m) => m.includes('"type":"conflict"'))).toBe(false);
    expect(corrected.conflicts).toEqual([]);
    expect(corrected.players[1]?.scores).toMatchObject({ 1: 5 });
  });
});

describe("LiveEventDO casual rounds (self-organizing cards)", () => {
  const startCasual = (live: LiveEventDO, creator: string) =>
    live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }, { hole: 2, par: 3 }], players: [{ memberId: creator, name: "Creator" }] }) }));
  const act = (live: LiveEventDO, path: string, member: string, body: unknown) =>
    live.fetch(new Request("https://do/" + path, { method: "POST", headers: { "X-Auth-Member": member }, body: JSON.stringify(body) }));

  it("a member joins and lands on the single shared card", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    const joined = await act(live, "join", "m_b", { name: "Bee" });
    expect(joined.status).toBe(200);
    const mine = (await joined.json()) as { cardId: string; cardmates: { name: string }[] };
    expect(mine.cardId).toBe("c0");
    expect(mine.cardmates.map((c) => c.name).sort()).toEqual(["Bee", "Creator"]);
  });

  it("anyone on the round may score any cardmate; a stranger cannot", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    expect((await act(live, "score", "m_b", { index: 0, hole: 1, strokes: 3 })).status).toBe(200);
    expect((await act(live, "score", "stranger", { index: 0, hole: 1, strokes: 5 })).status).toBe(403);
  });

  it("a member adds a guest; casual finalize writes nothing to D1", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await startCasual(live, "m_a");
    expect((await act(live, "guest", "m_a", { name: "Walk-on" })).status).toBe(200);
    for (const scorerIndex of [0, 1]) {
      await act(live, "score", "m_a", { index: 0, scorerIndex, hole: 1, strokes: 3 });
      await act(live, "score", "m_a", { index: 0, scorerIndex, hole: 2, strokes: 3 });
      await act(live, "score", "m_a", { index: 1, scorerIndex, hole: 1, strokes: 3 });
      await act(live, "score", "m_a", { index: 1, scorerIndex, hole: 2, strokes: 3 });
    }
    const fin = await act(live, "finalize", "m_a", {});
    expect(fin.status).toBe(200);
    expect(touchedDb).toBe(false);
  });

  it("flags score conflicts from guest scorecards too", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "guest", "m_a", { name: "Walk-on" });
    await act(live, "score", "m_a", { index: 0, scorerIndex: 0, hole: 1, strokes: 3 });

    const disagreed = (await (await act(live, "score", "m_a", { index: 0, scorerIndex: 1, hole: 1, strokes: 4 })).json()) as SnapshotBody;
    expect(disagreed.conflicts).toEqual([{ cardId: "c0", playerIndex: 0, playerName: "Creator", hole: 1, values: [3, 4] }]);
    expect(disagreed.players[0]?.scores).not.toHaveProperty("1");

    const matched = (await (await act(live, "score", "m_a", { index: 0, scorerIndex: 1, hole: 1, strokes: 3 })).json()) as SnapshotBody;
    expect(matched.conflicts).toEqual([]);
    expect(matched.players[0]?.scores).toMatchObject({ 1: 3 });
  });

  it("rejects finalize when a guest scorecard is missing", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await startCasual(live, "m_a");
    await act(live, "guest", "m_a", { name: "Walk-on" });
    await act(live, "score", "m_a", { index: 0, scorerIndex: 0, hole: 1, strokes: 3 });
    await act(live, "score", "m_a", { index: 0, scorerIndex: 0, hole: 2, strokes: 3 });
    await act(live, "score", "m_a", { index: 1, scorerIndex: 0, hole: 1, strokes: 3 });
    await act(live, "score", "m_a", { index: 1, scorerIndex: 0, hole: 2, strokes: 3 });

    const blocked = await act(live, "finalize", "m_a", {});
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: string; conflicts: ConflictRow[]; missing: unknown[] };
    expect(body.error).toBe("scorecards_not_matched");
    expect(body.conflicts).toEqual([]);
    expect(body.missing).toContainEqual(expect.objectContaining({ cardId: "c0", playerIndex: 0, hole: 1, missing: 1, required: 2 }));
    expect(touchedDb).toBe(false);
  });

  it("rejects finalize until every player's card scores match exactly", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    await act(live, "score", "m_a", { index: 0, hole: 1, strokes: 3 });
    await act(live, "score", "m_b", { index: 0, hole: 1, strokes: 4 });
    await act(live, "score", "m_a", { index: 1, hole: 1, strokes: 3 });
    await act(live, "score", "m_b", { index: 1, hole: 1, strokes: 3 });

    const blocked = await act(live, "finalize", "m_a", {});
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: string; conflicts: ConflictRow[]; missing: unknown[] };
    expect(body.error).toBe("scorecards_not_matched");
    expect(body.conflicts).toEqual([{ cardId: "c0", playerIndex: 0, playerName: "Creator", hole: 1, values: [3, 4] }]);
    expect(body.missing.length).toBeGreaterThan(0);
    expect(touchedDb).toBe(false);

    await act(live, "score", "m_b", { index: 0, hole: 1, strokes: 3 });
    await act(live, "score", "m_a", { index: 0, hole: 2, strokes: 3 });
    await act(live, "score", "m_b", { index: 0, hole: 2, strokes: 3 });
    await act(live, "score", "m_a", { index: 1, hole: 2, strokes: 3 });
    await act(live, "score", "m_b", { index: 1, hole: 2, strokes: 3 });

    const finalized = await act(live, "finalize", "m_a", {});
    expect(finalized.status).toBe(200);
    expect(touchedDb).toBe(false);
  });
});
