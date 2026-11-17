-- PDGA-derived layout baselines (pdga-baselines.ts, pdga-baseline-store.ts, pdga-baseline-ingest.ts).
-- Official PDGA round SSAs on layouts that match one of our course layouts become a chronological
-- rating baseline (rating_method 'pdga'). Nothing here stores a player name or PDGA number: rounds
-- keep only (score, round rating) pairs per division.

-- Events waiting to be read from the PDGA live-results JSON. The cron works through this in small
-- bounded batches; pending_json is the remaining [division, round] fetches so an event resumes
-- across ticks instead of re-reading everything.
CREATE TABLE pdga_ingest_queue (
  tourn_id         INTEGER PRIMARY KEY CHECK (tourn_id > 0),
  source           TEXT NOT NULL CHECK (source IN ('member-history', 'admin')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  ratings_official INTEGER NOT NULL DEFAULT 0 CHECK (ratings_official IN (0, 1)),
  event_name       TEXT,
  event_city       TEXT,
  event_state      TEXT,
  event_date       TEXT,
  event_json       TEXT,
  pending_json     TEXT,
  queued_at        TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  next_attempt_at  TEXT NOT NULL,
  ingested_at      TEXT
);
CREATE INDEX idx_pdga_ingest_due ON pdga_ingest_queue(status, next_attempt_at);

-- Roster paging for discovery from members' public PDGA rating history.
CREATE TABLE pdga_discovery_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  cursor            TEXT,
  last_key          TEXT,
  pass_completed_at TEXT
);

-- One row per PDGA round on one PDGA layout. official_ssa is the live API's SSARdN for that round and
-- layout; ratings_ssa is the SSA PDGA's published round ratings imply (PDGA rates rounds of one event
-- on one layout from a shared SSA, so the two can differ). Baselines use ratings_ssa when known.
CREATE TABLE pdga_rated_rounds (
  tourn_id        INTEGER NOT NULL,
  round_number    INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 10),
  pdga_layout_id  INTEGER NOT NULL,
  round_date      TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  event_city      TEXT,
  event_state     TEXT,
  tier            TEXT,
  pdga_course_id  INTEGER,
  course_name     TEXT NOT NULL,
  layout_name     TEXT NOT NULL,
  hole_count      INTEGER NOT NULL CHECK (hole_count BETWEEN 1 AND 36),
  total_par       INTEGER,
  total_length_ft INTEGER,
  holes_json      TEXT NOT NULL,
  official_ssa    REAL,
  ratings_ssa     REAL,
  ratings_status  TEXT NOT NULL CHECK (ratings_status IN ('official', 'unconfirmed')),
  rated_players   INTEGER NOT NULL DEFAULT 0,
  fetched_at      TEXT NOT NULL,
  -- Wind for normalising the SSA: Open-Meteo archive, max hourly gust 09:00-17:00 local (mph) at the
  -- matched course (weather_course_id) on round_date. 'unavailable' rounds are used as played.
  wind_gust_mph     REAL,
  weather_status    TEXT NOT NULL DEFAULT 'pending' CHECK (weather_status IN ('pending', 'ok', 'unavailable')),
  weather_course_id INTEGER,
  weather_attempts  INTEGER NOT NULL DEFAULT 0,
  weather_next_at   TEXT,
  PRIMARY KEY (tourn_id, round_number, pdga_layout_id)
);
CREATE INDEX idx_pdga_rounds_layout ON pdga_rated_rounds(pdga_layout_id, round_date);
CREATE INDEX idx_pdga_rounds_weather ON pdga_rated_rounds(weather_status, weather_next_at);

-- Anonymous (score, round rating) pairs, one row per division so each fetch is an idempotent upsert.
CREATE TABLE pdga_round_scores (
  tourn_id       INTEGER NOT NULL,
  round_number   INTEGER NOT NULL,
  pdga_layout_id INTEGER NOT NULL,
  division       TEXT NOT NULL,
  pairs_json     TEXT NOT NULL,
  rated_count    INTEGER NOT NULL,
  PRIMARY KEY (tourn_id, round_number, pdga_layout_id, division)
);

-- How a PDGA layout maps onto one of our layouts. 'auto' and 'confirmed' rows feed baselines;
-- 'pending' rows (unmatched, unverified or ambiguous) wait for an admin; 'rejected' never feeds one.
CREATE TABLE pdga_layout_matches (
  pdga_layout_id  INTEGER PRIMARY KEY,
  course_id       INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  layout_id       INTEGER REFERENCES course_layouts(id) ON DELETE SET NULL,
  layout_revision TEXT,
  quality         TEXT NOT NULL CHECK (quality IN ('exact', 'close', 'unverified', 'ambiguous', 'none')),
  review_status   TEXT NOT NULL CHECK (review_status IN ('auto', 'pending', 'confirmed', 'rejected')),
  reason          TEXT,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  matched_at      TEXT NOT NULL,
  reviewed_at     TEXT,
  reviewed_by     TEXT
);
CREATE INDEX idx_pdga_matches_layout ON pdga_layout_matches(layout_id, review_status);
CREATE INDEX idx_pdga_matches_review ON pdga_layout_matches(review_status, matched_at);

-- round_ratings gains the 'pdga' method and records the PDGA baseline beside every rating that had
-- one (the baseline used, or the comparison next to a field's own day-of SSA). SQLite cannot alter a
-- CHECK constraint, so the table is rebuilt with identical columns, keys and indexes.
PRAGMA defer_foreign_keys = on;

CREATE TABLE round_ratings_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id            TEXT NOT NULL,
  player_name          TEXT NOT NULL,
  stream               TEXT NOT NULL CHECK (stream IN ('competition', 'casual')),
  event_id             INTEGER REFERENCES events(id) ON DELETE CASCADE,
  casual_round_code    TEXT,
  course_id            INTEGER REFERENCES courses(id),
  layout_id            INTEGER REFERENCES course_layouts(id),
  round_date           TEXT NOT NULL,
  total                INTEGER NOT NULL,
  to_par               INTEGER,
  round_rating         INTEGER,
  ssa                  REAL,
  ppt                  REAL,
  propagator_count     INTEGER NOT NULL DEFAULT 0,
  rating_method        TEXT NOT NULL CHECK (rating_method IN ('stable', 'provisional', 'layout', 'pdga', 'unrated')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  wind_gust_mph        REAL,
  weather_adjustment   REAL NOT NULL DEFAULT 0,
  source_result_id     INTEGER,
  layout_revision      TEXT,
  baseline_event_id    INTEGER,
  anchor_count         INTEGER NOT NULL DEFAULT 0,
  unrated_reason       TEXT,
  source_fingerprint   TEXT,
  pdga_baseline_ssa    REAL,
  pdga_baseline_rounds INTEGER,
  CHECK (event_id IS NOT NULL OR casual_round_code IS NOT NULL)
);

INSERT INTO round_ratings_new (
  id, member_id, player_name, stream, event_id, casual_round_code, course_id, layout_id, round_date, total, to_par,
  round_rating, ssa, ppt, propagator_count, rating_method, created_at, wind_gust_mph, weather_adjustment,
  source_result_id, layout_revision, baseline_event_id, anchor_count, unrated_reason, source_fingerprint
)
SELECT
  id, member_id, player_name, stream, event_id, casual_round_code,
  CASE WHEN course_id IN (SELECT id FROM courses) THEN course_id END,
  CASE WHEN layout_id IN (SELECT id FROM course_layouts) THEN layout_id END,
  round_date, total, to_par, round_rating, ssa, ppt, propagator_count, rating_method, created_at, wind_gust_mph,
  weather_adjustment, source_result_id, layout_revision, baseline_event_id, anchor_count, unrated_reason, source_fingerprint
FROM round_ratings
WHERE event_id IS NULL OR event_id IN (SELECT id FROM events);

DROP TABLE round_ratings;
ALTER TABLE round_ratings_new RENAME TO round_ratings;

CREATE UNIQUE INDEX idx_round_ratings_event_member
  ON round_ratings(event_id, member_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX idx_round_ratings_casual_member
  ON round_ratings(casual_round_code, member_id) WHERE casual_round_code IS NOT NULL;
CREATE INDEX idx_round_ratings_member_stream_date
  ON round_ratings(member_id, stream, round_date DESC);
CREATE INDEX idx_round_ratings_layout_stream
  ON round_ratings(layout_id, stream);
CREATE INDEX idx_round_rating_source_member ON round_ratings(stream, member_id, round_date, source_result_id);
