-- Bag-tag challenges inside imported UDisc leagues. UDisc always wins: each import or
-- refresh rewrites the league ladder and closes open challenges. The club series keeps
-- series_id >= 1 and league_id NULL. League rows use series_id = 0 and league_id = <league>.
ALTER TABLE bag_tag_challenges ADD COLUMN league_id INTEGER;
ALTER TABLE bag_tag_challenges ADD COLUMN closed_note TEXT;
ALTER TABLE bag_tag_challenges ADD COLUMN closed_at TEXT;
CREATE INDEX idx_bag_tag_challenges_league ON bag_tag_challenges(league_id, status);

ALTER TABLE bag_tag_moves ADD COLUMN league_id INTEGER;
-- 1 once a later UDisc import replaced the order this move changed (an app-only challenge).
ALTER TABLE bag_tag_moves ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_bag_tag_moves_league ON bag_tag_moves(league_id, id DESC);

-- The app's current ladder for one imported league. member_id is NULL until the UDisc
-- player is matched to a member account (see bag_tag_league_links for admin matches).
CREATE TABLE bag_tag_league_ladder (
  league_id   INTEGER NOT NULL,
  tag_number  INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  member_id   TEXT,
  held_since  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, tag_number)
);
CREATE INDEX idx_bag_tag_league_ladder_member ON bag_tag_league_ladder(league_id, member_id);

CREATE TABLE bag_tag_league_state (
  league_id   INTEGER PRIMARY KEY,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  linked_at   TEXT
);

-- Admin matches of a UDisc player name to a member account (player_key = compact name).
CREATE TABLE bag_tag_league_links (
  league_id   INTEGER NOT NULL,
  player_key  TEXT NOT NULL,
  player_name TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, player_key)
);
