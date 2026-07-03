// allow: SIZE_OK - cohesive Durable Object regression suite; split with the LiveEventDO refactor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveEventDO } from "../src/live.js";

type Stored = {
  readonly meta?: unknown;
  readonly players?: unknown;
};

class FakeSocket extends EventTarget {
  readonly CLOSED = 3;
  readonly CLOSING = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly binaryType = "blob";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "";
  readonly readyState = 1;
  readonly sent: string[] = [];
  readonly url = "";
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;

  accept(): void {
    throw new Error("legacy_accept_used");
  }

  close(): void {}

  serializeAttachment(_attachment: unknown): void {}

  deserializeAttachment(): unknown | null {
    return null;
  }

  send(message: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(typeof message === "string" ? message : String(message));
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
type ResetSnapshot = SnapshotBody & {
  readonly status: string;
  readonly rev: number;
};
type WeatherSnapshot = {
  readonly weather: {
    readonly location: { readonly label: string | null };
    readonly current: {
      readonly observedAt: string;
      readonly rainIn: number | null;
      readonly windSpeedMph: number | null;
      readonly windGustMph: number | null;
    } | null;
    readonly history: readonly {
      readonly observedAt: string;
      readonly windSpeedMph: number | null;
      readonly windGustMph: number | null;
    }[];
    readonly error: string | null;
  } | null;
};
type FormatSnapshot = {
  readonly format: string;
  readonly playFormat: string;
  readonly teamRequired: boolean;
  readonly players: readonly { readonly name: string; readonly team: string | null }[];
  readonly standings: readonly {
    readonly name: string;
    readonly team: string | null;
    readonly holesWon?: number;
    readonly holesLost?: number;
    readonly matchPoints?: number;
    readonly matchLabel?: string;
  }[];
};

function openMeteoSample(observedAt: string, windSpeedMph: number, rainIn: number): Record<string, unknown> {
  return {
    current: {
      time: observedAt,
      temperature_2m: 82,
      apparent_temperature: 87,
      relative_humidity_2m: 72,
      precipitation: rainIn,
      rain: rainIn,
      showers: 0,
      snowfall: 0,
      weather_code: rainIn > 0 ? 61 : 1,
      cloud_cover: 44,
      wind_speed_10m: windSpeedMph,
      wind_direction_10m: 180,
      wind_gusts_10m: windSpeedMph + 6,
      is_day: 1,
    },
  };
}

function stubWeather(samples: readonly Record<string, unknown>[]): void {
  let nextIndex = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const sample = samples[nextIndex] ?? samples[samples.length - 1] ?? openMeteoSample("2026-07-01T08:00", 0, 0);
    nextIndex++;
    return new Response(JSON.stringify(sample));
  }));
}

function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(label);
  return value;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
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

  it("rejects starting an already-live round so existing scores are not wiped", async () => {
    const live = liveDO();
    await start(live, [{ memberId: "m0", name: "A" }]);
    await post(live, { "X-Auth-Admin": "true" }, { index: 0, hole: 1, strokes: 3 });

    const restarted = await start(live, [{ memberId: "m0", name: "A" }]);
    expect(restarted.status).toBe(409);

    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { readonly players: readonly { readonly scores: Record<string, number> }[] };
    expect(snap.players[0]?.scores).toEqual({ 1: 3 });
  });

  it("cancels a live scorecard back to unstarted and allows a fresh start without stale revisions", async () => {
    const live = liveDO();
    await start(live, [{ memberId: "m0", name: "A" }]);
    const scored = (await (await post(live, { "X-Auth-Admin": "true" }, { index: 0, hole: 1, strokes: 3 })).json()) as ResetSnapshot;

    const cancelled = await live.fetch(new Request("https://do/cancel", { method: "POST", headers: { "X-Auth-Admin": "true" } }));
    expect(cancelled.status).toBe(200);
    const cancelledBody = (await cancelled.json()) as ResetSnapshot;
    expect(cancelledBody.status).toBe("none");
    expect(cancelledBody.players).toEqual([]);
    expect(cancelledBody.rev).toBeGreaterThan(scored.rev);
    expect((await post(live, { "X-Auth-Admin": "true" }, { index: 0, hole: 1, strokes: 3 })).status).toBe(409);

    const restarted = (await (await start(live, [{ memberId: "m0", name: "A" }])).json()) as ResetSnapshot;
    expect(restarted.status).toBe("live");
    expect(restarted.rev).toBeGreaterThan(cancelledBody.rev);
    expect(restarted.players[0]?.scores).toEqual({});
  });

  it("does not cancel a finalized scorecard", async () => {
    const live = new LiveEventDO(new FakeState({
      meta: { eventId: 1, holes: [{ hole: 1, par: 3 }], status: "final", startedAt: "" },
      players: [],
    }), { DB: db });

    const cancelled = await live.fetch(new Request("https://do/cancel", { method: "POST", headers: { "X-Auth-Admin": "true" } }));
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: "round_already_final" });
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

  it("scores doubles matchplay snapshots as team match standings", async () => {
    const live = liveDO();
    await live.fetch(new Request("https://do/start", {
      method: "POST",
      body: JSON.stringify({
        eventId: 1,
        format: "matchplay",
        playFormat: "doubles",
        teamRequired: true,
        holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }, { hole: 3, par: 3 }],
        players: [
          { memberId: "r1", name: "Red 1", team: "Red" },
          { memberId: "r2", name: "Red 2", team: "Red" },
          { memberId: "b1", name: "Blue 1", team: "Blue" },
          { memberId: "b2", name: "Blue 2", team: "Blue" },
        ],
      }),
    }));
    await post(live, { "X-Auth-Admin": "true" }, { index: 0, hole: 1, strokes: 3 });
    await post(live, { "X-Auth-Admin": "true" }, { index: 2, hole: 1, strokes: 4 });
    await post(live, { "X-Auth-Admin": "true" }, { index: 0, hole: 2, strokes: 5 });
    await post(live, { "X-Auth-Admin": "true" }, { index: 2, hole: 2, strokes: 4 });
    await post(live, { "X-Auth-Admin": "true" }, { index: 0, hole: 3, strokes: 3 });
    await post(live, { "X-Auth-Admin": "true" }, { index: 2, hole: 3, strokes: 4 });

    const snap = (await (await live.fetch(new Request("https://do/snapshot"))).json()) as FormatSnapshot;

    expect(snap).toMatchObject({ format: "matchplay", playFormat: "doubles", teamRequired: true });
    expect(snap.players.map((p) => [p.name, p.team])).toEqual([
      ["Red 1", "Red"],
      ["Red 2", "Red"],
      ["Blue 1", "Blue"],
      ["Blue 2", "Blue"],
    ]);
    expect(snap.standings).toHaveLength(2);
    expect(snap.standings[0]).toMatchObject({ name: "Red", team: "Red", holesWon: 2, holesLost: 1, matchPoints: 1, matchLabel: "+1" });
    expect(snap.standings[1]).toMatchObject({ name: "Blue", team: "Blue", holesWon: 1, holesLost: 2, matchPoints: -1, matchLabel: "-1" });
  });

  it("keeps a player/hole conflicted until all cardmate scorecards match", async () => {
    const state = new FakeState({});
    const live = new LiveEventDO(state, { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }] }) }));
    const sock = new FakeSocket();
    state.acceptWebSocket(sock);
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

  it("blocks competition finalization when a non-member scorecard disagrees", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await start(live, [{ memberId: "m0", name: "A" }, { memberId: null, name: "Walk-on" }]);
    await post(live, { "X-Auth-Member": "m0" }, { index: 0, scorerIndex: 0, hole: 1, strokes: 3 });
    const disagreed = (await (await post(live, { "X-Auth-Member": "m0" }, { index: 0, scorerIndex: 1, hole: 1, strokes: 4 })).json()) as SnapshotBody;
    expect(disagreed.conflicts).toEqual([{ cardId: "c0", playerIndex: 0, playerName: "A", hole: 1, values: [3, 4] }]);
    expect(disagreed.players[0]?.scores).not.toHaveProperty("1");

    const blocked = await live.fetch(new Request("https://do/finalize", { method: "POST" }));
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: string; conflicts: ConflictRow[]; missing: unknown[] };
    expect(body.error).toBe("scorecard_incomplete");
    expect(body.conflicts).toContainEqual({ cardId: "c0", playerIndex: 0, playerName: "A", hole: 1, values: [3, 4] });
    expect(touchedDb).toBe(false);
  });

  it("exposes per-scorer votes (scorecards) in snapshot + /mine so a scorer can see/edit their own vote in a conflict", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }] }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 3 }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 4 }) }));
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: { index: number; scores: Record<string, number>; scorecards: Record<string, Record<string, number>> }[] };
    const target = defined(snap.players.find((p) => p.index === 1), "target_player_missing");
    expect(target.scores).not.toHaveProperty("1"); // consensus blank during conflict…
    expect(target.scorecards["1"]).toEqual({ "player:0": 3, "player:1": 4 }); // …but each scorer's own vote is visible
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m0" } }))).json()) as { cardmates: { index: number; scorecards: Record<string, Record<string, number>> }[] };
    const cardmate = defined(mine.cardmates.find((c) => c.index === 1), "target_cardmate_missing");
    expect(cardmate.scorecards["1"]).toEqual({ "player:0": 3, "player:1": 4 });
  });

  it("ignores a removed scorer's stale cross-vote so the conflict auto-resolves on removal (no deadlock)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }, { memberId: "m2", name: "X" }] }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m2" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 5 }) })); // X votes 5 on B
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 3 }) })); // A votes 3 on B → conflict [3,5]
    expect(((await (await live.fetch(new Request("https://do/"))).json()) as SnapshotBody).conflicts.length).toBe(1);
    await live.fetch(new Request("https://do/remove", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 2, name: "X" }) })); // X leaves
    const resolved = (await (await live.fetch(new Request("https://do/"))).json()) as { conflicts: ConflictRow[]; players: { index: number; scores: Record<string, number> }[] };
    expect(resolved.conflicts).toEqual([]); // X's stale 5-vote is purged → A's 3 stands
    expect(resolved.players.find((p) => p.index === 1)?.scores).toMatchObject({ 1: 3 });
  });

  it("preserves cardmates' scores when the sole scorekeeper is removed (no data loss); finalize then needs confirmation or an admin force", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }, { memberId: "m2", name: "C" }] }) }));
    // A is the sole scorekeeper — enters everyone's score on A's own card (scorerIndex defaults to A=0).
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 4 }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 2, hole: 1, strokes: 5 }) }));
    await live.fetch(new Request("https://do/remove", { method: "POST", headers: { "X-Auth-Member": "m1" }, body: JSON.stringify({ index: 0, name: "A" }) })); // A leaves
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { players: { name: string; scores: Record<string, number> }[] };
    expect(snap.players.find((p) => p.name === "B")?.scores).toMatchObject({ 1: 4 }); // survived A's departure — NO DATA LOSS
    expect(snap.players.find((p) => p.name === "C")?.scores).toMatchObject({ 1: 5 });
    // With the only scorekeeper gone, no remaining MEMBER has confirmed a score → the card isn't agreed.
    const blocked = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Member": "m1" } }));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe("scorecard_incomplete");
    expect(touchedDb).toBe(false);
    // An admin may FORCE it through, locking the preserved scores as they stand (B & C ranked, not DNF-wiped).
    const forced = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ force: true }) }));
    expect(forced.status).toBe(200);
    const fb = (await forced.json()) as { status: string; forced: boolean; standings: { name: string; place: number | null }[] };
    expect(fb.status).toBe("final");
    expect(fb.forced).toBe(true);
    expect(fb.standings.find((s) => s.name === "B")?.place).not.toBeNull();
  });

  it("seeds legacy scores under a single marker so a single-scorer correction doesn't phantom-conflict", async () => {
    const state = new FakeState({
      meta: { eventId: 0, casual: true, holes: [{ hole: 1, par: 3 }], status: "live", startedAt: "" },
      players: [
        { memberId: "m0", name: "A", scores: { 1: 4 } },
        { memberId: "m1", name: "B", scores: { 1: 4 } },
      ],
    });
    const live = new LiveEventDO(state, { DB: db });
    const seeded = (await (await live.fetch(new Request("https://do/"))).json()) as SnapshotBody;
    expect(seeded.conflicts).toEqual([]); // legacy migration must NOT fabricate a cardmate conflict
    expect(seeded.players[1]?.scores).toMatchObject({ 1: 4 }); // legacy score preserved on load
    const corrected = (await (await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 1, hole: 1, strokes: 3 }) }))).json()) as SnapshotBody;
    expect(corrected.conflicts).toEqual([]); // A's correction supersedes the legacy marker — no phantom conflict
    expect(corrected.players[1]?.scores).toMatchObject({ 1: 3 });
  });

  it("snapshot carries a monotonic rev that bumps on each mutation (stale-snapshot guard)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }] }) }));
    const a = (await (await live.fetch(new Request("https://do/"))).json()) as { rev: number };
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m0" }, body: JSON.stringify({ index: 0, hole: 1, strokes: 3 }) }));
    const b = (await (await live.fetch(new Request("https://do/"))).json()) as { rev: number };
    expect(typeof a.rev).toBe("number");
    expect(b.rev).toBeGreaterThan(a.rev);
  });

  it("lets one scorer edit their own unopposed entry without creating a conflict", async () => {
    const state = new FakeState({});
    const live = new LiveEventDO(state, { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m0", name: "A" }, { memberId: "m1", name: "B" }] }) }));
    const sock = new FakeSocket();
    state.acceptWebSocket(sock);
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

  it("carries hole distance + course/layout name through to the snapshot and /mine", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({
      casual: true, courseName: "North Rec", layoutName: "Blue",
      holes: [{ hole: 1, par: 3, distance_ft: 250, tee_sign_id: 77 }, { hole: 2, par: 4, distance_ft: 410 }],
      players: [{ memberId: "m_a", name: "A" }],
    }) }));
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { courseName: string; layoutName: string; holes: { hole: number; distance_ft: number | null; tee_sign_id: number | null }[] };
    expect(snap.courseName).toBe("North Rec");
    expect(snap.layoutName).toBe("Blue");
    expect(snap.holes.find((h) => h.hole === 1)?.distance_ft).toBe(250);
    expect(snap.holes.find((h) => h.hole === 1)?.tee_sign_id).toBe(77);
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m_a" } }))).json()) as { courseName: string; layoutName: string; holes: { hole: number; distance_ft: number | null; tee_sign_id: number | null }[] };
    expect(mine.courseName).toBe("North Rec");
    expect(mine.layoutName).toBe("Blue");
    expect(mine.holes.find((h) => h.hole === 2)?.distance_ft).toBe(410);
    expect(mine.holes.find((h) => h.hole === 1)?.tee_sign_id).toBe(77);
  });

  it("captures weather at start and appends changed conditions during scoring", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    stubWeather([
      openMeteoSample("2026-07-01T08:00", 6.5, 0),
      openMeteoSample("2026-07-01T08:15", 18.2, 0.2),
    ]);
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    const started = await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({
      casual: true,
      courseName: "North Rec",
      holes: [{ hole: 1, par: 3 }],
      players: [{ memberId: "m_a", name: "A" }],
      weatherLocation: { lat: 35.631092, lng: -77.319923, label: "North Rec - Greenville, NC" },
    }) }));
    const startBody = (await started.json()) as WeatherSnapshot;
    expect(startBody.weather?.location.label).toBe("North Rec - Greenville, NC");
    expect(startBody.weather?.current?.windSpeedMph).toBe(6.5);
    expect(startBody.weather?.current?.windGustMph).toBe(12.5);
    expect(startBody.weather?.history.map((sample) => sample.observedAt)).toEqual(["2026-07-01T08:00"]);

    vi.setSystemTime(new Date("2026-07-01T12:11:00.000Z"));
    const scored = await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ index: 0, scorerIndex: 0, hole: 1, strokes: 3 }) }));
    const scoredBody = (await scored.json()) as WeatherSnapshot;
    expect(scoredBody.weather?.current).toMatchObject({ observedAt: "2026-07-01T08:15", rainIn: 0.2, windSpeedMph: 18.2, windGustMph: 24.2 });
    expect(scoredBody.weather?.history.map((sample) => sample.windSpeedMph)).toEqual([6.5, 18.2]);
    expect(scoredBody.weather?.history.map((sample) => sample.windGustMph)).toEqual([12.5, 24.2]);
    expect(scoredBody.weather?.error).toBeNull();
  });

  it("backfills weather for a live round that started before weather tracking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    stubWeather([openMeteoSample("2026-07-01T08:00", 7.5, 0.1)]);
    const live = new LiveEventDO(new FakeState({
      meta: {
        eventId: 7,
        holes: [{ hole: 1, par: 3 }],
        status: "live",
        startedAt: "2026-07-01T11:30:00.000Z",
      },
      players: [{ memberId: "m_a", name: "A", division: null, startingHole: null, scores: {} }],
    }), { DB: db });

    const filled = await live.fetch(new Request("https://do/weather", { method: "POST", body: JSON.stringify({
      weatherLocation: { lat: 35.631092, lng: -77.319923, label: "North Rec - Greenville, NC" },
    }) }));
    const body = (await filled.json()) as WeatherSnapshot;
    expect(body.weather?.location.label).toBe("North Rec - Greenville, NC");
    expect(body.weather?.current).toMatchObject({ observedAt: "2026-07-01T08:00", rainIn: 0.1, windSpeedMph: 7.5, windGustMph: 13.5 });
    expect(body.weather?.history.map((sample) => sample.observedAt)).toEqual(["2026-07-01T08:00"]);
  });

  it("a member adds a guest; a casual round with NO share code writes no D1 EVENT results", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await startCasual(live, "m_a"); // startCasual passes no roundCode → no durable casual persistence either
    expect((await act(live, "guest", "m_a", { name: "Walk-on" })).status).toBe(200);
    for (const scorerIndex of [0, 1]) {
      await act(live, "score", "m_a", { index: 0, scorerIndex, hole: 1, strokes: 3 });
      await act(live, "score", "m_a", { index: 0, scorerIndex, hole: 2, strokes: 3 });
      await act(live, "score", "m_a", { index: 1, scorerIndex, hole: 1, strokes: 3 });
      await act(live, "score", "m_a", { index: 1, scorerIndex, hole: 2, strokes: 3 });
    }
    const fin = await act(live, "finalize", "m_a", {});
    expect(fin.status).toBe(200);
    expect(touchedDb).toBe(false); // never touches the event `results` path (durable casual persistence needs a roundCode — see next test)
  });

  it("a casual round WITH a share code persists a durable casual_rounds + casual_results record on finalize", async () => {
    const inserts: { sql: string; args: unknown[] }[] = [];
    const recDb = {
      prepare(sql: string) {
        const entry = { sql, args: [] as unknown[] };
        return {
          bind(...args: unknown[]) { entry.args = args; if (/INSERT INTO casual_|DELETE FROM casual_rounds/i.test(sql)) inserts.push(entry); return this; },
          run: async () => ({ results: [], success: true }),
          first: async <T = Record<string, unknown>>() => (/INSERT INTO casual_rounds/i.test(sql) ? { id: 7 } as T : null),
          all: async () => ({ results: [], success: true }),
        };
      },
    };
    const live = new LiveEventDO(new FakeState({}), { DB: recDb });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, roundCode: "AB23CD", courseId: 3, layoutId: 5, courseName: "North Rec", layoutName: "Blue", createdBy: "m_a", holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }], players: [{ memberId: "m_a", name: "A" }] }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m_a" }, body: JSON.stringify({ index: 0, hole: 1, strokes: 3 }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m_a" }, body: JSON.stringify({ index: 0, hole: 2, strokes: 4 }) }));
    const fin = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Member": "m_a" } }));
    expect(fin.status).toBe(200);
    const delIdx = inserts.findIndex((i) => /DELETE FROM casual_rounds/i.test(i.sql));
    const roundIdx = inserts.findIndex((i) => /INSERT INTO casual_rounds/i.test(i.sql));
    const roundIns = defined(inserts[roundIdx], "casual_round_insert_missing");
    const resIns = defined(inserts.find((i) => /INSERT INTO casual_results/i.test(i.sql)), "casual_result_insert_missing");
    // Idempotency guard: a DELETE-by-round_code runs BEFORE the header insert so a fault/retry replaces
    // (never duplicates) the round — the casual analogue of the competition path's clearResults.
    expect(delIdx).toBeGreaterThanOrEqual(0);
    const deleteIns = defined(inserts[delIdx], "casual_round_delete_missing");
    expect(deleteIns.args).toContain("AB23CD");
    expect(roundIdx).toBeGreaterThan(delIdx);
    expect(roundIns.args).toContain("AB23CD"); // round_code = the durable key
    expect(roundIns.args).toContain(5); // layout_id — kept so the ratings engine can compute a per-layout SSA
    expect(resIns.args[0]).toBe(7); // casual_round_id FK = the id returned by createCasualRound
    expect(resIns.args).toContain("A"); // player name persisted
  });

  it("stores casual round ratings from a cached layout SSA without writing event results", async () => {
    const resultInserts: unknown[][] = [];
    const ratingInserts: unknown[][] = [];
    const recDb = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          run: async () => {
            if (/INSERT INTO round_ratings/i.test(sql)) ratingInserts.push(args);
            return { results: [], success: true };
          },
          first: async <T = Record<string, unknown>>() => {
            if (/SELECT ssa, ppt, propagator_count FROM layout_ssa/i.test(sql)) return { ssa: 10, ppt: 29.70245, propagator_count: 3 } as T;
            if (/INSERT INTO casual_rounds/i.test(sql)) return { id: 7 } as T;
            if (/INSERT INTO results/i.test(sql)) resultInserts.push(args);
            return null;
          },
          all: async () => ({ results: [], success: true }),
        };
      },
    };
    const live = new LiveEventDO(new FakeState({}), { DB: recDb });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({
      casual: true,
      roundCode: "ABC123",
      layoutId: 5,
      holes: [{ hole: 1, par: 10 }],
      players: [{ memberId: "m_a", name: "A" }],
    }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m_a" }, body: JSON.stringify({ index: 0, scorerIndex: 0, hole: 1, strokes: 10 }) }));

    const fin = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Member": "m_a" } }));
    expect(fin.status).toBe(200);
    expect(resultInserts).toEqual([]);
    expect(ratingInserts).toHaveLength(1);
    expect(ratingInserts[0]).toContain("casual");
    expect(ratingInserts[0]).toContain("ABC123");
    expect(ratingInserts[0]).toContain(1000);
  });

  it("stores gusts and weather adjustment on layout-rated casual rounds", async () => {
    stubWeather([openMeteoSample("2026-07-01T08:00", 32, 0)]);
    const ratingInserts: unknown[][] = [];
    const recDb = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          run: async () => {
            if (/INSERT INTO round_ratings/i.test(sql)) ratingInserts.push(args);
            return { results: [], success: true };
          },
          first: async <T = Record<string, unknown>>() => {
            if (/SELECT ssa, ppt, propagator_count FROM layout_ssa/i.test(sql)) return { ssa: 54, ppt: 10, propagator_count: 3 } as T;
            if (/INSERT INTO casual_rounds/i.test(sql)) return { id: 7 } as T;
            return null;
          },
          all: async () => ({ results: [], success: true }),
        };
      },
    };
    const live = new LiveEventDO(new FakeState({}), { DB: recDb });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({
      casual: true,
      roundCode: "ABC123",
      layoutId: 5,
      holes: [{ hole: 1, par: 27 }, { hole: 2, par: 30 }],
      players: [{ memberId: "m_a", name: "A" }],
      weatherLocation: { lat: 35.631092, lng: -77.319923, label: "North Rec" },
    }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m_a" }, body: JSON.stringify({ index: 0, scorerIndex: 0, hole: 1, strokes: 27 }) }));
    await live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Member": "m_a" }, body: JSON.stringify({ index: 0, scorerIndex: 0, hole: 2, strokes: 30 }) }));

    const fin = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Member": "m_a" } }));
    expect(fin.status).toBe(200);
    expect(ratingInserts).toHaveLength(1);
    expect(ratingInserts[0]).toContain(977);
    expect(ratingInserts[0]).toContain(54.7);
    expect(ratingInserts[0]).toContain(38);
    expect(ratingInserts[0]).toContain(0.7);
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

  it("finalizes when only a walk-on GUEST hasn't kept a card (guests are optional; the sole member scored everyone)", async () => {
    let touchedDb = false;
    const trackDb = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [], success: true }), first: async () => null, run: async () => { touchedDb = true; return { results: [], success: true }; } }) };
    const live = new LiveEventDO(new FakeState({}), { DB: trackDb });
    await startCasual(live, "m_a");
    await act(live, "guest", "m_a", { name: "Walk-on" }); // a walk-on guest is NOT a required scorer
    await act(live, "score", "m_a", { index: 0, scorerIndex: 0, hole: 1, strokes: 3 });
    await act(live, "score", "m_a", { index: 0, scorerIndex: 0, hole: 2, strokes: 3 });
    await act(live, "score", "m_a", { index: 1, scorerIndex: 0, hole: 1, strokes: 3 });
    await act(live, "score", "m_a", { index: 1, scorerIndex: 0, hole: 2, strokes: 3 });

    // The only MEMBER (m_a) confirmed every hole for both players; the guest's own card isn't required.
    const finalized = await act(live, "finalize", "m_a", {});
    expect(finalized.status).toBe(200);
    expect(((await finalized.json()) as { status: string }).status).toBe("final");
    expect(touchedDb).toBe(false); // casual → nothing written to D1
  });

  it("blocks finalize while a MEMBER cardmate hasn't confirmed (no conflict, purely unconfirmed), then finalizes once they match", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    // m_a keeps the whole card; m_b (a member) hasn't entered anything.
    for (const hole of [1, 2]) { await act(live, "score", "m_a", { index: 0, hole, strokes: 3 }); await act(live, "score", "m_a", { index: 1, hole, strokes: 3 }); }
    const blocked = await act(live, "finalize", "m_a", {});
    expect(blocked.status).toBe(409);
    const b1 = (await blocked.json()) as { error: string; conflicts: unknown[]; missing: unknown[] };
    expect(b1.error).toBe("scorecard_incomplete");
    expect(b1.conflicts).toEqual([]); // nothing disagrees — it's purely unconfirmed
    expect(b1.missing.length).toBeGreaterThan(0);
    // m_b confirms matching scores on every hole for both players → complete.
    for (const hole of [1, 2]) { await act(live, "score", "m_b", { index: 0, hole, strokes: 3 }); await act(live, "score", "m_b", { index: 1, hole, strokes: 3 }); }
    const done = await act(live, "finalize", "m_a", {});
    expect(done.status).toBe(200);
    expect(((await done.json()) as { forced: boolean }).forced).toBe(false);
  });

  it("a non-admin cannot force past an incomplete board; only an admin can", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    // Only m_a scores; member m_b never confirms → incomplete.
    for (const hole of [1, 2]) { await act(live, "score", "m_a", { index: 0, hole, strokes: 3 }); await act(live, "score", "m_a", { index: 1, hole, strokes: 3 }); }
    const nope = await act(live, "finalize", "m_a", { force: true }); // non-admin force is ignored
    expect(nope.status).toBe(409);
    expect(((await nope.json()) as { error: string }).error).toBe("scorecard_incomplete");
    const forced = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Member": "m_a", "X-Auth-Admin": "true" }, body: JSON.stringify({ force: true }) }));
    expect(forced.status).toBe(200);
    expect(((await forced.json()) as { forced: boolean }).forced).toBe(true);
  });

  it("exposes `missing` (unconfirmed member scores) in the snapshot and /mine", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await startCasual(live, "m_a");
    await act(live, "join", "m_b", { name: "Bee" });
    await act(live, "score", "m_a", { index: 0, hole: 1, strokes: 3 }); // barely started → lots unconfirmed
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { missing: { hole: number; playerName: string }[] };
    expect(Array.isArray(snap.missing)).toBe(true);
    expect(snap.missing.length).toBeGreaterThan(0);
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m_a" } }))).json()) as { missing: unknown[] };
    expect(Array.isArray(mine.missing)).toBe(true);
    expect((mine.missing as unknown[]).length).toBeGreaterThan(0);
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
    expect(body.error).toBe("scorecard_incomplete");
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

describe("LiveEventDO UDisc export bridge", () => {
  it("calculates round ratings and stores them with finalized admin results", async () => {
    const resultInserts: unknown[][] = [];
    const ratingInserts: unknown[][] = [];
    const recDb = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          run: async () => {
            if (/INSERT INTO round_ratings/i.test(sql)) ratingInserts.push(args);
            return { results: [], success: true };
          },
          first: async () => {
            if (/INSERT INTO results/i.test(sql)) {
              resultInserts.push(args);
            }
            return null;
          },
          all: async () => ({ results: [], success: true }),
        };
      },
    };
    const live = new LiveEventDO(new FakeState({}), { DB: recDb });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({
      eventId: 9,
      courseId: 4,
      layoutId: 5,
      startedAt: "2026-07-01T12:00:00.000Z",
      holes: [{ hole: 1, par: 10 }],
      players: [
        { memberId: "m_a", name: "A", startingHole: 1, ratingAnchor: 1000 },
        { memberId: "m_b", name: "B", startingHole: 2, ratingAnchor: 941 },
        { memberId: "m_c", name: "C", startingHole: 3, ratingAnchor: 1059 },
      ],
    }) }));

    for (const [index, strokes] of [[0, 10], [1, 12], [2, 8]]) {
      await live.fetch(new Request("https://do/score", {
        method: "POST",
        headers: { "X-Auth-Admin": "true" },
        body: JSON.stringify({ index, scorerIndex: index, hole: 1, strokes }),
      }));
    }

    const fin = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Admin": "true" } }));
    expect(fin.status).toBe(200);
    expect(resultInserts.map((args) => args[6])).toEqual([1059, 1000, 941]);
    expect(ratingInserts).toHaveLength(3);
    expect(ratingInserts.every((args) => args.includes("competition"))).toBe(true);
  });

  it("persists each player's per-hole scorecard to the result row on admin-event finalize", async () => {
    stubWeather([
      openMeteoSample("2026-07-01T08:00", 7.5, 0),
      openMeteoSample("2026-07-01T08:15", 9.2, 0.04),
    ]);
    const inserts: { sql: string; args: unknown[] }[] = [];
    const recDb = {
      prepare(sql: string) {
        const entry = { sql, args: [] as unknown[] };
        return {
          bind(...args: unknown[]) {
            entry.args = args;
            if (/INSERT INTO results/i.test(sql)) inserts.push(entry);
            return this;
          },
          run: async () => ({ results: [], success: true }),
          first: async () => null,
          all: async () => ({ results: [], success: true }),
        };
      },
    };
    const live = new LiveEventDO(new FakeState({}), { DB: recDb });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ eventId: 9, holes: [{ hole: 1, par: 3 }, { hole: 2, par: 4 }], players: [{ memberId: "m_jane", name: "Jane" }], weatherLocation: { lat: 35.631092, lng: -77.319923, label: "North Rec" } }) }));
    const score = (hole: number, strokes: number) =>
      live.fetch(new Request("https://do/score", { method: "POST", headers: { "X-Auth-Admin": "true" }, body: JSON.stringify({ index: 0, scorerIndex: 0, hole, strokes }) }));
    await score(1, 3);
    await score(2, 5);

    const fin = await live.fetch(new Request("https://do/finalize", { method: "POST", headers: { "X-Auth-Admin": "true" } }));
    expect(fin.status).toBe(200);
    expect(inserts).toHaveLength(1);
    const resultInsert = defined(inserts[0], "result_insert_missing");
    const scorecard = resultInsert.args[8]; // 9th bind column = scorecard JSON
    expect(JSON.parse(scorecard as string)).toEqual([
      { hole: 1, par: 3, strokes: 3 },
      { hole: 2, par: 4, strokes: 5 },
    ]);
    const weather = resultInsert.args[9];
    expect(typeof weather).toBe("string");
    const parsedWeather: unknown = typeof weather === "string" ? JSON.parse(weather) : null;
    expect(parsedWeather).toMatchObject({
      current: { observedAt: "2026-07-01T08:15", rainIn: 0.04, windSpeedMph: 9.2, windGustMph: 15.2 },
      history: [{ windSpeedMph: 7.5, windGustMph: 13.5 }, { windSpeedMph: 9.2, windGustMph: 15.2 }],
    });
  });

  it("carries the UDisc course id from start into the snapshot and /mine (casual export source)", async () => {
    const live = new LiveEventDO(new FakeState({}), { DB: db });
    await live.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify({ casual: true, udiscCourseId: "98765", holes: [{ hole: 1, par: 3 }], players: [{ memberId: "m_a", name: "A" }] }) }));
    const snap = (await (await live.fetch(new Request("https://do/"))).json()) as { udiscCourseId: string | null };
    expect(snap.udiscCourseId).toBe("98765");
    const mine = (await (await live.fetch(new Request("https://do/mine", { headers: { "X-Auth-Member": "m_a" } }))).json()) as { udiscCourseId: string | null };
    expect(mine.udiscCourseId).toBe("98765");
  });
});
