import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
};

function kv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

function makeDb(status = "live") {
  const events = new Map<number, Record<string, unknown>>([
    [7, { id: 7, name: "Schwarga vs TJ", status, course_id: 4, layout_id: 20 }],
  ]);
  const chat: Record<string, unknown>[] = [];
  let nextId = 1;
  return {
    chat: () => chat,
    db: {
      prepare(sql: string) {
        const text = sql.replace(/\s+/g, " ");
        const stmt = {
          binds: [] as unknown[],
          bind(...values: unknown[]) {
            stmt.binds = values;
            return stmt;
          },
          async first() {
            if (text.includes("FROM events WHERE id")) {
              return events.get(Number(stmt.binds[0])) ?? null;
            }
            if (text.includes("INSERT INTO event_chat")) {
              const [event_id, member_id, author_name, body] = stmt.binds;
              const row = {
                id: nextId++,
                event_id,
                member_id,
                author_name,
                body,
                created_at: "2026-09-11 22:00:00",
              };
              chat.push(row);
              return row;
            }
            return null;
          },
          async all() {
            if (text.includes("FROM event_chat")) {
              const id = Number(stmt.binds[0]);
              const limit = Number(stmt.binds[1] ?? 100);
              return {
                results: chat.filter((row) => Number(row.event_id) === id).slice().reverse().slice(0, limit),
                success: true,
              };
            }
            return { results: [], success: true };
          },
          async run() {
            return { results: [], success: true };
          },
        };
        return stmt;
      },
    },
  };
}

function env(db: unknown, rateLimit = kv()) {
  return {
    ROSTER: kv(members),
    RATELIMIT: rateLimit,
    DB: db,
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function tok() {
  return signSession({ sub: "m_jane", mustChangePin: false }, SECRET, 900);
}

async function call(path: string, method = "GET", token?: string, body?: unknown, workerEnv = env(makeDb().db)) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.authorization = "Bearer " + token;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch(
    new Request("https://w" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    workerEnv,
  );
}

describe("live event chat", () => {
  it("stays closed until the event is live", async () => {
    const store = makeDb("scheduled");
    const workerEnv = env(store.db);
    const listed = await call("/events/7/chat", "GET", undefined, undefined, workerEnv);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ open: false, messages: [] });
    expect((await call("/events/7/chat", "POST", undefined, { name: "Pat", body: "go get em" }, workerEnv)).status).toBe(409);
  });

  it("lets a guest chirp during a live event and omits member ids", async () => {
    const store = makeDb("live");
    const workerEnv = env(store.db);
    const posted = await call("/events/7/chat", "POST", undefined, { name: "Pat", body: "parked it, Schwarga" }, workerEnv);
    expect(posted.status).toBe(201);
    const listed = await call("/events/7/chat", "GET", undefined, undefined, workerEnv);
    expect(listed.status).toBe(200);
    const payload = (await listed.json()) as { open: boolean; messages: Record<string, unknown>[] };
    expect(payload.open).toBe(true);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatchObject({ author_name: "Pat", body: "parked it, Schwarga" });
    expect(payload.messages[0]!.member_id).toBeUndefined();
  });

  it("uses the member roster name instead of a spoofed guest name", async () => {
    const posted = await call("/events/7/chat", "POST", await tok(), { name: "Not Jane", body: "card that" });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ message: { author_name: "Jane", body: "card that" } });
  });

  it("rejects empty, too-long, and nameless guest posts, then rate-limits", async () => {
    expect((await call("/events/7/chat", "POST", undefined, { name: "Pat", body: "   " })).status).toBe(400);
    expect((await call("/events/7/chat", "POST", undefined, { body: "nice" })).status).toBe(400);
    expect((await call("/events/7/chat", "POST", undefined, { name: "Pat", body: "x".repeat(281) })).status).toBe(413);
    const workerEnv = env(makeDb().db);
    let last = 201;
    for (let i = 0; i < 21; i++) {
      last = (await call("/events/7/chat", "POST", undefined, { name: "Pat", body: "go " + i }, workerEnv)).status;
    }
    expect(last).toBe(429);
  });
});
