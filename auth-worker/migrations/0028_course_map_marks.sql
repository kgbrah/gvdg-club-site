-- Crowd-sourced tee pad and basket GPS. Players mark while scoring a live round;
-- a published consensus (enough distinct members, tight cluster) overlays the hole map.
CREATE TABLE course_map_marks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL,
  layout_id   INTEGER NOT NULL,
  hole        INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('tee', 'target')),
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  member_id   TEXT NOT NULL,
  round_code  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_course_map_marks_member
  ON course_map_marks(layout_id, hole, kind, member_id);
CREATE INDEX idx_course_map_marks_layout
  ON course_map_marks(layout_id, hole, kind);

CREATE TABLE course_map_consensus (
  layout_id  INTEGER NOT NULL,
  hole       INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('tee', 'target')),
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  samples    INTEGER NOT NULL,
  members    INTEGER NOT NULL,
  spread_m   REAL,
  published  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (layout_id, hole, kind)
);
