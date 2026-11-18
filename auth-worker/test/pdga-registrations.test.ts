import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import {
  clubDay, EVENTS_PER_TICK, parsePdgaDates, parsePdgaSearch, parseRegisteredPlayers, pdgaSearchUrl, runPdgaRegistrationTick, stateForHour,
} from "../src/pdga-registrations.js";

const SECRET = "x".repeat(40);
const ORIGIN = "http://localhost:8080";
// 2026-11-18 15:00 UTC: hour 491,055 since the epoch -> NC (491055 % 3 === 0).
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0);

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
  return {
    raw: db,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() { const info = db.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
      };
      return stmt;
    },
  };
}

const member = (memberId: string, name: string, pdgaNo: string) => JSON.stringify({ memberId, name, pdgaNo, pinHash: "x", mustChangePin: false });

/** A search results page in PDGA's markup (trimmed). */
function searchPage(rows: Array<{ id: number; name: string; tier?: string; where?: string; dates: string }>, more = false) {
  return `<table><tbody>${rows.map((row, index) => `<tr class="${index % 2 ? "even" : "odd"} tid-${row.id} tier-${row.tier || "C"} type-N status-Sanctioned">
    <td class="views-field views-field-OfficialName" > <a href="/tour/event/${row.id}">${row.name}</a> </td>
    <td class="views-field views-field-Classification" > Pro-Am </td>
    <td class="views-field views-field-Tier" > ${row.tier || "C"} </td>
    <td class="views-field views-field-TDPDGANum" > <a href="/player/80023">Pat Director #80023</a> </td>
    <td class="views-field views-field-Location" > ${row.where || "Greenville, North Carolina, United States"} </td>
    <td class="views-field views-field-StartDate" > ${row.dates} </td></tr>`).join("")}</tbody></table>
    <ul class="pager">${more ? '<li class="pager-next"><a href="?page=1">next ›</a></li>' : ""}</ul>`;
}

/** An event page's registration tables in PDGA's markup (trimmed): the TD's link is not a registration. */
function eventPage(divisions: Record<string, string[]>) {
  return `<div class="tournament-director"><a href="/player/80023">Pat Director</a></div>${Object.entries(divisions).map(([division, numbers]) => `
    <details open><summary><h3 class="division" id="${division}">${division} &middot; Division <span class="players"> (${numbers.length})</span></h3></summary>
    <div class="table-container"><table class="results sticky-enabled"><tbody>${numbers.map((n) => `
      <tr class="odd"><td class="player"><a href="/player/${n}" class="tooltip">Player ${n}</a></td><td class="pdga-number">${n}</td><td class="player-rating">900</td></tr>`).join("")}
    </tbody></table></div></details>`).join("")}`;
}

describe("reading PDGA's pages", () => {
  it("reads PDGA's date ranges, including across months and years", () => {
    expect(parsePdgaDates("November 21, 2026")).toEqual({ start: "2026-11-21", end: "2026-11-21" });
    expect(parsePdgaDates("November 21 - 22, 2026")).toEqual({ start: "2026-11-21", end: "2026-11-22" });
    expect(parsePdgaDates("September 13 - November 29, 2026")).toEqual({ start: "2026-09-13", end: "2026-11-29" });
    expect(parsePdgaDates("December 30, 2026 - January 2, 2027")).toEqual({ start: "2026-12-30", end: "2027-01-02" });
    expect(parsePdgaDates("December 30 - January 2, 2027")).toEqual({ start: "2026-12-30", end: "2027-01-02" });
    expect(parsePdgaDates(" Nov 7 – 8, 2026 ")).toEqual({ start: "2026-11-07", end: "2026-11-08" });
    for (const bad of ["", "TBA", "February 30, 2027", "November 22 - 21, 2026", "Smarch 3, 2026"]) expect(parsePdgaDates(bad), bad).toBeNull();
  });

  it("reads the search results and whether more pages follow", () => {
    const page = parsePdgaSearch(searchPage([
      { id: 107952, name: "Fall Sunday Singles", tier: "L", where: "Asheville, North Carolina, United States", dates: "September 13 - November 29, 2026" },
      { id: 108072, name: "AR.RAL Shelob&#039;s Web &amp; Buckhorn", dates: "November 22, 2026" },
      { id: 1, name: "Undated", dates: "TBA" },
    ], true));
    expect(page.more).toBe(true);
    expect(page.events).toEqual([
      { eventId: 107952, name: "Fall Sunday Singles", tier: "L", location: "Asheville, North Carolina", start: "2026-09-13", end: "2026-11-29" },
      { eventId: 108072, name: "AR.RAL Shelob's Web & Buckhorn", tier: "C", location: "Greenville, North Carolina", start: "2026-11-22", end: "2026-11-22" },
    ]);
    expect(parsePdgaSearch(searchPage([])).more).toBe(false);
  });

  it("reads registered PDGA numbers by division, never the Tournament Director's link", () => {
    expect(parseRegisteredPlayers(eventPage({ MPO: ["27523", "116486"], MA3: ["80024"] }))).toEqual([
      { pdga: "27523", division: "MPO" }, { pdga: "116486", division: "MPO" }, { pdga: "80024", division: "MA3" },
    ]);
    expect(parseRegisteredPlayers("<p>No one yet</p>")).toEqual([]);
  });

  it("searches one state an hour, in turn, over the next four months", () => {
    expect([0, 1, 2, 3].map((hour) => stateForHour(NOW + hour * 3_600_000))).toEqual(["NC", "VA", "SC", "NC"]);
    const url = new URL(pdgaSearchUrl("VA", NOW, 2));
    expect(url.origin + url.pathname).toBe("https://www.pdga.com/tour/search");
    const params: string[][] = [];
    url.searchParams.forEach((value, key) => { params.push([key, value]); });
    expect(params).toEqual([
      ["date_filter[min][date]", "2026-11-18"], ["date_filter[max][date]", "2027-03-18"], ["State[]", "VA"], ["page", "2"],
    ]);
    expect(clubDay(Date.UTC(2026, 10, 19, 3, 0))).toBe("2026-11-18"); // 10 pm in Greenville
  });
});

describe("the hourly registration check", () => {
  let db: Awaited<ReturnType<typeof sqliteDb>>;
  let roster: ReturnType<typeof kv>;
  let env: Env;
  let pages: Map<string, string>;
  let fetched: string[];
  const fetchText = async (url: string) => {
    fetched.push(url);
    const parsed = new URL(url);
    const key = parsed.pathname.startsWith("/tour/event/") ? parsed.pathname : "search:" + parsed.searchParams.get("State[]") + ":" + (parsed.searchParams.get("page") || "0");
    const page = pages.get(key);
    if (page == null) throw new Error("fetch_failed_404");
    return page;
  };

  beforeEach(async () => {
    db = await sqliteDb();
    roster = kv({
      "member:m_80024": member("m_80024", "Ada Lovelace", "80024"), "idx:pdga:80024": "m_80024",
      "member:m_u_bo": member("m_u_bo", "Bo Burnham", "123456"), "idx:pdga:123456": "m_u_bo",
      "member:m_cy": member("m_cy", "Cy Young", ""),
    });
    env = { DB: db, ROSTER: roster, RATELIMIT: kv(), JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN } as unknown as Env;
    pages = new Map();
    fetched = [];
  });

  it("lists the state's events, finds club members on their lists, and drops withdrawals and finished events", async () => {
    pages.set("search:NC:0", searchPage([
      { id: 501, name: "Greenville Open", dates: "November 21 - 22, 2026" },
      { id: 502, name: "Raleigh Winter Doubles", dates: "January 9, 2027" },
    ], true));
    pages.set("search:NC:1", searchPage([{ id: 503, name: "Spring Fling", dates: "March 1, 2027" }]));
    pages.set("/tour/event/501", eventPage({ MPO: ["27523"], MA2: ["80024"], MA40: ["123456"] }));
    pages.set("/tour/event/502", eventPage({ MA2: ["80024"] }));
    pages.set("/tour/event/503", eventPage({ MA1: ["99999"] }));
    // An event that already ended (and someone on it) is cleared.
    db.raw.exec("INSERT INTO pdga_watch_events (event_id, name, state, start_date, end_date) VALUES (400, 'Last week', 'NC', '2026-11-08', '2026-11-09')");
    db.raw.exec("INSERT INTO pdga_registrations (event_id, member_id, pdga_number) VALUES (400, 'm_80024', '80024')");

    const first = await runPdgaRegistrationTick(env, NOW, fetchText);
    expect(first).toEqual({ state: "NC", listed: 3, removed: 0, read: 3, matched: 3, failed: 0, pruned: 1 });
    expect(db.raw.prepare("SELECT event_id, member_id, member_name, division FROM pdga_registrations ORDER BY event_id, member_id").all()).toEqual([
      { event_id: 501, member_id: "m_80024", member_name: "Ada Lovelace", division: "MA2" },
      { event_id: 501, member_id: "m_u_bo", member_name: "Bo Burnham", division: "MA40" },
      { event_id: 502, member_id: "m_80024", member_name: "Ada Lovelace", division: "MA2" },
    ]);
    expect(fetched.filter((url) => url.includes("/tour/event/")).length).toBe(3);

    // Within the hour nothing is read again.
    fetched = [];
    const again = await runPdgaRegistrationTick(env, NOW + 20 * 60_000, fetchText);
    expect([again.read, fetched.filter((url) => url.includes("/tour/event/")).length]).toEqual([0, 0]);

    // An hour later (VA's turn to be listed) the soon event is read again: Bo withdrew; the far ones wait their turn.
    pages.set("search:VA:0", searchPage([]));
    pages.set("/tour/event/501", eventPage({ MA2: ["80024"] }));
    fetched = [];
    const later = await runPdgaRegistrationTick(env, NOW + 60 * 60_000, fetchText);
    expect(later.state).toBe("VA");
    expect(fetched.filter((url) => url.includes("/tour/event/"))[0]).toBe("https://www.pdga.com/tour/event/501");
    expect(db.raw.prepare("SELECT member_id FROM pdga_registrations WHERE event_id = 501").all()).toEqual([{ member_id: "m_80024" }]);
  });

  it("removes events that leave a complete list, keeps going past a broken page, and stops after three failures", async () => {
    pages.set("search:NC:0", searchPage([{ id: 601, name: "A", dates: "November 20, 2026" }, { id: 602, name: "B", dates: "November 21, 2026" }]));
    pages.set("/tour/event/602", eventPage({ MA2: ["80024"] }));
    const tick = await runPdgaRegistrationTick(env, NOW, fetchText);
    expect([tick.read, tick.failed, tick.matched]).toEqual([1, 1, 1]);
    expect(db.raw.prepare("SELECT read_error FROM pdga_watch_events WHERE event_id = 601").get()).toEqual({ read_error: "fetch_failed_404" });

    // Three hours later NC is listed again without B: B and its registration go.
    pages.set("search:NC:0", searchPage([{ id: 601, name: "A", dates: "November 20, 2026" }]));
    pages.set("search:VA:0", searchPage([]));
    pages.set("search:SC:0", searchPage([]));
    const relisted = await runPdgaRegistrationTick(env, NOW + 3 * 3_600_000, fetchText);
    expect(relisted.removed).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM pdga_registrations").get()).toEqual({ n: 0 });

    // pdga.com down: three failed pages in a row end the tick.
    for (let id = 700; id < 700 + EVENTS_PER_TICK; id++) {
      db.raw.prepare("INSERT INTO pdga_watch_events (event_id, name, state, start_date, end_date) VALUES (?, 'x', 'SC', '2026-12-01', '2026-12-01')").run(id);
    }
    fetched = [];
    const down = await runPdgaRegistrationTick(env, NOW + 5 * 3_600_000, async (url) => { fetched.push(url); throw new Error("fetch_error"); });
    expect(down).toMatchObject({ skipped: "search_failed", failed: 3, read: 0 });
  });

  it("does nothing when no member has a PDGA number", async () => {
    roster.rows.delete("idx:pdga:80024");
    roster.rows.delete("idx:pdga:123456");
    pages.set("search:NC:0", searchPage([{ id: 801, name: "A", dates: "November 20, 2026" }]));
    expect(await runPdgaRegistrationTick(env, NOW, fetchText)).toMatchObject({ listed: 1, read: 0, skipped: "no_member_pdga_numbers" });
  });

  it("shows a member their own PDGA events with clubmates going, and clubmates' other events (members only)", async () => {
    db.raw.exec(`INSERT INTO pdga_watch_events (event_id, name, tier, location, state, start_date, end_date, read_at) VALUES
      (501, 'Greenville Open', 'C', 'Greenville, North Carolina', 'NC', '2099-11-21', '2099-11-22', '2099-11-18 15:00:00'),
      (502, 'Raleigh Doubles', 'C', 'Raleigh, North Carolina', 'NC', '2099-12-01', '2099-12-01', NULL),
      (503, 'Old', 'C', '', 'NC', '2001-01-01', '2001-01-01', NULL)`);
    db.raw.exec(`INSERT INTO pdga_registrations (event_id, member_id, pdga_number, member_name, division) VALUES
      (501, 'm_80024', '80024', 'Ada Lovelace', 'MA2'), (501, 'm_u_bo', '123456', 'Bo Burnham', 'MA40'),
      (502, 'm_u_bo', '123456', 'Bo Burnham', 'MA40'), (503, 'm_u_bo', '123456', 'Bo Burnham', 'MA40')`);
    const call = async (bearer?: string) => {
      const headers: Record<string, string> = { Origin: ORIGIN };
      if (bearer) headers.Authorization = "Bearer " + bearer;
      const response = await worker.fetch(new Request("https://worker.example/pdga-registrations", { headers }), env, { waitUntil() {} } as unknown as ExecutionContext);
      return { status: response.status, data: await response.json() as any };
    };
    expect((await call()).status).toBe(401);
    const ada = await call(await signSession({ sub: "m_80024", mustChangePin: false }, SECRET, 900));
    expect(ada.status).toBe(200);
    expect(ada.data).toEqual({
      mine: [{ eventId: 501, name: "Greenville Open", tier: "C", location: "Greenville, North Carolina", start: "2099-11-21", end: "2099-11-22",
        url: "https://www.pdga.com/tour/event/501", checkedAt: "2099-11-18 15:00:00", division: "MA2", going: [{ name: "Bo Burnham", division: "MA40" }] }],
      club: [{ eventId: 502, name: "Raleigh Doubles", tier: "C", location: "Raleigh, North Carolina", start: "2099-12-01", end: "2099-12-01",
        url: "https://www.pdga.com/tour/event/502", checkedAt: null, going: [{ name: "Bo Burnham", division: "MA40" }] }],
    });
    expect(JSON.stringify(ada.data)).not.toMatch(/m_u_bo|123456/);
    const cy = await call(await signSession({ sub: "m_cy", mustChangePin: false }, SECRET, 900));
    expect(cy.data.mine).toEqual([]);
    expect(cy.data.club.map((event: any) => [event.eventId, event.going.length])).toEqual([[501, 2], [502, 1]]);
  });
});
