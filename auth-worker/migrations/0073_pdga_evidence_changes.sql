-- Ratings shown to members are re-checked against their sources. A PDGA-based rating was re-checked by re-deriving its
-- baseline on every read: a query and the baseline math per round, which put a busy member past D1's per-request
-- query cap. Now each rating records when it was written (rated_at, D1's own clock), and these triggers record when
-- the PDGA evidence a club layout's baselines read last changed, by the changed PDGA round's date ('' = every date,
-- for a change to the layout match itself). A rating written after every change inside its baseline window is still
-- the rating that evidence gives, so reads trust it; any other one (written before this migration, or with evidence
-- changed since) is re-derived as before until a repair re-rates it. Triggers, so no write path can be missed.

ALTER TABLE round_ratings ADD COLUMN rated_at TEXT;

CREATE TABLE IF NOT EXISTS pdga_evidence_changes (
  layout_id  INTEGER NOT NULL,
  round_day  TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (layout_id, round_day)
);

-- Rounds: the club layouts the round's PDGA layout is matched to, at the round's date. Only columns the baseline reads.
CREATE TRIGGER pdga_evidence_round_insert
AFTER INSERT ON pdga_rated_rounds
BEGIN
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  SELECT layout_id, substr(NEW.round_date, 1, 10), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM pdga_layout_matches
  WHERE pdga_layout_id = NEW.pdga_layout_id AND layout_id IS NOT NULL
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
END;

CREATE TRIGGER pdga_evidence_round_update
AFTER UPDATE OF tourn_id, round_number, pdga_layout_id, round_date, official_ssa, ratings_ssa, ratings_status, holes_json,
  wind_gust_mph, weather_status, weather_course_id ON pdga_rated_rounds
WHEN OLD.tourn_id IS NOT NEW.tourn_id OR OLD.round_number IS NOT NEW.round_number OR OLD.pdga_layout_id IS NOT NEW.pdga_layout_id
  OR OLD.round_date IS NOT NEW.round_date OR OLD.official_ssa IS NOT NEW.official_ssa OR OLD.ratings_ssa IS NOT NEW.ratings_ssa
  OR OLD.ratings_status IS NOT NEW.ratings_status OR OLD.holes_json IS NOT NEW.holes_json OR OLD.wind_gust_mph IS NOT NEW.wind_gust_mph
  OR OLD.weather_status IS NOT NEW.weather_status OR OLD.weather_course_id IS NOT NEW.weather_course_id
BEGIN
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  SELECT layout_id, substr(OLD.round_date, 1, 10), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM pdga_layout_matches
  WHERE pdga_layout_id = OLD.pdga_layout_id AND layout_id IS NOT NULL
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  SELECT layout_id, substr(NEW.round_date, 1, 10), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM pdga_layout_matches
  WHERE pdga_layout_id = NEW.pdga_layout_id AND layout_id IS NOT NULL
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
END;

CREATE TRIGGER pdga_evidence_round_delete
AFTER DELETE ON pdga_rated_rounds
BEGIN
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  SELECT layout_id, substr(OLD.round_date, 1, 10), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM pdga_layout_matches
  WHERE pdga_layout_id = OLD.pdga_layout_id AND layout_id IS NOT NULL
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
END;

-- Matches: every date of the club layouts gaining or losing PDGA rounds. Re-running the matcher with the same answer
-- (it rewrites matched_at) changes nothing a baseline reads, so it records nothing.
CREATE TRIGGER pdga_evidence_match_insert
AFTER INSERT ON pdga_layout_matches
WHEN NEW.layout_id IS NOT NULL
BEGIN
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  VALUES (NEW.layout_id, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
END;

CREATE TRIGGER pdga_evidence_match_update
AFTER UPDATE ON pdga_layout_matches
WHEN OLD.pdga_layout_id IS NOT NEW.pdga_layout_id OR OLD.layout_id IS NOT NEW.layout_id
  OR OLD.review_status IS NOT NEW.review_status OR OLD.course_id IS NOT NEW.course_id
BEGIN
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  SELECT OLD.layout_id, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE OLD.layout_id IS NOT NULL
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  SELECT NEW.layout_id, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NEW.layout_id IS NOT NULL
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
END;

CREATE TRIGGER pdga_evidence_match_delete
AFTER DELETE ON pdga_layout_matches
WHEN OLD.layout_id IS NOT NULL
BEGIN
  INSERT INTO pdga_evidence_changes (layout_id, round_day, changed_at)
  VALUES (OLD.layout_id, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(layout_id, round_day) DO UPDATE SET changed_at = excluded.changed_at;
END;
