-- Anonymized lie GPS from live and competitive rounds. Powers hole landing-zone heatmaps.
CREATE TABLE hole_shot_marks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  layout_id   INTEGER NOT NULL,
  hole        INTEGER NOT NULL,
  throw_n     INTEGER NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  member_id   TEXT NOT NULL DEFAULT '',
  round_code  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_hole_shot_marks_uniq
  ON hole_shot_marks(layout_id, hole, round_code, member_id, throw_n);
CREATE INDEX idx_hole_shot_marks_layout
  ON hole_shot_marks(layout_id, hole, throw_n);

CREATE TABLE hole_shot_harvest (
  layout_id    INTEGER PRIMARY KEY,
  harvested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
