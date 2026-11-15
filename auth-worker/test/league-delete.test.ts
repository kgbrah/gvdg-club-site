import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deleteLeague } from "../src/db-leagues.js";
import type { D1Like } from "../src/db-types.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE leagues (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      league_id INTEGER REFERENCES leagues(id),
      updated_at TEXT
    );
    CREATE TABLE results (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE layout_ssa (
      layout_id INTEGER PRIMARY KEY,
      source_event_id INTEGER REFERENCES events(id)
    );
  `);
  const db = {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) { values = bound; return this; },
        async all() { return { results: stmt.all(...values) as Record<string, unknown>[], success: true }; },
        async run() { stmt.run(...values); return { success: true, results: [] }; },
      };
    },
  } as D1Like;
  return { sqlite, db };
}

describe("deleteLeague", () => {
  it("removes an imported league and its UDisc rounds, and keeps other rounds", async () => {
    const { sqlite, db } = database();
    sqlite.exec(`
      INSERT INTO leagues (id, name) VALUES (9, 'Dolly Dubs');
      INSERT INTO events (id, name, status, source, league_id) VALUES
        (1, 'Week 1', 'final', 'udisc', 9),
        (2, 'Club night', 'final', 'manual', 9);
      INSERT INTO results (id, event_id, name) VALUES (1, 1, 'Ada');
      INSERT INTO layout_ssa (layout_id, source_event_id) VALUES (1, 1);
    `);
    await deleteLeague(db, 9);
    expect(sqlite.prepare("SELECT id FROM leagues").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id, league_id FROM events").all()).toEqual([{ id: 2, league_id: null }]);
    expect(sqlite.prepare("SELECT id FROM results").all()).toEqual([]);
    expect(sqlite.prepare("SELECT source_event_id FROM layout_ssa").get()).toEqual({ source_event_id: null });
  });

  it("refuses while a round in the league is live", async () => {
    const { sqlite, db } = database();
    sqlite.exec(`
      INSERT INTO leagues (id, name) VALUES (3, 'Weeknight');
      INSERT INTO events (id, name, status, source, league_id) VALUES (4, 'Tonight', 'live', 'udisc', 3);
    `);
    await expect(deleteLeague(db, 3)).rejects.toThrow("league_live");
    expect(sqlite.prepare("SELECT id FROM leagues").all()).toEqual([{ id: 3 }]);
  });
});
