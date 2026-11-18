-- My Bag meets Lost & Found. Private photos of a member's own bag discs (never public: only the owner and the AI that
-- checks a found disc see them; one is copied to a lost post only when the owner picks it), a per-member switch for
-- checking found discs against their bag (on by default), and the links between a bag disc and its lost post / a
-- found disc's bag match.
CREATE TABLE IF NOT EXISTS bag_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  disc_id     TEXT NOT NULL,
  photo_key   TEXT NOT NULL,
  photo_type  TEXT NOT NULL DEFAULT 'image/jpeg',
  photo_bytes INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bag_photos_disc ON bag_photos(owner, disc_id, id);

CREATE TABLE IF NOT EXISTS bag_settings (
  owner       TEXT PRIMARY KEY,
  match_found INTEGER NOT NULL DEFAULT 1 CHECK (match_found IN (0, 1)),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A lost post made from a bag disc ("I lost this disc"), and the bag disc a found disc was matched to.
ALTER TABLE lf_posts ADD COLUMN bag_disc_id TEXT;
ALTER TABLE lf_matches ADD COLUMN bag_disc_id TEXT;
CREATE INDEX IF NOT EXISTS lf_posts_bag ON lf_posts(owner_id, bag_disc_id) WHERE bag_disc_id IS NOT NULL;

-- Marketplace listings checked against lost posts: each listing photo's writing, read once (private, never shown),
-- and each listing / lost-post pair decided once ('strong' alerted the seller; 'weak' never alerts).
CREATE TABLE IF NOT EXISTS market_listing_reads (
  listing_id   INTEGER PRIMARY KEY REFERENCES market_listings(id),
  ink_names    TEXT NOT NULL DEFAULT '[]',
  ink_phones   TEXT NOT NULL DEFAULT '[]',
  ink_initials TEXT NOT NULL DEFAULT '[]',
  read_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS market_lost_checks (
  listing_id INTEGER NOT NULL REFERENCES market_listings(id),
  lost_id    INTEGER NOT NULL REFERENCES lf_posts(id),
  verdict    TEXT NOT NULL CHECK (verdict IN ('strong', 'weak')),
  reasons    TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Strong matches go to the admins' review list (Admin > Marketplace) until one marks them reviewed.
  reviewed_at TEXT,
  reviewed_by TEXT,
  review      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (listing_id, lost_id)
);
CREATE INDEX IF NOT EXISTS market_lost_checks_lost ON market_lost_checks(lost_id);
