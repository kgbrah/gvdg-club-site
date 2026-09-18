import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signOpenPlaySession, signSession, verifySession } from "../src/jwt.js";
import { jsonObject } from "./json.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
const MEMBER = JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false });

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

function db() {
  return {
    prepare: (sql: string) => ({
      bind() { return this; },
      all: async () => ({ results: [], success: true }),
      first: async () => {
        if (/FROM course_layouts WHERE id/i.test(sql)) {
          return { id: 5, name: "Blue", course_id: 3, holes: JSON.stringify([{ hole: 1, par: 3 }, { hole: 2, par: 3 }]) };
        }
        if (/FROM courses WHERE id/i.test(sql)) return { id: 3, name: "North Rec", udisc_course_id: null, lat: null, lng: null };
        return null;
      },
      run: async () => ({ results: [], success: true }),
    }),
  };
}

function liveStub() {
  const starts: unknown[] = [];
  const joins: { member: string | null; name: unknown }[] = [];
  function header(init: RequestInit | undefined, name: string): string | null {
    const headers = init?.headers;
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    const rec = headers as Record<string, string>;
    return rec[name] ?? rec[name.toLowerCase()] ?? null;
  }
  return {
    starts,
    joins,
    LIVE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.url;
          const path = new URL(url).pathname;
          const member = header(init, "X-Auth-Member") || (typeof input === "object" ? input.headers.get("X-Auth-Member") : null);
          if (path.endsWith("/start")) {
            const raw = typeof init?.body === "string" ? init.body : "";
            starts.push(raw ? JSON.parse(raw) : {});
            return new Response(JSON.stringify({ status: "live" }), { status: 200 });
          }
          if (path.endsWith("/join")) {
            const body = typeof init?.body === "string" ? JSON.parse(init.body) as { name?: string } : {};
            joins.push({ member, name: body.name });
            return new Response(JSON.stringify({ cardId: "c0", cardmates: [] }), { status: 200 });
          }
          if (path.endsWith("/mine")) {
            return new Response(JSON.stringify({ status: "live", cardId: "c0", cardmates: [{ name: "Pat", isMe: true }] }), { status: 200 });
          }
          if (path.endsWith("/score")) {
            return new Response(JSON.stringify({ players: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        },
      }),
    },
  };
}

function env(extra: Record<string, unknown> = {}) {
  const live = liveStub();
  return {
    live,
    env: {
      ROSTER: kv({ "member:m_jane": MEMBER }),
      RATELIMIT: kv(),
      DB: db(),
      JWT_SECRET: SECRET,
      ALLOWED_ORIGINS: ORIGIN,
      LIVE: live.LIVE,
      ...extra,
    } as unknown as Parameters<typeof worker.fetch>[1],
  };
}

async function call(
  path: string,
  method: string,
  token?: string,
  body?: unknown,
  e?: Parameters<typeof worker.fetch>[1],
) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.authorization = "Bearer " + token;
  if (body !== undefined) headers["content-type"] = "application/json";
  return worker.fetch(new Request("https://w" + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }), e ?? env().env);
}

describe("open play casual scoring", () => {
  it("mints an open-play token from a display name", async () => {
    const res = await call("/rounds/open-play", "POST", undefined, { name: "Pat" });
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(typeof body.token).toBe("string");
    expect(String(body.playerId)).toMatch(/^op_[0-9a-f]{24}$/);
    expect(body.name).toBe("Pat");
    const claims = await verifySession(String(body.token), SECRET);
    expect(claims?.play).toBe(true);
    expect(claims?.sub).toBe(body.playerId);
    expect(claims?.name).toBe("Pat");
  });

  it("rejects a missing name", async () => {
    expect((await call("/rounds/open-play", "POST", undefined, {})).status).toBe(400);
  });

  it("refreshes the same player id when an open-play token is sent back", async () => {
    const first = await jsonObject(await call("/rounds/open-play", "POST", undefined, { name: "Pat" }));
    const again = await jsonObject(await call("/rounds/open-play", "POST", String(first.token), { name: "Patricia" }));
    expect(again.playerId).toBe(first.playerId);
    expect(again.name).toBe("Patricia");
  });

  it("cannot hit member routes", async () => {
    const token = (await jsonObject(await call("/rounds/open-play", "POST", undefined, { name: "Pat" }))).token as string;
    expect((await call("/me", "GET", token)).status).toBe(401);
    expect((await call("/my-registrations", "GET", token)).status).toBe(401);
    expect((await call("/my-results", "GET", token)).status).toBe(401);
  });

  it("starts a casual round without a club login", async () => {
    const boxed = env();
    const token = (await jsonObject(await call("/rounds/open-play", "POST", undefined, { name: "Pat" }, boxed.env))).token as string;
    const res = await call("/rounds", "POST", token, { layout_id: 5, liveScoringConfig: { groupFormat: "singles", scoringStyle: "stroke" } }, boxed.env);
    expect(res.status).toBe(201);
    const body = await jsonObject(res);
    expect(String(body.code)).toMatch(/^[A-Z0-9]{6}$/);
    const started = boxed.live.starts[0] as { createdBy: string; players: { memberId: string; name: string }[] };
    expect(started.createdBy).toMatch(/^op_/);
    expect(started.players[0]).toMatchObject({ memberId: started.createdBy, name: "Pat" });
  });

  it("still lets a member start a casual round", async () => {
    const boxed = env();
    const token = await signSession({ sub: "m_jane", mustChangePin: false }, SECRET, 900);
    const res = await call("/rounds", "POST", token, { layout_id: 5 }, boxed.env);
    expect(res.status).toBe(201);
    const started = boxed.live.starts[0] as { createdBy: string; players: { name: string }[] };
    expect(started.createdBy).toBe("m_jane");
    expect(started.players[0]?.name).toBe("Jane");
  });

  it("rejects starting a round with no identity", async () => {
    expect((await call("/rounds", "POST", undefined, { layout_id: 5 })).status).toBe(401);
  });

  it("joins and scores a round as open play", async () => {
    const boxed = env();
    const token = (await jsonObject(await call("/rounds/open-play", "POST", undefined, { name: "Pat" }, boxed.env))).token as string;
    expect((await call("/rounds/K7M2QX/join", "POST", token, {}, boxed.env)).status).toBe(200);
    expect(boxed.live.joins[0]).toMatchObject({ member: expect.stringMatching(/^op_/), name: "Pat" });
    expect((await call("/rounds/K7M2QX/live/mine", "GET", token, undefined, boxed.env)).status).toBe(200);
    expect((await call("/rounds/K7M2QX/live/score", "POST", token, { hole: 1, strokes: 3 }, boxed.env)).status).toBe(200);
  });

  it("cannot cancel a round as open play", async () => {
    const token = await signOpenPlaySession({ sub: "op_" + "a".repeat(24), name: "Pat" }, SECRET, 900);
    expect((await call("/rounds/K7M2QX/cancel", "POST", token, {})).status).toBe(401);
  });
});
