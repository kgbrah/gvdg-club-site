-- Legacy ratings remain intact. Only revisions derived from archived geometry are reusable.
ALTER TABLE round_ratings ADD COLUMN source_result_id INTEGER;
ALTER TABLE round_ratings ADD COLUMN layout_revision TEXT;
ALTER TABLE round_ratings ADD COLUMN baseline_event_id INTEGER;
ALTER TABLE round_ratings ADD COLUMN anchor_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE round_ratings ADD COLUMN unrated_reason TEXT;
CREATE INDEX idx_round_rating_source_member ON round_ratings(stream, member_id, round_date, source_result_id);

CREATE TABLE layout_rating_baselines (
  layout_revision TEXT NOT NULL,
  layout_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  ssa REAL NOT NULL,
  ppt REAL NOT NULL,
  propagator_count INTEGER NOT NULL,
  PRIMARY KEY (layout_revision, event_id)
);
CREATE INDEX idx_rating_baselines_at ON layout_rating_baselines(layout_revision, available_at DESC, played_at DESC);

CREATE TABLE rating_anchor_snapshots (
  member_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  rating INTEGER NOT NULL,
  PRIMARY KEY (member_id, observed_at)
);

CREATE TABLE rating_repair_checkpoints (
  stream TEXT PRIMARY KEY CHECK (stream IN ('competition', 'casual')),
  after_id INTEGER NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE rating_repair_issues (
  stream TEXT NOT NULL CHECK (stream IN ('competition', 'casual')),
  source_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_code TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  PRIMARY KEY (stream, source_id)
);
CREATE INDEX idx_rating_repair_due ON rating_repair_issues(retry_at);

CREATE TABLE rating_anchor_refresh_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  last_key TEXT
);

-- Verify current scorecards and their calibration field before reusing stored estimates.
ALTER TABLE round_ratings ADD COLUMN source_fingerprint TEXT;
ALTER TABLE layout_rating_baselines ADD COLUMN field_fingerprint TEXT;

-- An in-place change to any finisher can affect the whole field. These small
-- revision tokens let all consumers reject old estimates without following
-- historical calibration dependencies on each request.
CREATE TABLE rating_event_revisions (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0)
);

CREATE TRIGGER rating_revision_result_insert
AFTER INSERT ON results
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id = NEW.event_id
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER rating_revision_result_update
AFTER UPDATE OF id, event_id, member_id, place, total, to_par, scorecard, created_at, scoring_group, match_result ON results
WHEN OLD.id IS NOT NEW.id
  OR OLD.event_id IS NOT NEW.event_id
  OR OLD.member_id IS NOT NEW.member_id
  OR OLD.place IS NOT NEW.place
  OR OLD.total IS NOT NEW.total
  OR OLD.to_par IS NOT NEW.to_par
  OR OLD.scorecard IS NOT NEW.scorecard
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.scoring_group IS NOT NEW.scoring_group
  OR OLD.match_result IS NOT NEW.match_result
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id IN (OLD.event_id, NEW.event_id)
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER rating_revision_result_delete
AFTER DELETE ON results
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id = OLD.event_id
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER rating_revision_event_update
AFTER UPDATE OF status, format, date, starts_at ON events
WHEN OLD.status IS NOT NEW.status
  OR OLD.format IS NOT NEW.format
  OR OLD.date IS NOT NEW.date
  OR OLD.starts_at IS NOT NEW.starts_at
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id = NEW.id
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER rating_revision_config_insert
AFTER INSERT ON event_config
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id = NEW.event_id
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER rating_revision_config_update
AFTER UPDATE OF event_id, play_format, live_scoring_config ON event_config
WHEN OLD.event_id IS NOT NEW.event_id
  OR OLD.play_format IS NOT NEW.play_format
  OR OLD.live_scoring_config IS NOT NEW.live_scoring_config
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id IN (OLD.event_id, NEW.event_id)
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER rating_revision_config_delete
AFTER DELETE ON event_config
BEGIN
  INSERT INTO rating_event_revisions (event_id, revision)
  SELECT id, 1 FROM events WHERE id = OLD.event_id
  ON CONFLICT(event_id) DO UPDATE SET revision = revision + 1;
END;
