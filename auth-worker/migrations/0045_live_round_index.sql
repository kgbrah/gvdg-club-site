-- Live cards the public course-traffic board can find. Casual rounds only exist in a Durable
-- Object until they finish, so without this index a started card is invisible to everyone else.
-- Rows are deleted on cancel/finalize, and the traffic read drops anything that is no longer live.
CREATE TABLE IF NOT EXISTS live_round_index (
  key TEXT PRIMARY KEY,
  course_id INTEGER,
  course_name TEXT,
  layout_name TEXT,
  lat REAL,
  lng REAL,
  started_at TEXT NOT NULL
);
