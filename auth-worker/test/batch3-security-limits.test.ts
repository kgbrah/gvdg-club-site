import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { replacePositions } from "../src/db-courses.js";
import { recordMemberNotices } from "../src/member-messages.js";
import { attachUdiscUrlsFromIndex, inheritMappedUdiscUrl } from "../src/udisc-layout-import.js";
import { saveUdiscLeague } from "../src/udisc-league-save.js";
import { handleAdminVoiceFill, MAX_AUDIO_BYTES } from "../src/voice-fill-route.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";

const memberJson = (memberId: string, name: string, isAdmin = false) =>
  JSON.stringify({ memberId, name, isAdmin, pinHash: "h", mustChangePin: false });

function memoryKv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((k) => k.startsWith(opts?.prefix || "")).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

async function trackedSqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) raw.exec(readFileSync(new URL(file, dir), "utf8"));
  const log: string[] = [];
  let roundTrips = 0;
  let inBatch = false;
  const db = {
    raw,
    log,
    resetCounts() {
      log.length = 0;
      roundTrips = 0;
    },
    get roundTrips() {
      return roundTrips;
    },
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        sql,
        get bound() { return bound; },
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all() {
          log.push(sql.replace(/\s+/g, " ").trim());
          roundTrips += 1;
          return { results: raw.prepare(sql).all(...(bound as never[])), success: true };
        },
        async first() {
          log.push(sql.replace(/\s+/g, " ").trim());
          roundTrips += 1;
          return raw.prepare(sql).get(...(bound as never[])) ?? null;
        },
        async run() {
          log.push(sql.replace(/\s+/g, " ").trim());
          if (!inBatch) roundTrips += 1;
          const info = raw.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number((info as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) } };
        },
      };
      return stmt;
    },
    async batch(list: Array<{ run(): Promise<unknown> }>) {
      roundTrips += 1;
      inBatch = true;
      try {
        return await Promise.all(list.map((stmt) => stmt.run()));
      } finally {
        inBatch = false;
      }
    },
  };
  return db;
}

const token = (sub: string) => signSession({ sub, mustChangePin: false }, SECRET, 900);

async function fetchJson(env: Env, path: string, method = "GET", bearer?: string, body?: unknown) {
  const headers: Record<string, string> = { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.50" };
  if (bearer) headers.Authorization = "Bearer " + bearer;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request("https://worker.example" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {} } as unknown as ExecutionContext);
  return { status: res.status, data: await res.json().catch(() => null) as any };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Batch 3 security, cron & Free-plan limit fixes", () => {
  it("runs runKarmaWatch before runUdiscLayoutImportTick and purges expired people_cache rows", async () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const branch = source.slice(source.indexOf("if (isUdiscLayoutCron(controller.cron))"), source.indexOf("if (isPdgaEventCron(controller.cron))"));
    const sweep = branch.indexOf("await finalizeWithdrawals(env)");
    const karma = branch.indexOf("await runKarmaWatch(env");
    const udisc = branch.indexOf("await runUdiscLayoutImportTick(env)");
    const lostFound = branch.indexOf("await runLostFoundTick(env)");
    expect(sweep).toBeGreaterThan(0);
    expect(karma).toBeGreaterThan(sweep);
    expect(udisc).toBeGreaterThan(karma);
    expect(lostFound).toBeGreaterThan(udisc);

    const db = await trackedSqliteDb();
    db.raw.prepare("INSERT INTO kv_store (ns, key, value, expires_at) VALUES ('people_cache', 'v1', '{}', ?), ('people_cache', 'fresh', '{}', ?)")
      .run(Date.now() - 10_000, Date.now() + 300_000);
    const kv = memoryKv();
    const env = { DB: db, ROSTER: kv, RATELIMIT: kv, JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    const jobs: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController,
      env,
      { waitUntil: (promise: Promise<unknown>) => jobs.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    );
    await Promise.allSettled(jobs);
    const remaining = db.raw.prepare("SELECT key FROM kv_store WHERE ns = 'people_cache'").all() as { key: string }[];
    expect(remaining.map((r) => r.key)).toEqual(["fresh"]);
  });

  it("keeps catalog-order tie breaking in inverted-index UDisc URL inheritance", () => {
    const first = { id: 1, name: "Piney Woods DGC", location: "Greenville, NC", lat: 35.61, lng: -77.36, mapped: 1, udisc_url: "https://udisc.com/courses/piney-woods-first-1111" };
    const second = { id: 2, name: "Piney Woods DGC", location: "Greenville, NC", lat: 35.61, lng: -77.36, mapped: 1, udisc_url: "https://udisc.com/courses/piney-woods-second-2222" };
    const target = { id: 9, name: "Piney Woods Park", location: "Greenville, NC", lat: 35.611, lng: -77.361, mapped: 0 };
    expect(inheritMappedUdiscUrl(target, [first, second, target])).toBe(first.udisc_url);
    expect(attachUdiscUrlsFromIndex([first, second, target], [])).toEqual([{ id: 9, udisc_url: first.udisc_url }]);
  });

  it("caps chunked /admin/voice/fill streams exceeding MAX_AUDIO_BYTES without Content-Length", async () => {
    const kv = memoryKv();
    const env = { RATELIMIT: kv, AI: { run: async () => ({ text: "test" }) } } as unknown as Env;
    const oversizeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024);
        for (let total = 0; total <= MAX_AUDIO_BYTES; total += chunk.byteLength) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await handleAdminVoiceFill(
      new Request("https://worker.example/admin/voice/fill?form=shop", {
        method: "POST", body: oversizeStream, duplex: "half",
      } as RequestInit),
      env,
      ORIGIN,
      "m_admin",
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "audio_too_large" });
  });

  it("eliminates N+1 D1 loops across LF claims, admin overviews, assignments, export, positions, notices, and UDisc sync", async () => {
    const db = await trackedSqliteDb();
    const kv = memoryKv({
      "member:m_ada": memberJson("m_ada", "Ada Lovelace"),
      "member:m_bo": memberJson("m_bo", "Bo Burnham"),
      "member:m_admin": memberJson("m_admin", "Ann Admin", true),
    });
    const env = { DB: db, ROSTER: kv, RATELIMIT: kv, JWT_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    const ada = await token("m_ada");
    const admin = await token("m_admin");

    // 1. GET /lost-found/me with 12 claims + relay messages
    for (let i = 1; i <= 12; i += 1) {
      db.raw.prepare("INSERT INTO lf_posts (id, kind, owner_id, status, brand, mold, plastic, color, expires_at) VALUES (?, 'found', 'm_bo', 'claimed', 'Innova', ?, 'Star', 'Orange', '2099-12-31')")
        .run(100 + i, `Mold${i}`);
      db.raw.prepare("INSERT INTO lf_claims (id, found_id, finder_id, owner_id, status, message) VALUES (?, ?, 'm_bo', 'm_ada', 'open', 'Mine')")
        .run(200 + i, 100 + i);
      db.raw.prepare("INSERT INTO lf_messages (claim_id, sender_id, body) VALUES (?, 'm_ada', 'Ping')")
        .run(200 + i);
    }
    db.resetCounts();
    const myLf = await fetchJson(env, "/lost-found/me", "GET", ada);
    expect(myLf.status).toBe(200);
    expect(myLf.data.claims).toHaveLength(12);
    expect(db.roundTrips).toBeLessThan(30);

    // 2. GET /admin/lost-found/overview with 12 mixed reports
    db.raw.prepare("INSERT INTO lf_celebrations (id, claim_id, author_id, role, caption) VALUES (1, 201, 'm_bo', 'finder', 'Yay')").run();
    for (let i = 1; i <= 11; i += 1) {
      db.raw.prepare("INSERT INTO lf_reports (target_kind, target_id, reporter_id, reason) VALUES ('post', ?, 'm_ada', 'spam')").run(100 + i);
    }
    db.raw.prepare("INSERT INTO lf_reports (target_kind, target_id, reporter_id, reason) VALUES ('celebration', 1, 'm_ada', 'privacy')").run();
    db.resetCounts();
    const lfAdmin = await fetchJson(env, "/admin/lost-found/overview", "GET", admin);
    expect(lfAdmin.status).toBe(200);
    expect(lfAdmin.data.reports).toHaveLength(12);
    expect(db.roundTrips).toBeLessThan(35);

    // 3. GET /admin/market/overview with 12 mixed listing/wanted/feedback reports
    for (let i = 1; i <= 6; i += 1) {
      db.raw.prepare("INSERT INTO market_listings (id, seller_id, brand, mold, disc_type, condition, price_cents) VALUES (?, 'm_bo', 'Innova', ?, 'driver', 8, 1500)")
        .run(i, `Destroyer${i}`);
      db.raw.prepare("INSERT INTO market_reports (target_kind, target_id, reporter_id, reason) VALUES ('listing', ?, 'm_ada', 'spam')").run(i);
    }
    for (let i = 1; i <= 5; i += 1) {
      db.raw.prepare("INSERT INTO market_wanted (id, poster_id, brand, mold, expires_at) VALUES (?, 'm_bo', 'Discraft', ?, '2099-12-31')")
        .run(i, `Buzzz${i}`);
      db.raw.prepare("INSERT INTO market_reports (target_kind, target_id, reporter_id, reason) VALUES ('wanted', ?, 'm_ada', 'spam')").run(i);
    }
    db.raw.prepare("INSERT INTO market_deals (id, listing_id, seller_id, buyer_id, kind, listing_title, status) VALUES (1, 1, 'm_bo', 'm_ada', 'buy', 'Innova Destroyer1', 'completed')").run();
    db.raw.prepare("INSERT INTO market_feedback (id, deal_id, author_id, subject_id, subject_role, rating, comment) VALUES (1, 1, 'm_ada', 'm_bo', 'seller', 'negative', 'bad')").run();
    db.raw.prepare("INSERT INTO market_reports (target_kind, target_id, reporter_id, reason) VALUES ('feedback', 1, 'm_bo', 'abusive')").run();
    db.resetCounts();
    const mktAdmin = await fetchJson(env, "/admin/market/overview", "GET", admin);
    expect(mktAdmin.status).toBe(200);
    expect(mktAdmin.data.reports).toHaveLength(12);
    expect(db.roundTrips).toBeLessThan(30);

    // 4. assign-starting-holes for 35 paid registrants + /admin/export across 16 events
    for (let i = 1; i <= 16; i += 1) {
      db.raw.prepare("INSERT INTO events (id, type, name, status, date) VALUES (?, 'tournament', ?, 'scheduled', '2099-09-01')")
        .run(500 + i, `Event ${i}`);
      db.raw.prepare("INSERT INTO event_config (event_id, registration_open, pdga_event) VALUES (?, 1, '{\"secret\":true}')")
        .run(500 + i);
      db.raw.prepare("INSERT INTO ctps (event_id, hole, prize) VALUES (?, 1, 'Disc')").run(500 + i);
      db.raw.prepare("INSERT INTO ace_pots (event_id, carryover_in_cents, status) VALUES (?, 500, 'active')").run(500 + i);
    }
    for (let i = 1; i <= 35; i += 1) {
      db.raw.prepare("INSERT INTO registrations (event_id, member_id, name, division, paid_entry, waitlisted) VALUES (501, ?, ?, 'MA1', 1, 0)")
        .run(`m_p_${i}`, `Player ${i}`);
    }
    db.resetCounts();
    const holesRes = await fetchJson(env, "/admin/events/501/assign-starting-holes", "POST", admin, { shuffle: false, holeCount: 18 });
    expect(holesRes.status).toBe(200);
    expect(db.roundTrips).toBeLessThan(15);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = 501 AND starting_hole IS NOT NULL").get() as { n: number }).n).toBe(35);

    db.resetCounts();
    const expRes = await fetchJson(env, "/admin/export", "POST", admin, { dry_run: true, includeEventConfig: true });
    expect(expRes.status).toBe(200);
    expect(expRes.data.exportData.tables.event_config).toHaveLength(16);
    expect(expRes.data.exportData.tables.event_config.every((row: Record<string, unknown>) => !("pdga_event" in row))).toBe(true);
    expect(db.roundTrips).toBeLessThan(20);

    // 5. replacePositions (40 positions) & recordMemberNotices (20 members)
    const courseId = Number(db.raw.prepare("INSERT INTO courses (name) VALUES ('Batch Course') RETURNING id").get()!.id);
    const positions = Array.from({ length: 40 }, (_, i) => ({
      course_id: courseId, kind: i < 20 ? ("tee" as const) : ("target" as const), label: `Pos ${i + 1}`, lat: 35.6, lng: -77.3,
    }));
    db.resetCounts();
    const storedPos = await replacePositions(db as never, courseId, positions);
    expect(storedPos).toHaveLength(40);
    expect(db.roundTrips).toBeLessThanOrEqual(5);

    db.resetCounts();
    await recordMemberNotices(env, Array.from({ length: 20 }, (_, i) => `m_n_${i}`), {
      kind: "bag-tag", title: "Notice", body: "Hello", href: "/gvdg-members.html#tags", refKey: "batch:1",
    });
    expect(db.roundTrips).toBeLessThanOrEqual(3);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM member_notices WHERE ref_key = 'batch:1'").get() as { n: number }).n).toBe(20);

    // 6. saveUdiscLeague dedupes duplicate external_url in same batch & skips no-op UPDATE events on unchanged re-imports
    const udiscEvents = Array.from({ length: 6 }, (_, i) => ({
      type: "league_round" as const,
      source: "udisc" as const,
      name: `Week ${i + 1}`,
      date: `2026-10-0${i + 1}`,
      format: "stroke",
      external_url: `https://udisc.com/events/w-${i + 1}`,
      notes: "Weekly",
    }));
    const league = { type: "league", source: "udisc", name: "Sunday Tags", date: null, format: null, external_url: "https://udisc.com/leagues/sunday-tags-12ab" };
    await saveUdiscLeague(env, "m_admin", { league, events: [...udiscEvents, { ...udiscEvents[0]! }], standings: null });
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE external_url = 'https://udisc.com/events/w-1'").get() as { n: number }).n).toBe(1);
    db.resetCounts();
    await saveUdiscLeague(env, "m_admin", { league, events: udiscEvents, standings: null });
    expect(db.log.filter((sql) => /^UPDATE events/i.test(sql))).toEqual([]);
  });
});
