import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";
import { PDGA_STATS_VERSION, statsFromPlayer } from "../src/pdga.js";

// PDGA Developer Program review (2026-11-20): the Worker reads PDGA data ONLY through PDGA's documented developer API
// (api.pdga.com), never pdga.com pages or internal endpoints, and keeps it only temporarily.

const ORIGIN = "http://localhost:8080";
const API = "https://api.test.pdga";

function memoryKv() {
  const rows = new Map<string, string>();
  return {
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

async function env(players: Record<string, Record<string, unknown>> = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE pdga_api_players (pdga_number TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER NOT NULL)");
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { bound = args; return statement; },
      async all() { return { results: sqlite.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return sqlite.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = sqlite.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return statement;
  };
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/services/json/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
    const numbers = (new URL(url).searchParams.get("pdga_number") ?? "").split(",");
    return Response.json({ players: numbers.flatMap((number) => players[number] ? [players[number]] : []) });
  });
  resetPdgaApiSession();
  return {
    calls,
    env: {
      DB: { prepare, async batch(statements: { run(): Promise<unknown> }[]) { for (const s of statements) await s.run(); return []; } },
      RATELIMIT: memoryKv(), ROSTER: memoryKv(), JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: ORIGIN,
      PDGA_API_USERNAME: "club", PDGA_API_PASSWORD: "pw", PDGA_API_BASE: API,
    } as unknown as Env,
  };
}

const stats = (target: Env, query: string, ip = "203.0.113.9") =>
  worker.fetch(new Request("https://worker/pdga-stats?" + query, { headers: { Origin: ORIGIN, "CF-Connecting-IP": ip } }), target);

afterEach(() => vi.unstubAllGlobals());

describe("GET /pdga-stats", () => {
  it("returns only the official rating and its date from the PDGA API; the scraped history fields stay empty", async () => {
    const { env: target, calls } = await env({ "80024": { pdga_number: "80024", first_name: "Ada", last_name: "Lovelace",
      membership_status: "current", rating: "941", rating_effective_date: "2026-11-11" } });
    const response = await stats(target, "pdga=80024");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(statsFromPlayer("80024", {
      pdgaNumber: "80024", name: "Ada Lovelace", membershipStatus: "current", membershipExpires: null, rating: 941, ratingDate: "2026-11-11",
      classification: null, city: null, state: null, country: null, url: "https://www.pdga.com/player/80024",
    }));
    expect(calls.every((url) => url.startsWith(API + "/services/json/"))).toBe(true);
    const body = statsFromPlayer("1", null);
    expect(body).toMatchObject({ official_rating: null, previous_rating: null, live_rating: null, peak_rating: null, events_count: 0,
      events: [], play_rounds: [], source: "pdga-api", stats_version: PDGA_STATS_VERSION });
  });

  it("serves a cached record without calling PDGA or counting against the per-IP limit", async () => {
    const { env: target, calls } = await env({ "80024": { pdga_number: "80024", rating: "941", rating_effective_date: "2026-11-11" } });
    await stats(target, "pdga=80024");
    const before = calls.length;
    for (let i = 0; i < 40; i++) expect((await stats(target, "pdga=80024")).status).toBe(200);
    expect(calls.length).toBe(before);
  });

  it("rejects bad numbers, and answers the QA drive's member without calling PDGA", async () => {
    const { env: target, calls } = await env();
    expect((await stats(target, "pdga=abc")).status).toBe(400);
    expect(await (await stats(target, "pdga=90000001")).json()).toMatchObject({ official_rating: 935, events: [] });
    expect(calls).toEqual([]);
  });
});

describe("the Worker's PDGA sources", () => {
  it("has no pdga.com page reads, internal endpoints or Live API storage left in its code", () => {
    const dir = new URL("../src/", import.meta.url);
    const walk = (sub: string): string[] => readdirSync(new URL(sub, dir)).map(String).flatMap((name) => {
      if (name.endsWith(".ts")) return [sub + name];
      try { return walk(sub + name + "/"); } catch { return []; } // not a directory
    });
    const files = walk("").filter((name) => name.endsWith(".ts"));
    const offenders = files.flatMap((name) => {
      const text = readFileSync(new URL(name, dir), "utf8");
      return [/pdga\.com\/api\/v1/, /feat\/members/, /rating-detail/, /apps\/tournament\/live-api/, /live_results_fetch/,
        /fetch\([^)]*pdga\.com\/(?:player|tour)/, /GVDG-DGS-Scraper/, /discgolfscene\.com\/tournaments\/search/,
        /parseDiscGolfScene/, /safeFetch\([^)]*discgolfscene/].flatMap((pattern) => pattern.test(text) ? [name + " " + pattern] : []);
    });
    expect(offenders).toEqual([]);
  });
});
