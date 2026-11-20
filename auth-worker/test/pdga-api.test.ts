import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import {
  lookupPdgaPlayer, lookupPdgaPlayers, normalPdgaNumber, PdgaApiError, purgePdgaCaches, resetPdgaApiSession, searchPdgaEvents, type PdgaApiEnv,
} from "../src/pdga-api.js";
import { freshPdgaEventCopy, refreshClubPdgaEventCopies, stampPdgaEvent } from "../src/pdga-event-cache.js";
import { listNearbyPdgaEvents, pdgaApiEventDate, pdgaApiTierLabel } from "../src/pdga-events.js";
import { ANCHOR_KEEP_DAYS, runRatingsRecompute } from "../src/ratings-recompute.js";

// The official PDGA REST API (the club's developer account) is the ONLY way the Worker reads PDGA data (PDGA's
// Developer Program, 2026-11-20): login once and reuse the session, cache players a few hours, and purge every PDGA
// cache past its time (the API license allows temporary caching only).

const API = "https://api.test.pdga";
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0); // an NC hour for the registrations tick
const ORIGIN = "http://localhost:8080";

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const names = [...rows.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return stmt;
  };
  return {
    raw: db,
    prepare,
    async batch(statements: { run(): Promise<unknown> }[]) { const out = []; for (const statement of statements) out.push(await statement.run()); return out; },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fake PDGA API: login hands out SESS=<n>; players and events answer from the given data. */
function fakePdga(options: {
  players?: Record<string, Record<string, unknown>>;
  events?: Record<string, unknown>[];
  refuseFirst?: boolean;
  limited?: boolean;
} = {}) {
  const calls: Call[] = [];
  let logins = 0;
  let refused = false;
  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    calls.push({ url, method: init?.method ?? "GET", headers, body: String(init?.body ?? "") });
    if (!url.startsWith(API)) return new Response("not found", { status: 404 });
    if (options.limited) return Response.json({ status: 4, errmsg: "Rate limit exceeded." }, { status: 429 });
    const path = new URL(url);
    if (path.pathname === "/services/json/user/login") {
      logins += 1;
      return Response.json({ sessid: "abc" + logins, session_name: "SESS", token: "tok" + logins, user: {} });
    }
    if (options.refuseFirst && !refused) {
      refused = true;
      return Response.json({ status: 3 }, { status: 403 });
    }
    if (path.pathname === "/services/json/players") {
      const numbers = (path.searchParams.get("pdga_number") ?? "").split(",");
      const players = numbers.flatMap((number) => options.players?.[number] ? [options.players[number]] : []);
      return Response.json({ sessid: "abc", status: 0, players, not_found: numbers.filter((number) => !options.players?.[number]) });
    }
    if (path.pathname === "/services/json/event") {
      const offset = Number(path.searchParams.get("offset") ?? 0);
      const all = options.events ?? [];
      return Response.json({ sessid: "abc", status: 0, events: all.slice(offset, offset + 200) });
    }
    return new Response("not found", { status: 404 });
  };
  return { handler, calls, logins: () => logins };
}

const player = (number: string, rating: number | null, extra: Record<string, unknown> = {}) => ({
  first_name: "Ada", last_name: "Lovelace", pdga_number: number, membership_status: rating == null ? "expired" : "current",
  membership_expiration_date: "2027-12-31", classification: "A", city: "Greenville", state_prov: "NC", country: "US",
  ...(rating == null ? {} : { rating: String(rating), rating_effective_date: "2026-11-11" }), ...extra,
});

let db: Awaited<ReturnType<typeof sqliteDb>>;
let ratelimit: ReturnType<typeof kv>;
const apiEnv = (): PdgaApiEnv => ({ DB: db as never, RATELIMIT: ratelimit, PDGA_API_USERNAME: "club", PDGA_API_PASSWORD: "pw", PDGA_API_BASE: API });

beforeEach(async () => {
  db = await sqliteDb();
  ratelimit = kv();
  resetPdgaApiSession();
});
afterEach(() => vi.unstubAllGlobals());

describe("the PDGA API client", () => {
  it("logs in once, sends the session cookie, reads players in one request, and keeps them for a few hours", async () => {
    const pdga = fakePdga({ players: { "80024": player("80024", 935), "123456": player("123456", null) } });
    vi.stubGlobal("fetch", pdga.handler);
    const now = Date.now();
    const found = await lookupPdgaPlayers(apiEnv(), ["80024", "#123456", "999"], now);
    expect(found.get("80024")).toMatchObject({ name: "Ada Lovelace", membershipStatus: "current", rating: 935, ratingDate: "2026-11-11",
      classification: "A", url: "https://www.pdga.com/player/80024" });
    expect(found.get("123456")).toMatchObject({ membershipStatus: "expired", rating: null });
    expect(found.get("999")).toBeNull();
    expect(pdga.logins()).toBe(1);
    const read = pdga.calls.filter((call) => call.url.includes("/players"));
    expect(read).toHaveLength(1);
    expect(read[0]!.url).toContain("pdga_number=80024,123456,999");
    expect(read[0]!.headers.cookie).toBe("SESS=abc1");
    expect(JSON.parse(pdga.calls[0]!.body)).toEqual({ username: "club", password: "pw" });
    // Cached: no second request, even from a new isolate (the session is stored too).
    resetPdgaApiSession();
    expect(await lookupPdgaPlayer(apiEnv(), "80024")).toMatchObject({ rating: 935 });
    expect(pdga.calls).toHaveLength(2);
    // Hours later the record is read again, on the stored session (no new login).
    await lookupPdgaPlayers(apiEnv(), ["80024"], now + 7 * 3_600_000);
    expect(pdga.logins()).toBe(1);
    expect(pdga.calls.filter((call) => call.url.includes("/players"))).toHaveLength(2);
  });

  it("logs in again once when PDGA refuses the session, and reports rate limits and a missing login", async () => {
    const refusing = fakePdga({ players: { "80024": player("80024", 935) }, refuseFirst: true });
    vi.stubGlobal("fetch", refusing.handler);
    expect(await lookupPdgaPlayer(apiEnv(), "80024")).toMatchObject({ rating: 935 });
    expect(refusing.logins()).toBe(2);

    resetPdgaApiSession();
    ratelimit = kv();
    vi.stubGlobal("fetch", fakePdga({ limited: true }).handler);
    await expect(lookupPdgaPlayer(apiEnv(), "55555")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(lookupPdgaPlayer({ ...apiEnv(), PDGA_API_PASSWORD: "" }, "55555")).rejects.toBeInstanceOf(PdgaApiError);
    expect(normalPdgaNumber(" #80024 ")).toBe("80024");
    expect(normalPdgaNumber("0")).toBeNull();
    expect(normalPdgaNumber("12a")).toBeNull();
  });

  it("searches events by state or distance, every page", async () => {
    const events = Array.from({ length: 230 }, (_, index) => ({
      tournament_id: String(90000 + index), tournament_name: "Event " + index, city: "Greenville", state_prov: "NC",
      latitude: "35.6", longitude: "-77.37", start_date: "2026-12-05", end_date: "2026-12-06", tier: "C", status: "sanctioned",
      registration_url: "https://www.discgolfscene.com/tournaments/e" + index,
    }));
    const pdga = fakePdga({ events });
    vi.stubGlobal("fetch", pdga.handler);
    const found = await searchPdgaEvents(apiEnv(), { startDate: "2026-11-18", endDate: "2027-01-31", states: ["NC"] });
    expect(found).toHaveLength(230);
    expect(found[0]).toMatchObject({ id: 90000, name: "Event 0", tier: "C", lat: 35.6, lng: -77.37, url: "https://www.pdga.com/tour/event/90000" });
    const searches = pdga.calls.filter((call) => call.url.includes("/event?"));
    expect(searches.map((call) => new URL(call.url).searchParams.get("offset"))).toEqual(["0", "200"]);
    expect(new URL(searches[0]!.url).searchParams.get("administrative_area")).toBe("NC");
  });
});

describe("features using the official API when the club's login is set", () => {
  it("lists nearby PDGA events from the API with their PDGA pages, nearest within 100 miles, soonest first", async () => {
    const pdga = fakePdga({ events: [
      { tournament_id: "702", tournament_name: "Later B", city: "Raleigh", state_prov: "NC", latitude: "35.78", longitude: "-78.64",
        start_date: "2027-01-09", end_date: "2027-01-10", tier: "B", registration_url: "https://www.discgolfscene.com/tournaments/later" },
      { tournament_id: "701", tournament_name: "Soon C", city: "Greenville", state_prov: "NC", latitude: "35.61", longitude: "-77.37",
        start_date: "2026-12-05", end_date: "2026-12-05", tier: "C" },
      { tournament_id: "703", tournament_name: "Far", city: "Atlanta", state_prov: "GA", latitude: "33.75", longitude: "-84.39",
        start_date: "2026-12-01", end_date: "2026-12-01", tier: "A" },
      // A weekly league that began in September and is still running: not listed (no "Register" for it).
      { tournament_id: "704", tournament_name: "Shelob's Web (Flex Start)", city: "New Hill", state_prov: "NC", latitude: "35.66", longitude: "-78.93",
        start_date: "2026-09-22", end_date: "2026-12-15", tier: "L" },
    ] });
    vi.stubGlobal("fetch", pdga.handler);
    // The club runs "Later B" (PDGA 702) as club event 9: its Register opens the club's event page.
    db.raw.exec("INSERT INTO events (id, name, type, status, date) VALUES (9, 'Later B', 'tournament', 'scheduled', '2027-01-09')");
    db.raw.exec("INSERT INTO event_config (event_id, pdga_event_id) VALUES (9, 702)");
    const events = await listNearbyPdgaEvents({ ...apiEnv() } as unknown as Env, { lat: 35.6127, lng: -77.3664 }, NOW);
    expect(events.map((event) => [event.name, event.date, event.tier, event.place, event.url, event.pdgaUrl])).toEqual([
      ["Soon C", "Dec 5, 2026", "C-tier", "Greenville, NC", "https://www.pdga.com/tour/event/701", "https://www.pdga.com/tour/event/701"],
      ["Later B", "Jan 9-10, 2027", "B-tier", "Raleigh, NC", "/events#event/9", "https://www.pdga.com/tour/event/702"],
    ]);
    const search = new URL(pdga.calls.find((call) => call.url.includes("/event?"))!.url).searchParams;
    expect([search.get("latitude"), search.get("longitude"), search.get("proximity_radius")]).toEqual(["35.6127", "-77.3664", "100"]);
    expect(pdga.calls.some((call) => call.url.includes("discgolfscene"))).toBe(false);
    expect([pdgaApiTierLabel("XC"), pdgaApiTierLabel("NT"), pdgaApiTierLabel("L")]).toEqual(["XC-tier", "National Tour", "League"]);
    // A league still running shows its whole span, not a start day already past.
    expect([pdgaApiEventDate("2026-12-05", "2026-12-05"), pdgaApiEventDate("2027-01-09", "2027-01-10"), pdgaApiEventDate("2026-09-13", "2026-12-20"),
      pdgaApiEventDate("2026-12-31", "2027-01-01")]).toEqual(["Dec 5, 2026", "Jan 9-10, 2027", "Sep 13 – Dec 20, 2026", "Dec 31, 2026 – Jan 1, 2027"]);
  });

  it("records rating anchors from the API in one request per batch, without reading pdga.com", async () => {
    const pdga = fakePdga({ players: { "80024": player("80024", 935), "123456": player("123456", 1012) } });
    vi.stubGlobal("fetch", pdga.handler);
    const roster = kv({
      "member:m_80024": JSON.stringify({ memberId: "m_80024", name: "Ada", pdgaNo: "80024", pinHash: "x", mustChangePin: false }),
      "member:m_bo": JSON.stringify({ memberId: "m_bo", name: "Bo", pdgaNo: "123456", pinHash: "x", mustChangePin: false }),
    });
    const env = { ...apiEnv(), ROSTER: roster } as unknown as Env;
    const result = await runRatingsRecompute(env, new Date(NOW));
    expect(result).toMatchObject({ pdgaRefreshed: 2, pdgaRefreshErrors: 0 });
    expect(pdga.calls.filter((call) => call.url.includes("/players"))).toHaveLength(1);
    expect(pdga.calls.every((call) => call.url.startsWith(API))).toBe(true);
    expect(db.raw.prepare("SELECT member_id, effective_at, rating FROM rating_anchor_snapshots ORDER BY member_id").all()).toEqual([
      { member_id: "m_80024", effective_at: "2026-11-11T00:00:00.000Z", rating: 935 },
      { member_id: "m_bo", effective_at: "2026-11-11T00:00:00.000Z", rating: 1012 },
    ]);
  });

  it("keeps a member's PDGA rating only while the API confirms it, and deletes it 7 days after it stops", async () => {
    let rating = 935;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => fakePdga({ players: { "80024": player("80024", rating) } }).handler(input, init));
    const roster = kv({ "member:m_80024": JSON.stringify({ memberId: "m_80024", name: "Ada", pdgaNo: "80024", pinHash: "x", mustChangePin: false }) });
    const env = { ...apiEnv(), ROSTER: roster } as unknown as Env;
    const day = (n: number) => new Date(NOW + n * 86_400_000);
    // An old rating history (as the club used to keep) goes on the first run, except what PDGA still confirms.
    db.raw.exec("INSERT INTO rating_anchor_snapshots (member_id, observed_at, effective_at, rating, confirmed_at) VALUES ('m_old', '2025-01-01T00:00:00.000Z', '2024-12-11T00:00:00.000Z', 900, '2025-01-01T00:00:00.000Z')");
    await runRatingsRecompute(env, day(0));
    await runRatingsRecompute(env, day(1)); // the same rating: confirmed, not added again
    const rows = () => db.raw.prepare("SELECT member_id, rating, observed_at, confirmed_at FROM rating_anchor_snapshots ORDER BY observed_at").all();
    expect(rows()).toEqual([{ member_id: "m_80024", rating: 935, observed_at: day(0).toISOString(), confirmed_at: day(1).toISOString() }]);
    // PDGA publishes a new rating: the old one stays a week for rounds played before it, then goes.
    rating = 948;
    resetPdgaApiSession();
    db.raw.exec("DELETE FROM pdga_api_players");
    await runRatingsRecompute(env, day(2));
    expect(rows().map((row) => (row as { rating: number }).rating)).toEqual([935, 948]);
    db.raw.exec("DELETE FROM pdga_api_players");
    await runRatingsRecompute(env, day(2 + ANCHOR_KEEP_DAYS + 1));
    expect(rows().map((row) => (row as { rating: number }).rating)).toEqual([948]);
  });

  it("purges PDGA player records and nearby-event lists past their cache time", async () => {
    vi.stubGlobal("fetch", fakePdga({ players: { "80024": player("80024", 941) } }).handler);
    await lookupPdgaPlayer(apiEnv(), "80024");
    db.raw.exec("INSERT INTO kv_store (ns, key, value, expires_at) VALUES ('pdgaevents', 'old', '[]', 1), ('pdgaevents', 'fresh', '[]', 9999999999999), ('ratelimit', 'x', '1', 1)");
    expect(await purgePdgaCaches({ DB: db as never }, Date.now())).toEqual({ players: 0, events: 1 });
    expect(await purgePdgaCaches({ DB: db as never }, Date.now() + 6 * 3_600_000 + 1)).toEqual({ players: 1, events: 0 });
    expect(db.raw.prepare("SELECT ns, key FROM kv_store ORDER BY ns, key").all()).toEqual([{ ns: "pdgaevents", key: "fresh" }, { ns: "ratelimit", key: "x" }]);
  });

  it("re-reads the club's PDGA events from the API, and clears PDGA data from events two weeks past", async () => {
    const pdga = fakePdga({ events: [{ tournament_id: "702", tournament_name: "Greenville Open", tier: "B", start_date: "2026-12-05", end_date: "2026-12-06" }] });
    vi.stubGlobal("fetch", pdga.handler);
    db.raw.exec(`INSERT INTO events (id, name, type, status, date) VALUES (9, 'Greenville Open', 'tournament', 'scheduled', '2026-12-05'),
      (8, 'Spring Open', 'tournament', 'final', '2026-03-01')`);
    db.raw.exec(`INSERT INTO event_config (event_id, pdga_event_id, pdga_event) VALUES (9, 702, '{"name":"stale copy"}'), (8, 650, '{"name":"old"}')`);
    db.raw.exec(`INSERT INTO registrations (event_id, member_id, name, pdga_number, pdga_status, pdga_rating) VALUES
      (9, 'm_a', 'Ada', '80024', 'current', 935), (8, 'm_a', 'Ada', '80024', 'current', 930)`);
    expect(await refreshClubPdgaEventCopies({ ...apiEnv() }, NOW)).toEqual({ refreshed: 1, cleared: 0, pastCleared: 1 });
    const copy = (id: number) => (db.raw.prepare("SELECT pdga_event FROM event_config WHERE event_id = ?").get(id) as { pdga_event: string | null }).pdga_event;
    expect(freshPdgaEventCopy(copy(9), NOW)).toMatchObject({ id: 702, name: "Greenville Open", tier: "B" });
    expect(copy(8)).toBeNull();
    expect(db.raw.prepare("SELECT event_id, pdga_number, pdga_status, pdga_rating FROM registrations ORDER BY event_id").all()).toEqual([
      { event_id: 8, pdga_number: "80024", pdga_status: null, pdga_rating: null },
      { event_id: 9, pdga_number: "80024", pdga_status: "current", pdga_rating: 935 },
    ]);
    // A copy counts only while fresh; one without a read time (from before) counts as none.
    expect(freshPdgaEventCopy(copy(9), NOW + 24 * 3_600_000 + 1)).toBeNull();
    expect(freshPdgaEventCopy('{"name":"stale copy"}', NOW)).toBeNull();
    expect(freshPdgaEventCopy(stampPdgaEvent({ id: 1, name: "X", tier: "C", status: "", startDate: "", endDate: "", city: null, state: null, director: null, registrationUrl: null, url: "" }, NOW), NOW)).toMatchObject({ name: "X" });
  });

  it("takes the Stats panel's official rating from the API", async () => {
    const pdga = fakePdga({ players: { "80024": player("80024", 941) } });
    vi.stubGlobal("fetch", pdga.handler);
    const env = { ...apiEnv(), ROSTER: kv(), JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    const response = await worker.fetch(new Request("https://worker/pdga-stats?pdga=80024", { headers: { Origin: ORIGIN } }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ official_rating: 941, rating_date: "2026-11-11", events: [], live_rating: null, source: "pdga-api" });
    expect(pdga.calls.every((call) => call.url.startsWith(API))).toBe(true);
  });

  it("reads nothing from PDGA at all when the login isn't set (no pdga.com pages, no internal endpoints)", async () => {
    const pdga = fakePdga();
    vi.stubGlobal("fetch", pdga.handler);
    const roster = kv({ "member:m_80024": JSON.stringify({ memberId: "m_80024", name: "Ada", pdgaNo: "80024", pinHash: "x", mustChangePin: false }) });
    const env = { ...apiEnv(), PDGA_API_USERNAME: "", ROSTER: roster, JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    const response = await worker.fetch(new Request("https://worker/pdga-stats?pdga=80024", { headers: { Origin: ORIGIN } }), env);
    expect(await response.json()).toMatchObject({ official_rating: null, events: [] });
    await runRatingsRecompute(env, new Date(NOW));
    expect(pdga.calls).toEqual([]);
  });

  it("no longer serves the scraped registration lists or the PDGA baseline admin", async () => {
    const env = { ...apiEnv(), ROSTER: kv(), JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    for (const path of ["/pdga-registrations", "/admin/pdga-registrations/status", "/admin/pdga-baselines"]) {
      const response = await worker.fetch(new Request("https://worker" + path, { headers: { Origin: ORIGIN } }), env);
      expect([401, 403, 404]).toContain(response.status);
    }
  });
});
