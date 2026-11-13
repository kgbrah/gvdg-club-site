-- Club bag-tag series. Tag 1 is the ace. A card settle or a confirmed
-- challenge reassigns only the numbers that were in that match.
CREATE TABLE bag_tag_series (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  season      TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bag_tag_holders (
  series_id   INTEGER NOT NULL REFERENCES bag_tag_series(id) ON DELETE CASCADE,
  tag_number  INTEGER NOT NULL,
  member_id   TEXT NOT NULL,
  member_name TEXT NOT NULL,
  held_since  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (series_id, tag_number)
);
CREATE UNIQUE INDEX idx_bag_tag_holder_member ON bag_tag_holders(series_id, member_id);

CREATE TABLE bag_tag_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id  INTEGER NOT NULL,
  kind       TEXT NOT NULL, -- assign | release | settle | challenge
  summary    TEXT NOT NULL,
  actor_id   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bag_tag_moves_series ON bag_tag_moves(series_id, id DESC);

CREATE TABLE bag_tag_challenges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id        INTEGER NOT NULL,
  challenger_id    TEXT NOT NULL,
  challenger_name  TEXT NOT NULL,
  defender_id      TEXT NOT NULL,
  defender_name    TEXT NOT NULL,
  challenger_tag   INTEGER NOT NULL,
  defender_tag     INTEGER NOT NULL,
  challenger_score INTEGER NOT NULL,
  defender_score   INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | settled | declined
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bag_tag_challenges_open ON bag_tag_challenges(series_id, status);
