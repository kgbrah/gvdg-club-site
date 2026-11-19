import { readFileSync } from "node:fs";
import type { D1Like, D1StatementLike } from "../src/db-types.js";

export const PDGA_TEST_MIGRATIONS = [
  "0001_init.sql", "0005_registration.sql", "0015_udisc_export.sql", "0016_casual_rounds.sql", "0018_live_scoring_metadata.sql",
  "0022_ratings.sql", "0024_event_schedule_deadlines.sql", "0050_rating_repair.sql", "0062_pdga_layout_baselines.sql",
  "0073_pdga_evidence_changes.sql",
];

/** In-memory SQLite behind the D1 surface the worker uses; batch() is one transaction like D1. */
export async function pdgaTestDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of PDGA_TEST_MIGRATIONS) sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  const db = {
    prepare(query: string) {
      let values: unknown[] = [];
      function exec() {
        const result = sqlite.prepare(query).run(...(values as never[]));
        return { results: [], success: true, meta: { changes: Number(result.changes) } };
      }
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first() { return sqlite.prepare(query).get(...(values as never[])) ?? null; },
        async all() { return { results: sqlite.prepare(query).all(...(values as never[])), success: true }; },
        async run() { return exec(); },
        exec, query,
      };
      return statement;
    },
    async batch(statements: (D1StatementLike & { exec(): unknown })[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.exec());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Like;
  return { db, sqlite };
}

export function fixtureJson(name: string) {
  return JSON.parse(readFileSync(new URL("./fixtures/pdga/" + name, import.meta.url), "utf8"));
}
