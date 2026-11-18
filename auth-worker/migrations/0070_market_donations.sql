-- Sellers can give part of a sale to the club. The pledge goes on the listing (a percentage, or a set amount; shown to
-- buyers). Once it's sold, the seller sends the donation to the club's PayPal and says so; an admin confirms it
-- arrived, and only then does the seller get +1 karma for every whole dollar (added to their Lost & Found karma).
ALTER TABLE market_listings ADD COLUMN donate_percent INTEGER CHECK (donate_percent IS NULL OR donate_percent BETWEEN 1 AND 100);
ALTER TABLE market_listings ADD COLUMN donate_cents INTEGER CHECK (donate_cents IS NULL OR donate_cents BETWEEN 100 AND 100000);

-- One donation per completed sale. 'sent' = the seller says they sent it (waiting on an admin); 'confirmed' = an admin
-- saw it arrive (karma = whole dollars, fixed then); 'not_received' = an admin couldn't find it (the seller can send
-- and mark it again).
CREATE TABLE IF NOT EXISTS market_donations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id      INTEGER NOT NULL UNIQUE REFERENCES market_deals(id),
  seller_id    TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 100 AND 100000),
  status       TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'confirmed', 'not_received')),
  karma        INTEGER NOT NULL DEFAULT 0 CHECK (karma >= 0),
  sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at  TEXT,
  reviewed_by  TEXT,
  review_note  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS market_donations_status ON market_donations(status, sent_at);
CREATE INDEX IF NOT EXISTS market_donations_seller ON market_donations(seller_id, status);
