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

  it("alerts the card when two scorers disagree on the same player/hole; same-scorer fixes don't", async () => {
    const state = new FakeState({});
    const live = new LiveEventDO(state, { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }] }) }));
    const sock = new FakeSocket();
    state.acceptWebSocket(sock as unknown as WebSocket);
    sock.sent.length = 0;
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 3 }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 4 }) }));
    const conflict = sock.sent.find((m) => m.includes('"type":"conflict"'));
    expect(conflict).toBeTruthy();
    expect(conflict).toContain('"from":3');
    expect(conflict).toContain('"to":4');
    // the same scorer correcting their own entry must NOT raise a conflict
    sock.sent.length = 0;
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 5 }) }));
    expect(sock.sent.some((m) => m.includes('"type":"conflict"'))).toBe(false);
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

  it("a member removes a cardmate (accidental/no-show); they drop off the card", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    await act(live, "guest", "m_a", { name: "Walk-on" }); // [Creator(0), Bee(1), Walk-on(2)]
    const rm = await act(live, "remove", "m_b", { index: 2, name: "Walk-on" });
    expect(rm.status).toBe(200);
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: { name: string }[] };
    expect(snap.players.map((p) => p.name).sort()).toEqual(["Bee", "Creator"]);
  });

  it("a stranger (not on the round) cannot remove a player (403)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    expect((await act(live, "remove", "stranger", { index: 0, name: "Creator" })).status).toBe(403);
  });

  it("a member can remove themselves (leave the round)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    const left = await act(live, "remove", "m_b", { index: 1, name: "Bee" });
    expect(left.status).toBe(200);
    expect(((await left.json()) as { cardId: string | null }).cardId).toBeNull(); // m_b is off the card
    const mineA = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m_a" } }))).json()) as { cardmates: { name: string }[] };
    expect(mineA.cardmates.map((c) => c.name)).toEqual(["Creator"]);
  });

  it("a stale/shifted index whose name no longer matches is rejected (409 player_moved)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    const r = await act(live, "remove", "m_a", { index: 1, name: "Ghost" }); // index 1 is "Bee", not "Ghost"
    expect(r.status).toBe(409);
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: { name: string }[] };
    expect(snap.players.length).toBe(2); // nobody removed
  });

  it("an admin may remove any player", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    const rm = await live.fetch(new Request("https://do/remove", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ index: 0, name: "Creator" }) }));
    expect(rm.status).toBe(200);
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: { name: string }[] };
    expect(snap.players.map((p) => p.name)).toEqual(["Bee"]);
  });

  it("removal tombstones (no index shift): scoring an unchanged index still targets the right player", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a"); // Creator @ index 0
    await act(live, "join", "m_b", { name: "Bee" }); // Bee @ index 1
    await act(live, "guest", "m_a", { name: "Cat" }); // Cat @ index 2
    expect((await act(live, "remove", "m_a", { index: 1, name: "Bee" })).status).toBe(200);
    // index 2 must STILL be Cat (not shifted down to index 1) — score it and confirm it landed on Cat.
    expect((await act(live, "score", "m_a", { index: 2, hole: 1, strokes: 3 })).status).toBe(200);
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: { index: number; name: string; scores: Record<string, number> }[] };
    const cat = snap.players.find((p) => p.index === 2);
    expect(cat?.name).toBe("Cat");
    expect(cat?.scores["1"]).toBe(3);
    expect(snap.players.some((p) => p.name === "Bee")).toBe(false); // Bee is gone from the card
  });

  it("a removed player can no longer be scored (404)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" }); // index 1
    await act(live, "remove", "m_a", { index: 1, name: "Bee" });
    expect((await act(live, "score", "m_a", { index: 1, hole: 1, strokes: 4 })).status).toBe(404);
  });

  it("a removed member rejoining reactivates their slot with a fresh card", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    await act(live, "score", "m_b", { index: 1, hole: 1, strokes: 2 }); // Bee has a score
    await act(live, "remove", "m_b", { index: 1, name: "Bee" }); // Bee leaves
    const rejoined = await act(live, "join", "m_b", { name: "Bee" });
    const mine = (await rejoined.json()) as { cardId: string | null; cardmates: { name: string; scores: Record<string, number> }[] };
    expect(mine.cardId).toBe("c0"); // back on the card
    const bee = mine.cardmates.find((c) => c.name === "Bee");
    expect(bee?.scores["1"]).toBeUndefined(); // fresh card, old score cleared
  });

  it("a member adds a guest; casual finalize writes nothing to D1", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await startCasual(live, "m_a");
    expect((await act(live, "guest", "m_a", { name: "Walk-on" })).status).toBe(200);
    const fin = await act(live, "finalize", "m_a", {});
    expect(fin.status).toBe(200);
    expect(touchedDb).toBe(false);
  });
});
