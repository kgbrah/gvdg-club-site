-- The marketplace sells bags and accessories as well as discs, and a listing can start from My Bag ("Sell this").
-- SQLite can't change a CHECK constraint in place (disc_type was required), so market_listings is rebuilt with the
-- same columns and the same ids: every table that points at a listing (photos, offers, deals, reports, feedback,
-- wanted replies, lost-disc checks) keeps pointing at the same rows. New columns:
--   item_kind  'disc' | 'bag' | 'accessory' (every existing listing is a disc)
--   gear_type  what an accessory is (cart, towel, mini…, as in My Bag); '' for discs and bags
--   bag_ref    the seller's own My Bag item it was listed from: 'disc:<id>', 'bag' or 'accessory:<id>'. Private: only
--              the seller's My Bag reads it (to show "For sale" on that item); never in a public payload.
-- Disc type, plastic, weight and flight numbers belong to discs only.
--
-- D1 runs this file as one transaction. Foreign keys are deferred while the old table is swapped for the new one (the
-- children briefly point at a dropped table, then at the renamed copy with the same ids).
PRAGMA defer_foreign_keys = on;

CREATE TABLE market_listings_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id       TEXT NOT NULL,
  item_kind       TEXT NOT NULL DEFAULT 'disc' CHECK (item_kind IN ('disc', 'bag', 'accessory')),
  gear_type       TEXT NOT NULL DEFAULT '',
  bag_ref         TEXT,
  brand           TEXT NOT NULL DEFAULT '',
  mold            TEXT NOT NULL,
  plastic         TEXT NOT NULL DEFAULT '',
  disc_type       TEXT CHECK (disc_type IS NULL OR disc_type IN ('driver', 'fairway', 'midrange', 'putter')),
  speed           REAL,
  glide           REAL,
  turn            REAL,
  fade            REAL,
  weight_g        INTEGER CHECK (weight_g IS NULL OR weight_g BETWEEN 100 AND 200),
  color           TEXT NOT NULL DEFAULT '',
  condition       INTEGER NOT NULL CHECK (condition BETWEEN 1 AND 10),
  condition_notes TEXT NOT NULL DEFAULT '',
  price_cents     INTEGER CHECK (price_cents IS NULL OR price_cents BETWEEN 100 AND 100000),
  open_to_trade   INTEGER NOT NULL DEFAULT 0 CHECK (open_to_trade IN (0, 1)),
  trade_for       TEXT NOT NULL DEFAULT '',
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20),
  location        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'sold', 'traded', 'withdrawn')),
  hidden          INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  withdrawn_at     TEXT,
  withdrawal_final INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_final IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (price_cents IS NOT NULL OR open_to_trade = 1),
  -- A disc has a disc type; a bag or an accessory never does.
  CHECK ((item_kind = 'disc') = (disc_type IS NOT NULL)),
  CHECK (item_kind = 'disc' OR (plastic = '' AND weight_g IS NULL AND speed IS NULL AND glide IS NULL AND turn IS NULL AND fade IS NULL)),
  CHECK (item_kind = 'accessory' OR gear_type = '')
);

INSERT INTO market_listings_new (id, seller_id, item_kind, gear_type, bag_ref, brand, mold, plastic, disc_type, speed, glide, turn, fade,
  weight_g, color, condition, condition_notes, price_cents, open_to_trade, trade_for, quantity, location, status, hidden,
  withdrawn_at, withdrawal_final, created_at, updated_at)
SELECT id, seller_id, 'disc', '', NULL, brand, mold, plastic, disc_type, speed, glide, turn, fade,
  weight_g, color, condition, condition_notes, price_cents, open_to_trade, trade_for, quantity, location, status, hidden,
  withdrawn_at, withdrawal_final, created_at, updated_at
FROM market_listings;

DROP TABLE market_listings;
ALTER TABLE market_listings_new RENAME TO market_listings;

CREATE INDEX IF NOT EXISTS market_listings_browse ON market_listings(status, hidden, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS market_listings_type ON market_listings(disc_type, status, hidden);
CREATE INDEX IF NOT EXISTS market_listings_brand ON market_listings(brand COLLATE NOCASE, status);
CREATE INDEX IF NOT EXISTS market_listings_price ON market_listings(status, price_cents);
CREATE INDEX IF NOT EXISTS market_listings_condition ON market_listings(status, condition);
CREATE INDEX IF NOT EXISTS market_listings_weight ON market_listings(status, weight_g);
CREATE INDEX IF NOT EXISTS market_listings_seller ON market_listings(seller_id, status);
CREATE INDEX IF NOT EXISTS market_listings_withdrawn ON market_listings(status, withdrawal_final, withdrawn_at);
CREATE INDEX IF NOT EXISTS market_listings_kind ON market_listings(item_kind, status, hidden);
CREATE INDEX IF NOT EXISTS market_listings_bag ON market_listings(seller_id, bag_ref) WHERE bag_ref IS NOT NULL;

PRAGMA defer_foreign_keys = off;
