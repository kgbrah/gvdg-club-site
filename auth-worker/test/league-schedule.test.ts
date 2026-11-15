import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listLeagueSchedule } from "../src/db-leagues.js";
import type { D1Like } from "../src/db-types.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE leagues (id INTEGER PRIMARY KEY, name TEXT, season TEXT, format TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      name TEXT,
      date TEXT,
      status TEXT,
      external_url TEXT,
      starts_at TEXT,
      type TEXT,
      league_id INTEGER
    );
    CREATE TABLE event_config (event_id INTEGER PRIMARY KEY, registration_open INTEGER);
  `);
  const db = {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) { values = bound; return this; },
        async all() { return { results: stmt.all(...values) as Record<string, unknown>[] }; },
      };
    },
  } as unknown as D1Like;
  return { sqlite, db };
}

describe("listLeagueSchedule", () => {
  it("returns every round of a current league and the sign-up fields", async () => {
    const { sqlite, db } = database();
    sqlite.exec(`
      INSERT INTO leagues (id, name, season, format) VALUES
        (1, 'Sunday Baggers', '2026', 'singles'),
        (2, 'Old Doubles', '2020', 'doubles');
      INSERT INTO events (id, name, date, status, external_url, type, league_id) VALUES
        (10, 'Week 1', date('now', '-200 days'), 'final', 'https://udisc.com/events/week-1', 'league_round', 1),
        (11, 'This week', date('now', '+2 days'), 'scheduled', 'https://udisc.com/events/this-week', 'league_round', 1),
        (12, 'Cancelled', date('now', '+9 days'), 'cancelled', 'https://udisc.com/events/skip', 'league_round', 1),
        (20, 'Summer', '2020-06-01', 'final', NULL, 'league_round', 2);
      INSERT INTO event_config (event_id, registration_open) VALUES (11, 1);
    `);
    const rows = await listLeagueSchedule(db);
    expect(rows.map((row) => row.id)).toEqual([10, 11]);
    expect(rows[1]).toMatchObject({
      league_name: "Sunday Baggers",
      external_url: "https://udisc.com/events/this-week",
      registration_open: 1,
      status: "scheduled",
    });
  });
});
