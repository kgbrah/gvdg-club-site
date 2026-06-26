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

    const score = await live.fetch(new Request("https://do/score", { method: "POST", body: JSON.stringify({ index: 0, hole: 1, strokes: 3 }) }));
    expect(score.status).toBe(200);
    expect(server.sent.at(-1)).toContain('"scores":{"1":3}');
  });
});
