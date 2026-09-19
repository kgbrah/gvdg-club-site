import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";

const SECRET = "x".repeat(40);
const FULL_CATALOG = [
  { id: 1, name: "ECU North Rec Complex", is_default: 1 },
  { id: 2, name: "West Meadowbrook Park", is_default: 1 },
];

function kv() {
  return { get: async () => null, put: async () => undefined, delete: async () => undefined };
}

function installCache() {
  const store = new Map<string, Response>();
  const defaultCache = {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response.clone());
    },
  };
  vi.stubGlobal("caches", { open: async () => defaultCache });
}

function courseDb(mode: "full-then-loss" | "always-loss") {
  let calls = 0;
  const statement = {
    bind() {
      return statement;
    },
    all: async () => {
      calls += 1;
      if (mode === "always-loss" || calls > 1) throw new Error("D1_ERROR: Network connection lost.");
      return { results: FULL_CATALOG, success: true };
    },
    first: async () => null,
    run: async () => ({ results: [], success: true }),
  };
  return {
    calls: () => calls,
    db: { prepare: () => statement },
  };
}

function env(db: unknown) {
  return {
    ROSTER: kv(),
    RATELIMIT: kv(),
    DB: db,
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: "https://gvdgclub.com",
    LIVE: undefined,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function request() {
  return new Request("https://w/courses", { headers: { Origin: "https://gvdgclub.com" } });
}

describe("public course catalog cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a real catalog when D1 later fails instead of caching the one-course fallback", async () => {
    installCache();
    const courses = courseDb("full-then-loss");

    const first = await worker.fetch(request(), env(courses.db));
    const second = await worker.fetch(request(), env(courses.db));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await first.json() as { courses: unknown[] }).courses).toHaveLength(2);
    expect((await second.json() as { courses: unknown[] }).courses).toHaveLength(2);
    expect(courses.calls()).toBeGreaterThan(1);
  });

  it("does not pin the ECU-only fallback in cache", async () => {
    installCache();
    const courses = courseDb("always-loss");

    const first = await worker.fetch(request(), env(courses.db));
    const afterFirst = courses.calls();
    const second = await worker.fetch(request(), env(courses.db));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json() as { courses: unknown[] }).courses).toHaveLength(1);
    expect(courses.calls()).toBeGreaterThan(afterFirst);
  });
});

describe("course map-import status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports mapped counts and last import tick", async () => {
    installCache();
    const courses = courseDb("full-then-loss");
    const response = await worker.fetch(
      new Request("https://w/courses/map-import", { headers: { Origin: "https://gvdgclub.com" } }),
      env(courses.db),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { total: number; mapped: number; remaining: number };
    expect(body.total).toBe(2);
    expect(body.mapped).toBe(0);
    expect(body.remaining).toBe(2);
  });
});

