import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { signSession } from "../src/jwt.js";
import { retryableD1LossDb } from "./d1-test-utils.js";

const SECRET = "x".repeat(40);
const MEMBER = JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false, pdgaNo: "90000001" });

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => void rows.set(key, value),
    delete: async (key: string) => void rows.delete(key),
  };
}

function env() {
  return {
    ROSTER: kv({ "member:m_jane": MEMBER }),
    RATELIMIT: kv(),
    DB: retryableD1LossDb(),
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: "http://localhost:8080",
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function token() {
  return signSession({ sub: "m_jane", mustChangePin: false }, SECRET, 900);
}

async function get(path: string, jwt?: string) {
  const headers: Record<string, string> = { Origin: "http://localhost:8080" };
  if (jwt) headers.authorization = "Bearer " + jwt;
  return worker.fetch(new Request("https://w" + path, { headers }), env());
}

describe("dashboard D1 fallback reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails open for member dashboard list endpoints when D1 is transiently unavailable", async () => {
    const jwt = await token();

    await expect((await get("/my-results", jwt)).json()).resolves.toEqual({ results: [], casual: [] });
    await expect((await get("/my-ratings?competitiveLimit=250&casualLimit=250", jwt)).json()).resolves.toEqual({
      competitive: { live_rating: null, rated_rounds: 0, rounds_count: 0, rounds: [], eligible_rated_rounds: 0, minimum_rated_rounds: 8 },
      casual: { live_rating: null, rated_rounds: 0, rounds_count: 0, rounds: [], eligible_rated_rounds: 0, minimum_rated_rounds: 8 },
    });
    await expect((await get("/my-live-rounds", jwt)).json()).resolves.toEqual({ rounds: [] });
    await expect((await get("/board", jwt)).json()).resolves.toEqual({ posts: [], authors: {} });
  });

  it("fails open for public dashboard support endpoints when D1 is transiently unavailable", async () => {
    await expect((await get("/meetings")).json()).resolves.toEqual({ meetings: [] });
    await expect((await get("/leagues/active")).json()).resolves.toEqual({ leagues: [], liveEvents: [] });
  });

  it("returns the seeded staging QA PDGA stats when D1 and PDGA are unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("pdga unavailable"));

    const res = await get("/pdga-stats?pdga=90000001");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      pdga: "90000001",
      name: "GVDG QA Dashboard",
      official_rating: 935,
      live_rating: 941,
      peak_rating: 958,
      events_count: 3,
    });
  });
});

describe("pdga-stats per-IP limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function statsEnv(cache: { data: string; fetched_at: number } | null) {
    const writes: unknown[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => (/SELECT data, fetched_at FROM pdga_cache/.test(sql) ? cache : null),
          run: async () => { writes.push(sql); return { success: true }; },
        }),
      }),
    };
    return { RATELIMIT: kv(), ROSTER: kv(), DB: db, JWT_SECRET: SECRET, ALLOWED_ORIGINS: "http://localhost:8080", LIVE: undefined } as unknown as Parameters<typeof worker.fetch>[1];
  }
  const stats = (pdga: string) => JSON.stringify({ pdga, name: "Cached Player", official_rating: 912, events: [{ tournament: "T", rounds: [] }], events_count: 1, play_rounds: [], stats_version: 3 });
  const ask = (e: Parameters<typeof worker.fetch>[1], pdga: string) =>
    worker.fetch(new Request("https://w/pdga-stats?pdga=" + pdga, { headers: { Origin: "http://localhost:8080", "CF-Connecting-IP": "203.0.113.9" } }), e);

  it("serves fresh cache hits without counting them against the shared IP's limit", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound expected"));
    const e = statsEnv({ data: stats("273070"), fetched_at: Date.now() });
    for (let i = 0; i < 40; i++) expect((await ask(e, "273070")).status).toBe(200);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("never rate-limits the built-in QA stats", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("pdga unavailable"));
    const e = statsEnv(null);
    for (let i = 0; i < 40; i++) expect((await ask(e, "90000001")).status).toBe(200);
  });

  it("without the club's PDGA login, answers with no rating and never reaches PDGA", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound expected"));
    const response = await ask(statsEnv(null), "273070");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ pdga: "273070", official_rating: null, events: [] });
    expect(outbound).not.toHaveBeenCalled();
  });
});
