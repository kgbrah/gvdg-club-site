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
  const deleted: string[] = [];
  const defaultCache = {
    match: async (request: Request) => store.get(request.url)?.clone(),
    // Like Cloudflare's Cache API: a response marked private/no-store (or without a lifetime) is not stored.
    put: async (request: Request, response: Response) => {
      const control = response.headers.get("Cache-Control") || "";
      if (/private|no-store|no-cache/i.test(control) || !/max-age=\d+/.test(control)) return;
      store.set(request.url, response.clone());
    },
  };
  vi.stubGlobal("caches", {
    open: async () => defaultCache,
    delete: async (name: string) => {
      deleted.push(name);
      store.clear();
      return true;
    },
  });
  return { store, deleted };
}

type Mode = "full-then-loss" | "always-loss" | "layouts-loss" | "marks-loss";

/** Fake D1 for the catalog's three reads: courses, layouts, published map marks. */
function courseDb(mode: Mode) {
  let calls = 0;
  const reads = { courses: 0, layouts: 0, marks: 0 };
  const lost = () => { throw new Error("D1_ERROR: Network connection lost."); };
  function statement(sql: string) {
    const kind = /course_map_consensus/.test(sql) ? "marks" : /FROM course_layouts/.test(sql) ? "layouts" : "courses";
    const self = {
      bind() { return self; },
      all: async () => {
        calls += 1;
        reads[kind] += 1;
        if (mode === "always-loss") lost();
        if (mode === "full-then-loss" && calls > 3) lost();
        if (mode === "layouts-loss" && kind === "layouts") lost();
        if (mode === "marks-loss" && kind === "marks") lost();
        return { results: kind === "courses" ? FULL_CATALOG : [], success: true };
      },
      first: async () => null,
      run: async () => ({ results: [], success: true }),
    };
    return self;
  }
  return {
    calls: () => calls,
    reads,
    db: { prepare: (sql: string) => statement(sql) },
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
    vi.restoreAllMocks();
  });

  it("serves a fresh cached catalog without reading D1 again", async () => {
    installCache();
    const courses = courseDb("full-then-loss");
    const first = await worker.fetch(request(), env(courses.db));
    const afterFirst = courses.calls();
    const second = await worker.fetch(request(), env(courses.db));

    expect(afterFirst).toBe(3);
    expect(courses.calls()).toBe(afterFirst);
    expect(second.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Browsers never hold the catalog, even when the edge served it from cache.
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(second.headers.get("Cache-Control")).toBe("private, no-store");
    expect(second.headers.get("X-Gvdg-Catalog-At")).toBe(first.headers.get("X-Gvdg-Catalog-At"));
    expect((await first.json() as { courses: unknown[] }).courses).toHaveLength(2);
    expect((await second.json() as { courses: unknown[] }).courses).toHaveLength(2);
  });

  it("after the freshness window, answers with the saved catalog at once and rebuilds it after the response", async () => {
    installCache();
    const courses = courseDb("full-then-loss");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const first = await worker.fetch(request(), env(courses.db));
    const firstStamp = first.headers.get("X-Gvdg-Catalog-At");
    expect(courses.calls()).toBe(3);
    // A minute later (D1 healthy again for the rebuild): the visitor doesn't wait on the three bulk reads.
    const healthy = courseDb("layouts-loss");
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (job: Promise<unknown>) => { pending.push(job); }, passThroughOnException() {} };
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const stale = await worker.fetch(request(), env(courseDb("full-then-loss").db), ctx as unknown as ExecutionContext);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("X-Gvdg-Catalog-At")).toBe(firstStamp);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    // The rebuilt copy is what the next visitor gets.
    vi.spyOn(Date, "now").mockReturnValue(now + 62_000);
    const next = await worker.fetch(request(), env(healthy.db));
    expect(Number(next.headers.get("X-Gvdg-Catalog-At"))).toBe(now + 61_000);
    expect(healthy.calls()).toBe(0);
  });

    it("keeps the last good catalog when D1 fails after the freshness window", async () => {
    installCache();
    const courses = courseDb("full-then-loss");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await worker.fetch(request(), env(courses.db));
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const second = await worker.fetch(request(), env(courses.db));

    expect(second.status).toBe(200);
    expect(courses.calls()).toBeGreaterThan(3);
    expect((await second.json() as { courses: unknown[] }).courses).toHaveLength(2);
  });

  it("does not pin the ECU-only fallback in cache", async () => {
    const { store } = installCache();
    const courses = courseDb("always-loss");

    const first = await worker.fetch(request(), env(courses.db));
    const afterFirst = courses.calls();
    const second = await worker.fetch(request(), env(courses.db));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json() as { courses: unknown[] }).courses).toHaveLength(1);
    expect(store.size).toBe(0);
    expect(courses.calls()).toBeGreaterThan(afterFirst);
  });

  it.each(["layouts-loss", "marks-loss"] as const)("never caches a catalog whose %s read fell back", async (mode) => {
    const { store } = installCache();
    const courses = courseDb(mode);

    const first = await worker.fetch(request(), env(courses.db));
    const second = await worker.fetch(request(), env(courses.db));

    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(store.size).toBe(0);
    // Not served from cache: the next request reads D1 again instead of repeating the degraded copy.
    expect(courses.reads.courses).toBe(2);
    expect(second.status).toBe(200);
  });

  it("drops the cached catalog when a course, layout or published map changes", async () => {
    const { store, deleted } = installCache();
    const courses = courseDb("full-then-loss");
    await worker.fetch(request(), env(courses.db));
    expect(store.size).toBe(1);

    const { updateLayout } = await import("../src/db-courses.js");
    const write = { prepare: () => ({ bind() { return this; }, first: async () => ({ id: 1 }), run: async () => ({ success: true }) }) };
    await updateLayout(write as never, 1, { name: "Blue" });

    expect(deleted).toEqual(["gvdg-course-catalog"]);
    expect(store.size).toBe(0);
  });

  it("keeps /courses, /courses/:id/layouts, and /courses/:id/positions isolated in cache and busts per course via Cache.delete", async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (req: Request) => store.get(req.url)?.clone(),
        put: async (req: Request, res: Response) => {
          const control = res.headers.get("Cache-Control") || "";
          if (/private|no-store|no-cache/i.test(control) || !/max-age=\d+/.test(control)) return;
          store.set(req.url, res.clone());
        },
        delete: async (req: Request) => store.delete(req.url),
      }),
    });

    const db = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          all: async () => {
            if (/course_map_consensus/.test(sql)) return { results: [], success: true };
            if (/FROM course_layouts WHERE course_id/.test(sql)) {
              expect(bound).toEqual([1]);
              return { results: [{ id: 101, course_id: 1, name: "Main", holes: "[]" }], success: true };
            }
            if (/FROM course_layouts/.test(sql)) {
              return { results: [{ id: 101, course_id: 1, name: "Main", holes: "[]" }], success: true };
            }
            if (/FROM course_positions WHERE course_id/.test(sql)) {
              expect(bound).toEqual([1]);
              return { results: [{ id: 201, course_id: 1, kind: "tee", label: "Hole 1 tee" }], success: true };
            }
            return { results: FULL_CATALOG, success: true };
          },
          first: async () => null,
          run: async () => ({ results: [], success: true }),
        };
      },
    };

    const coursesRes = await worker.fetch(new Request("https://auth.gvdgclub.com/courses", { headers: { Origin: "https://gvdgclub.com" } }), env(db));
    expect(coursesRes.status).toBe(200);
    expect((await coursesRes.json() as { courses: unknown[] }).courses).toHaveLength(2);

    const layoutsRes = await worker.fetch(new Request("https://auth.gvdgclub.com/courses/1/layouts", { headers: { Origin: "https://gvdgclub.com" } }), env(db));
    expect(layoutsRes.status).toBe(200);
    expect((await layoutsRes.json() as { layouts: { name: string }[] }).layouts.map((l) => l.name)).toEqual(["Main"]);

    const positionsRes = await worker.fetch(new Request("https://gvdgclub.com/api/courses/1/positions", { headers: { Origin: "https://gvdgclub.com" } }), env(db));
    expect(positionsRes.status).toBe(200);
    expect((await positionsRes.json() as { positions: { label: string }[] }).positions.map((p) => p.label)).toEqual(["Hole 1 tee"]);

    expect(store.size).toBe(3);

    const { bustCourseCatalogCache } = await import("../src/course-catalog-cache.js");
    await expect(bustCourseCatalogCache(1)).resolves.toBe(true);
    expect(store.size).toBe(0);
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

