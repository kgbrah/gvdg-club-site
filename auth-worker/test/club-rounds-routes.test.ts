import { describe, expect, it } from "vitest";
import { handleCasualRounds } from "../src/club-rounds-routes.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import type { KVListLike } from "../src/roster.js";

const SECRET = "x".repeat(40);

type State = {
  startedBody?: Record<string, unknown>;
};

function unusedBinding(name: string): never {
  throw new Error(`unexpected_${name}_binding_access`);
}

function kv(initial: Record<string, string> = {}): KVListLike {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
    list: async (opts) => {
      const prefix = opts?.prefix ?? "";
      return { keys: [...rows.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function d1Meta(): D1Meta & Record<string, unknown> {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 };
}

class Statement implements D1PreparedStatement {
  private binds: unknown[] = [];

  constructor(private readonly sql: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.binds = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { results: [], success: true, meta: d1Meta() };
  }

  async first<T = unknown>(_colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    let row: Record<string, unknown> | null = null;
    if (/SELECT \* FROM course_layouts WHERE id = \?/i.test(this.sql)) row = { id: this.binds[0], course_id: 7, name: "Main", holes: JSON.stringify([{ hole: 1, par: 3 }]) };
    else if (/SELECT \* FROM courses WHERE id = \?/i.test(this.sql)) row = { id: this.binds[0], name: "Ayden Park", location: "Ayden, NC", lat: 35.489203, lng: -77.426836 };
    else if (/SELECT rating FROM player_ratings/i.test(this.sql)) row = null;
    return row as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { results: [], success: true, meta: d1Meta() };
  }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    return options?.columnNames === true ? [[]] : [];
  }
}

function db(): D1Database {
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: async <T = unknown>() => [] as D1Result<T>[],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => unusedBinding("DB.withSession"),
    dump: async () => new ArrayBuffer(0),
  };
}

function env(state: State): Env {
  const liveStub = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      state.startedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "live" }));
    },
  };
  return {
    ROSTER: kv({ "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }) }),
    RATELIMIT: kv(),
    DB: db(),
    JWT_SECRET: SECRET,
    LIVE: {
      idFromName: (name: string) => name,
      get: () => liveStub,
    },
  } as unknown as Env;
}

async function authHeader() {
  return { Authorization: "Bearer " + (await signSession({ sub: "m_jane", mustChangePin: false }, SECRET, 900)) };
}

describe("casual round starts", () => {
  it("passes scoring format, doubles play format, and creator team into the live round", async () => {
    const state: State = {};
    const res = await handleCasualRounds(
      new Request("https://w/rounds", { method: "POST", headers: await authHeader(), body: JSON.stringify({ course_id: 7, layout_id: 9, format: "matchplay", playFormat: "doubles", team: "Team Fox" }) }),
      env(state),
      null,
      "POST",
      ["rounds"],
    );

    expect(res?.status).toBe(201);
    expect(state.startedBody).toMatchObject({
      casual: true,
      format: "matchplay",
      playFormat: "doubles",
      teamRequired: true,
      players: [{ memberId: "m_jane", name: "Jane", team: "Team Fox" }],
    });
  });

  it("allows matchplay singles without a creator team", async () => {
    const state: State = {};
    const res = await handleCasualRounds(
      new Request("https://w/rounds", { method: "POST", headers: await authHeader(), body: JSON.stringify({ course_id: 7, layout_id: 9, format: "matchplay", playFormat: "singles" }) }),
      env(state),
      null,
      "POST",
      ["rounds"],
    );

    expect(res?.status).toBe(201);
    expect(state.startedBody).toMatchObject({ format: "matchplay", playFormat: "singles", teamRequired: false });
  });

  it("requires a creator team for doubles casual rounds", async () => {
    const state: State = {};
    const res = await handleCasualRounds(
      new Request("https://w/rounds", { method: "POST", headers: await authHeader(), body: JSON.stringify({ course_id: 7, layout_id: 9, format: "stroke", playFormat: "doubles" }) }),
      env(state),
      null,
      "POST",
      ["rounds"],
    );

    expect(res?.status).toBe(400);
    await expect(res?.json()).resolves.toMatchObject({ error: "team_required" });
    expect(state.startedBody).toBeUndefined();
  });

  it("keeps accepting legacy format=doubles requests from cached clients", async () => {
    const state: State = {};
    const res = await handleCasualRounds(
      new Request("https://w/rounds", { method: "POST", headers: await authHeader(), body: JSON.stringify({ course_id: 7, layout_id: 9, format: "doubles", team: "Team Fox" }) }),
      env(state),
      null,
      "POST",
      ["rounds"],
    );

    expect(res?.status).toBe(201);
    expect(state.startedBody).toMatchObject({ format: "stroke", playFormat: "doubles", teamRequired: true });
  });
});
