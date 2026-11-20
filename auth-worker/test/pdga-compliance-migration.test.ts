import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Migration 0078 (PDGA Developer Program review, 2026-11-20): delete scraped and permanently stored PDGA data, unrate
// club ratings that were derived from PDGA rounds (queued for re-rating), keep only members' current PDGA ratings
// as anchors, and empty the API caches.

const MIGRATIONS = new URL("../migrations/", import.meta.url);

async function upTo(last: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (file > last) break;
    db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return db;
}

describe("migration 0078", () => {
  it("removes stored PDGA data and keeps the club's own", async () => {
    const db = await upTo("0077_club_donations.sql");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      INSERT INTO pdga_cache (pdga, data, fetched_at) VALUES ('80024', '{}', 1);
      INSERT INTO pdga_watch_events (event_id, name, state, start_date, end_date) VALUES (1, 'X', 'NC', '2026-01-01', '2026-01-02');
      INSERT INTO events (id, type, name, status, date) VALUES (1, 'league_round', 'League', 'final', '2026-06-10'),
        (2, 'tournament', 'Old Open', 'final', '2026-03-01'), (3, 'tournament', 'Next Open', 'scheduled', '2099-03-01');
      INSERT INTO casual_rounds (id, round_code, course_id, layout_id, holes, started_at, finalized_at, scoring_config)
        VALUES (7, 'ABC123', NULL, NULL, '[]', '2026-06-01T15:00:00Z', '2026-06-01 18:00:00', '{}');
      INSERT INTO casual_results (id, casual_round_id, member_id, name, place, total, to_par, scorecard) VALUES (70, 7, 'm_a', 'A', 1, 54, 0, '[]');
      INSERT INTO round_ratings (member_id, player_name, stream, event_id, round_date, total, round_rating, ssa, ppt, rating_method,
          source_result_id, pdga_baseline_ssa, pdga_baseline_rounds)
        VALUES ('m_a', 'A', 'competition', 1, '2026-06-10', 54, 950, 54.1, 9.8, 'pdga', 11, 54.1, 6),
               ('m_b', 'B', 'competition', 1, '2026-06-10', 55, 940, 55.0, 9.8, 'stable', 12, 54.3, 6);
      INSERT INTO round_ratings (member_id, player_name, stream, casual_round_code, round_date, total, round_rating, rating_method, source_result_id)
        VALUES ('m_a', 'A', 'casual', 'ABC123', '2026-06-01', 54, 948, 'pdga', 70);
      INSERT INTO rating_anchor_snapshots (member_id, observed_at, effective_at, rating) VALUES
        ('m_a', '2026-01-01T00:00:00.000Z', '2025-12-09T00:00:00.000Z', 930),
        ('m_a', '2026-06-01T00:00:00.000Z', '2026-05-12T00:00:00.000Z', 941),
        ('m_b', '2026-06-01T00:00:00.000Z', '2026-05-12T00:00:00.000Z', 900);
      INSERT INTO pdga_api_players (pdga_number, data, fetched_at) VALUES ('80024', '{}', 1);
      INSERT INTO kv_store (ns, key, value, expires_at) VALUES ('pdgaevents', 'k', '[]', NULL), ('ratelimit', 'k', '1', NULL);
      INSERT INTO event_config (event_id, pdga_event_id, pdga_event) VALUES (2, 650, '{"name":"Old Open"}'), (3, 702, '{"name":"Next Open"}');
      INSERT INTO registrations (event_id, member_id, name, pdga_number, pdga_status, pdga_rating) VALUES
        (2, 'm_a', 'A', '80024', 'current', 941), (3, 'm_a', 'A', '80024', 'current', 941);
    `);
    db.exec(readFileSync(new URL("0078_pdga_compliance.sql", MIGRATIONS), "utf8"));

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name LIKE 'pdga%' ORDER BY name").all();
    expect(tables).toEqual([{ name: "pdga_api_players" }]);
    expect(db.prepare("SELECT stream, rating_method, round_rating, unrated_reason, pdga_baseline_ssa FROM round_ratings ORDER BY id").all()).toEqual([
      { stream: "competition", rating_method: "unrated", round_rating: null, unrated_reason: "pdga-baseline-removed", pdga_baseline_ssa: null },
      { stream: "competition", rating_method: "stable", round_rating: 940, unrated_reason: null, pdga_baseline_ssa: null },
      { stream: "casual", rating_method: "unrated", round_rating: null, unrated_reason: "pdga-baseline-removed", pdga_baseline_ssa: null },
    ]);
    expect(db.prepare("SELECT stream, source_id, last_code FROM rating_repair_issues ORDER BY stream").all()).toEqual([
      { stream: "casual", source_id: 7, last_code: "pdga-baseline-removed" },
      { stream: "competition", source_id: 1, last_code: "pdga-baseline-removed" },
    ]);
    expect(db.prepare("SELECT member_id, rating, confirmed_at IS NOT NULL AS confirmed FROM rating_anchor_snapshots ORDER BY member_id").all()).toEqual([
      { member_id: "m_a", rating: 941, confirmed: 1 },
      { member_id: "m_b", rating: 900, confirmed: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pdga_api_players").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT ns FROM kv_store").all()).toEqual([{ ns: "ratelimit" }]);
    expect(db.prepare("SELECT event_id, pdga_event_id, pdga_event FROM event_config ORDER BY event_id").all()).toEqual([
      { event_id: 2, pdga_event_id: 650, pdga_event: null },
      { event_id: 3, pdga_event_id: 702, pdga_event: null },
    ]);
    expect(db.prepare("SELECT event_id, pdga_number, pdga_status, pdga_rating FROM registrations ORDER BY event_id").all()).toEqual([
      { event_id: 2, pdga_number: "80024", pdga_status: null, pdga_rating: null },
      { event_id: 3, pdga_number: "80024", pdga_status: "current", pdga_rating: 941 },
    ]);
  });
});
