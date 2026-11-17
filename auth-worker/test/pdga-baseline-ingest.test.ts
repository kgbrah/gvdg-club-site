import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { enqueuePdgaEvent, runPdgaBaselineTick } from "../src/pdga-baseline-ingest.js";
import { handlePdgaBaselines } from "../src/pdga-baseline-routes.js";
import { fixtureJson, pdgaTestDb } from "./pdga-test-db.js";

const NOW = "2026-11-17T12:00:00.000Z";
const SECRET = "x".repeat(40);

type Member = { memberId: string; name: string; pdgaNo?: string; isAdmin?: boolean };

/** Serves the saved PDGA responses; other division/round pairs return the same layouts without scores. */
function pdgaServer(options: { fail?: (url: URL) => boolean; incomplete?: boolean } = {}) {
  const calls: string[] = [];
  const doFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname.split("/").at(-1) + url.search);
    if (options.fail?.(url)) return new Response("unavailable", { status: 503 });
    if (url.pathname.endsWith("/rating-detail")) return Response.json(fixtureJson("rating-detail-sample.json"));
    if (url.pathname.endsWith("live_results_fetch_event")) {
      const event = fixtureJson("event-104547.json");
      if (url.searchParams.get("TournID") !== "104547") return Response.json({ data: [] });
      if (options.incomplete) Object.assign(event.data, { HighestCompletedRound: 1, EndDate: "2026-11-16", StartDate: "2026-11-16" });
      return Response.json(event);
    }
    const round = url.searchParams.get("Round");
    const division = url.searchParams.get("Division");
    const body = fixtureJson(round === "1" ? "round-104547-MA2-1.json" : "round-104547-MPO-2.json");
    if ((round === "1" && division !== "MA2") || (round === "2" && division !== "MPO")) body.data.scores = [];
    return Response.json(body);
  }) as typeof fetch;
  return { calls, doFetch };
}

async function setup(members: Member[] = []) {
  const { db, sqlite } = await pdgaTestDb();
  for (const course of fixtureJson("club-courses-sample.json")) {
    sqlite.prepare("INSERT INTO courses (id, name, location) VALUES (?, ?, ?)").run(course.id, course.name, course.location);
    for (const layout of course.layouts) {
      sqlite.prepare("INSERT INTO course_layouts (id, course_id, name, holes) VALUES (?, ?, ?, ?)")
        .run(layout.id, course.id, layout.name, JSON.stringify(layout.holes));
    }
  }
  const records = new Map(members.map((member) => ["member:" + member.memberId, JSON.stringify({ pinHash: "", ...member })]));
  const env = {
    DB: db, JWT_SECRET: SECRET,
    ROSTER: {
      list: async ({ cursor }: { cursor?: string }) => {
        const keys = [...records.keys()].sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + 3);
        const next = start + page.length;
        return { keys: page.map((name) => ({ name })), list_complete: next >= keys.length, cursor: next >= keys.length ? undefined : String(next) };
      },
      get: async (key: string) => records.get(key) ?? null,
    },
  } as unknown as Env;
  return { db, sqlite, env };
}

describe("PDGA event ingestion", () => {
  it("works an event off in bounded, resumable batches, stores anonymous pairs and matches layouts", async () => {
    const { sqlite, env } = await setup();
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "member-history", official: true }, NOW);
    sqlite.exec(`INSERT INTO casual_rounds (id, round_code, course_id, layout_id, started_at) VALUES (5, 'AYDEN1', 7, 9, '2026-08-01T15:00:00Z');
      INSERT INTO casual_results (casual_round_id, member_id, name, place, total, to_par) VALUES (5, 'm_player', 'Player', 1, 54, -5)`);
    const server = pdgaServer();
    const first = await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW });
    expect(first).toMatchObject({ fetches: 10, eventsTouched: 1, eventsCompleted: 0 });
    expect(sqlite.prepare("SELECT status, json_array_length(pending_json) AS remaining FROM pdga_ingest_queue").get())
      .toEqual({ status: "in_progress", remaining: 11 });
    const second = await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW });
    expect(second.fetches).toBe(10);
    const third = await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW });
    expect(third).toMatchObject({ fetches: 1, eventsCompleted: 1, layoutsMatched: 1, layoutsPending: 1 });
    expect(server.calls.filter((call) => call.startsWith("live_results_fetch_event"))).toHaveLength(1);
    expect(server.calls.filter((call) => call.startsWith("live_results_fetch_round"))).toHaveLength(20);

    expect(sqlite.prepare(`SELECT round_number, pdga_layout_id, round_date, course_name, hole_count, total_par, total_length_ft,
        official_ssa, ratings_status, rated_players FROM pdga_rated_rounds ORDER BY round_number`).all()).toEqual([
      { round_number: 1, pdga_layout_id: 761497, round_date: "2026-07-11", course_name: "Ayden Park", hole_count: 18, total_par: 59,
        total_length_ft: 5947, official_ssa: 49.565, ratings_status: "official", rated_players: 9 },
      { round_number: 2, pdga_layout_id: 761495, round_date: "2026-07-11", course_name: "The Meadow at West Meadowbrook Park", hole_count: 18,
        total_par: 64, total_length_ft: 7404, official_ssa: 55.742, ratings_status: "official", rated_players: 6 },
    ]);
    expect(sqlite.prepare("SELECT pairs_json FROM pdga_round_scores WHERE division = 'MA2'").get())
      .toEqual({ pairs_json: "[[52,974],[55,943],[57,922],[57,922],[58,912],[58,912],[62,870],[64,849],[67,818]]" });
    expect(sqlite.prepare("SELECT pdga_layout_id, course_id, layout_id, quality, review_status FROM pdga_layout_matches ORDER BY pdga_layout_id").all())
      .toEqual([
        { pdga_layout_id: 761495, course_id: null, layout_id: null, quality: "none", review_status: "pending" },
        { pdga_layout_id: 761497, course_id: 7, layout_id: 9, quality: "close", review_status: "auto" },
      ]);
    expect(sqlite.prepare("SELECT stream, source_id, last_code FROM rating_repair_issues").all())
      .toEqual([{ stream: "casual", source_id: 5, last_code: "pdga-baseline-changed" }]);

    // A finished event is not fetched again; nothing is due.
    const idle = await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW });
    expect(idle).toMatchObject({ fetches: 0, eventsTouched: 0 });
  });

  it("re-reads a finished event once its ratings are confirmed official, and on an admin's request", async () => {
    const { sqlite, env } = await setup();
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "admin", official: false }, NOW);
    const server = pdgaServer();
    await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW, fetchBudget: 30 });
    expect(sqlite.prepare("SELECT DISTINCT ratings_status FROM pdga_rated_rounds").all()).toEqual([{ ratings_status: "unconfirmed" }]);
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "member-history", official: false }, NOW);
    expect(sqlite.prepare("SELECT status FROM pdga_ingest_queue").get()).toEqual({ status: "done" });
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "member-history", official: true }, NOW);
    expect(sqlite.prepare("SELECT status, ratings_official, event_json FROM pdga_ingest_queue").get())
      .toEqual({ status: "pending", ratings_official: 1, event_json: null });
    await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW, fetchBudget: 30 });
    expect(sqlite.prepare("SELECT DISTINCT ratings_status FROM pdga_rated_rounds").all()).toEqual([{ ratings_status: "official" }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM pdga_rated_rounds").get()).toEqual({ count: 2 });
  });

  it("backs off on pdga.com failures, keeps progress, and gives up after repeated failures", async () => {
    const { sqlite, env } = await setup();
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "admin", official: false }, NOW);
    let failing = false;
    const server = pdgaServer({ fail: (url) => failing || url.searchParams.get("Division") === "MA1" });
    const first = await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW });
    expect(first).toMatchObject({ fetches: 5, errors: ["event 104547 http-503"] });
    expect(sqlite.prepare("SELECT status, attempts, last_error, next_attempt_at, json_array_length(pending_json) AS remaining FROM pdga_ingest_queue").get())
      .toEqual({ status: "in_progress", attempts: 1, last_error: "http-503", next_attempt_at: "2026-11-17T13:00:00.000Z", remaining: 17 });
    expect(await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW })).toMatchObject({ fetches: 0 });
    failing = true;
    let now = NOW;
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      now = String(sqlite.prepare("SELECT next_attempt_at FROM pdga_ingest_queue").get()!.next_attempt_at);
      await runPdgaBaselineTick(env, { doFetch: server.doFetch, now });
    }
    expect(sqlite.prepare("SELECT status, attempts FROM pdga_ingest_queue").get()).toEqual({ status: "failed", attempts: 6 });
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "admin", official: false }, now);
    expect(sqlite.prepare("SELECT status, attempts FROM pdga_ingest_queue").get()).toEqual({ status: "pending", attempts: 0 });
  });

  it("waits for an unfinished event without counting an attempt, and fails an unknown event", async () => {
    const { sqlite, env } = await setup();
    await enqueuePdgaEvent(env.DB, { tournId: 104547, source: "admin", official: false }, NOW);
    await runPdgaBaselineTick(env, { doFetch: pdgaServer({ incomplete: true }).doFetch, now: NOW });
    expect(sqlite.prepare("SELECT status, attempts, last_error, next_attempt_at, event_json FROM pdga_ingest_queue").get()).toEqual({
      status: "pending", attempts: 0, last_error: "event-not-complete", next_attempt_at: "2026-11-18T12:00:00.000Z", event_json: null,
    });
    await enqueuePdgaEvent(env.DB, { tournId: 5, source: "admin", official: false }, NOW);
    const summary = await runPdgaBaselineTick(env, { doFetch: pdgaServer().doFetch, now: NOW });
    expect(summary.errors).toEqual(["event 5 event-not-found"]);
  });
});

describe("PDGA event discovery", () => {
  it("queues local events from members' public rating history and rests after a full roster pass", async () => {
    const { sqlite, env } = await setup([
      { memberId: "m_a", name: "A", pdgaNo: "273070" }, { memberId: "m_b", name: "B" }, { memberId: "m_c", name: "C", pdgaNo: "#12" },
      { memberId: "m_d", name: "D", pdgaNo: "34" },
    ]);
    const server = pdgaServer();
    const first = await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW, fetchBudget: 3 });
    expect(first).toMatchObject({ membersChecked: 3, fetches: 3 });
    expect(server.calls.filter((call) => call.startsWith("rating-detail"))).toHaveLength(2);
    const queued = sqlite.prepare("SELECT tourn_id, source, ratings_official, event_state FROM pdga_ingest_queue ORDER BY tourn_id").all() as { tourn_id: number }[];
    // Greenville and Ayden NC only (our course sample), within three years.
    expect(queued.map((row) => row.tourn_id)).toEqual([76338, 78031, 86672, 87147, 87798, 88303, 89825, 91304, 97975, 97976, 99178, 104398, 104547]);
    expect(queued[0]).toMatchObject({ source: "member-history", ratings_official: 1, event_state: "NC" });
    expect(sqlite.prepare("SELECT cursor, last_key, pass_completed_at FROM pdga_discovery_state").get())
      .toEqual({ cursor: "3", last_key: null, pass_completed_at: null });
    await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: NOW, fetchBudget: 1 });
    expect(sqlite.prepare("SELECT cursor, pass_completed_at FROM pdga_discovery_state").get()).toEqual({ cursor: null, pass_completed_at: NOW });
    const before = server.calls.filter((call) => call.startsWith("rating-detail")).length;
    await runPdgaBaselineTick(env, { doFetch: server.doFetch, now: "2026-11-20T12:00:00.000Z", fetchBudget: 1 });
    expect(server.calls.filter((call) => call.startsWith("rating-detail")).length).toBe(before);
  });
});

describe("admin PDGA baseline routes", () => {
  async function admin() {
    const context = await setup([{ memberId: "m_admin", name: "Admin", isAdmin: true }, { memberId: "m_member", name: "Member" }]);
    const server = pdgaServer();
    const tokens = {
      admin: await signSession({ sub: "m_admin", mustChangePin: false }, SECRET, 900),
      member: await signSession({ sub: "m_member", mustChangePin: false }, SECRET, 900),
    };
    const call = (path: string, method = "GET", body?: object, token = tokens.admin) => handlePdgaBaselines(new Request(
      "https://auth.gvdgclub.com/admin/pdga-baselines" + path,
      { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: body ? JSON.stringify(body) : undefined },
    ), context.env, "https://gvdgclub.com", server.doFetch);
    return { ...context, call, tokens, server };
  }

  it("is admin-only and makes no PDGA requests for anyone else", async () => {
    const { call, tokens, server } = await admin();
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    expect((await call("/ingest", "POST", {}, tokens.member)).status).toBe(403);
    expect((await call("/events", "POST", { tournId: 104547 }, tokens.member)).status).toBe(403);
    expect(server.calls).toEqual([]);
  });

  it("adds an event, ingests it now, reports per-course baselines, takes review decisions and reports validation", async () => {
    const { call, sqlite } = await admin();
    expect((await call("/events", "POST", { tournId: "abc" })).status).toBe(400);
    expect(await (await call("/events", "POST", { tournId: 104547 })).json()).toEqual({ ok: true, tournId: 104547 });
    const ingest = await (await call("/ingest", "POST", {})).json() as { summary: Record<string, number> };
    expect(ingest.summary).toMatchObject({ eventsCompleted: 0, fetches: 20 });
    await call("/ingest", "POST", {});
    const overview = await (await call("")).json() as { queue: { counts: Record<string, number> }; review: { pdgaLayoutId: number; candidates: unknown[] }[] };
    expect(overview.queue.counts).toEqual({ done: 1 });
    expect(overview.review).toMatchObject([{ pdgaLayoutId: 761495, quality: "none", courseName: "The Meadow at West Meadowbrook Park", rounds: 1 }]);
    expect(overview.review[0]!.candidates.length).toBeGreaterThan(0);

    const ayden = await (await call("/courses/7")).json() as { layouts: { id: number; baseline: { provenance: string } | null; rounds: unknown[] }[] };
    expect(ayden.layouts.find((layout) => layout.id === 9)).toMatchObject({
      baseline: { ssa: 49.565, rounds: 1, provenance: "1 PDGA rated round, 2026, median SSA 49.6" },
      rounds: [{ tournId: 104547, round: 1, ssa: 49.565, ratedPlayers: 9, ratingsStatus: "unconfirmed", reviewStatus: "auto" }],
    });
    expect((await call("/courses/999")).status).toBe(404);

    // The Meadow tournament layout differs in length on four holes: an admin may vouch for it, but not
    // assign it to a layout with different pars.
    expect((await call("/matches/761495", "POST", { action: "assign", layoutId: 2 })).status).toBe(409);
    expect((await call("/matches/761495", "POST", { action: "assign" })).status).toBe(400);
    expect((await call("/matches/761495", "POST", { action: "assign", layoutId: 1 })).status).toBe(200);
    expect(sqlite.prepare("SELECT layout_id, quality, review_status, reviewed_by FROM pdga_layout_matches WHERE pdga_layout_id = 761495").get())
      .toEqual({ layout_id: 1, quality: "none", review_status: "confirmed", reviewed_by: "m_admin" });
    expect(((await (await call("/courses/2")).json()) as { layouts: { id: number; baseline: { rounds: number } | null }[] })
      .layouts.find((layout) => layout.id === 1)?.baseline).toMatchObject({ rounds: 1, ssa: 55.742 });
    expect((await call("/matches/761497", "POST", { action: "reject" })).status).toBe(200);
    expect((await call("/matches/1", "POST", { action: "confirm" })).status).toBe(404);
    // Automatic re-matching never overrides an admin decision.
    await call("/ingest", "POST", {});
    expect(sqlite.prepare("SELECT review_status FROM pdga_layout_matches ORDER BY pdga_layout_id").all())
      .toEqual([{ review_status: "confirmed" }, { review_status: "rejected" }]);

    const validation = await (await call("/validation")).json();
    expect(validation).toMatchObject({ status: "no-data", matchedRounds: 1, formulaPairs: 6, ratingPairs: 0 });
  });
});
