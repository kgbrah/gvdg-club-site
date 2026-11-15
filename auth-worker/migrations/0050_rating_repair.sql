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
