import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import {
  lookupPdgaPlayer, lookupPdgaPlayers, normalPdgaNumber, PdgaApiError, resetPdgaApiSession, searchPdgaEvents, type PdgaApiEnv,
} from "../src/pdga-api.js";
import { listNearbyPdgaEvents, pdgaApiEventDate, pdgaApiTierLabel } from "../src/pdga-events.js";
import { runPdgaRegistrationTick } from "../src/pdga-registrations.js";
import { runRatingsRecompute } from "../src/ratings-recompute.js";

// The official PDGA REST API (the club's developer account): login once and reuse the session, cache players, and
// let ratings, membership and event search use it when the login is configured (the earlier sources otherwise).

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
  it("lists a state's PDGA events for the clubmates check from the API (each event's own page still lists who registered)", async () => {
    const pdga = fakePdga({ events: [
      { tournament_id: "501", tournament_name: "Greenville Open", city: "Greenville", state_prov: "NC", start_date: "2026-11-21", end_date: "2026-11-22", tier: "B" },
    ] });
    vi.stubGlobal("fetch", pdga.handler);
    const roster = kv({ "member:m_80024": JSON.stringify({ memberId: "m_80024", name: "Ada Lovelace", pdgaNo: "80024", pinHash: "x", mustChangePin: false }) });
    const env = { ...apiEnv(), ROSTER: roster } as unknown as Env;
    const read: string[] = [];
    const tick = await runPdgaRegistrationTick(env, NOW, async (url) => {
      read.push(url);
      return `<table><tr><td class="player"><a href="/player/80024">Ada</a></td><td class="pdga-number">80024</td></tr></table>`;
    });
    expect(tick).toMatchObject({ state: "NC", listed: 1, removed: 0 });
    expect(read.some((url) => url.includes("/tour/search"))).toBe(false);
    expect(db.raw.prepare("SELECT event_id, name, tier, location, start_date, end_date FROM pdga_watch_events").all()).toEqual([
      { event_id: 501, name: "Greenville Open", tier: "B", location: "Greenville, NC", start_date: "2026-11-21", end_date: "2026-11-22" },
    ]);
  });

  it("lists nearby PDGA events from the API with their PDGA pages, nearest within 100 miles, soonest first", async () => {
    const pdga = fakePdga({ events: [
      { tournament_id: "702", tournament_name: "Later B", city: "Raleigh", state_prov: "NC", latitude: "35.78", longitude: "-78.64",
        start_date: "2027-01-09", end_date: "2027-01-10", tier: "B", registration_url: "https://www.discgolfscene.com/tournaments/later" },
      { tournament_id: "701", tournament_name: "Soon C", city: "Greenville", state_prov: "NC", latitude: "35.61", longitude: "-77.37",
        start_date: "2026-12-05", end_date: "2026-12-05", tier: "C" },
      { tournament_id: "703", tournament_name: "Far", city: "Atlanta", state_prov: "GA", latitude: "33.75", longitude: "-84.39",
        start_date: "2026-12-01", end_date: "2026-12-01", tier: "A" },
    ] });
    vi.stubGlobal("fetch", pdga.handler);
    const events = await listNearbyPdgaEvents({ ...apiEnv() } as unknown as Env, { lat: 35.6127, lng: -77.3664 }, NOW);
    expect(events.map((event) => [event.name, event.date, event.tier, event.place, event.url, event.pdgaUrl])).toEqual([
      ["Soon C", "Dec 5, 2026", "C-tier", "Greenville, NC", "https://www.pdga.com/tour/event/701", "https://www.pdga.com/tour/event/701"],
      ["Later B", "Jan 9-10, 2027", "B-tier", "Raleigh, NC", "https://www.discgolfscene.com/tournaments/later", "https://www.pdga.com/tour/event/702"],
    ]);
    const search = new URL(pdga.calls.find((call) => call.url.includes("/event?"))!.url).searchParams;
    expect([search.get("latitude"), search.get("longitude"), search.get("proximity_radius")]).toEqual(["35.6127", "-77.3664", "100"]);
    expect(pdga.calls.some((call) => call.url.includes("discgolfscene"))).toBe(false);
    expect([pdgaApiTierLabel("XC"), pdgaApiTierLabel("NT"), pdgaApiTierLabel("L"), pdgaApiEventDate("2026-12-31", "2027-01-01")])
      .toEqual(["XC-tier", "National Tour", "League", "Dec 31, 2026"]);
  });

  it("records rating anchors from the API in one request per batch, without reading pdga.com", async () => {
    const pdga = fakePdga({ players: { "80024": player("80024", 935), "123456": player("123456", 1012) } });
    vi.stubGlobal("fetch", pdga.handler);
    const roster = kv({
      "member:m_80024": JSON.stringify({ memberId: "m_80024", name: "Ada", pdgaNo: "80024", pinHash: "x", mustChangePin: false }),
      "member:m_bo": JSON.stringify({ memberId: "m_bo", name: "Bo", pdgaNo: "123456", pinHash: "x", mustChangePin: false }),
    });
    const env = { ...apiEnv(), ROSTER: roster } as unknown as Env;
    const site = vi.fn(async () => new Response("unused", { status: 500 }));
    const result = await runRatingsRecompute(env, site as unknown as typeof fetch);
    expect(result).toMatchObject({ pdgaRefreshed: 2, pdgaRefreshErrors: 0 });
    expect(site).not.toHaveBeenCalled();
    expect(pdga.calls.filter((call) => call.url.includes("/players"))).toHaveLength(1);
    expect(db.raw.prepare("SELECT member_id, effective_at, rating FROM rating_anchor_snapshots ORDER BY member_id").all()).toEqual([
      { member_id: "m_80024", effective_at: "2026-11-11T00:00:00.000Z", rating: 935 },
      { member_id: "m_bo", effective_at: "2026-11-11T00:00:00.000Z", rating: 1012 },
    ]);
  });

  it("takes the Stats panel's official rating from the API", async () => {
    const pdga = fakePdga({ players: { "80024": player("80024", 941) } });
    vi.stubGlobal("fetch", pdga.handler);
    const env = { ...apiEnv(), ROSTER: kv(), JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    const response = await worker.fetch(new Request("https://worker/pdga-stats?pdga=80024", { headers: { Origin: ORIGIN } }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ official_rating: 941, rating_date: "2026-11-11" });
  });

  it("keeps the earlier sources when the login isn't set", async () => {
    const pdga = fakePdga();
    vi.stubGlobal("fetch", pdga.handler);
    const env = { ...apiEnv(), PDGA_API_USERNAME: "", ROSTER: kv(), JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    await worker.fetch(new Request("https://worker/pdga-stats?pdga=80024", { headers: { Origin: ORIGIN } }), env);
    expect(pdga.calls.some((call) => call.url.startsWith(API))).toBe(false);
    expect(pdga.calls.some((call) => call.url.includes("pdga.com"))).toBe(true);
  });
});
