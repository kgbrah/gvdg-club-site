-- Member-reported course conditions (wet, flooded, closed, etc.).
-- Public reads the latest report per course; writes require a member JWT.
CREATE TABLE course_conditions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL,
  member_name TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('dry', 'playable', 'wet', 'flooded', 'closed')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_course_conditions_course_id ON course_conditions(course_id, id DESC);
