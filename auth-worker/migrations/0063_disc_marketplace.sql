-- Used-disc marketplace in the Pro Shop: member listings (buy / trade), WANTED posts, deals with a
-- state log, trade offers, eBay-style feedback with one reply, reports, seller payment handles, guest
-- buyers verified by an emailed code, and marketplace suspensions. Money is integer cents.
--
-- Identities: an owner id is a roster member id ("m_...") or a verified guest ("mg_<market_guests.id>").
-- Public payloads never carry owner ids or emails; they use market_traders.trader_key.

-- display_name mirrors the roster name / guest name, refreshed whenever the trader acts.
CREATE TABLE IF NOT EXISTS market_traders (
  owner_id     TEXT PRIMARY KEY,
  trader_key   TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('member', 'guest')),
  display_name TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Guests: the email is stored only as a keyed hash (identity) plus an encrypted copy for relayed mail.
CREATE TABLE IF NOT EXISTS market_guests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash       TEXT NOT NULL UNIQUE,
  email_enc        TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time 6-digit codes, stored hashed, single use, 10-minute expiry, capped attempts.
CREATE TABLE IF NOT EXISTS market_guest_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash   TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email_enc    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS market_guest_codes_email ON market_guest_codes(email_hash, id DESC);

-- Seller payment handles (members only). Validated server-side; never URLs. notify_email is required before a
-- member can create a listing (buyer alerts go there); it is never shown to anyone else.
CREATE TABLE IF NOT EXISTS market_seller_settings (
  member_id    TEXT PRIMARY KEY,
  paypal_me    TEXT NOT NULL DEFAULT '',
  cashtag      TEXT NOT NULL DEFAULT '',
  zelle        TEXT NOT NULL DEFAULT '',
  notify_email TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS market_listings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id       TEXT NOT NULL,
  brand           TEXT NOT NULL DEFAULT '',
  mold            TEXT NOT NULL,
  plastic         TEXT NOT NULL DEFAULT '',
  disc_type       TEXT NOT NULL CHECK (disc_type IN ('driver', 'fairway', 'midrange', 'putter')),
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
  -- A withdrawal can be undone (relisted) for 24 hours; then a cron sweep makes it final and deletes the photos.
  withdrawn_at     TEXT,
  withdrawal_final INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_final IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (price_cents IS NOT NULL OR open_to_trade = 1)
);
CREATE INDEX IF NOT EXISTS market_listings_browse ON market_listings(status, hidden, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS market_listings_type ON market_listings(disc_type, status, hidden);
CREATE INDEX IF NOT EXISTS market_listings_brand ON market_listings(brand COLLATE NOCASE, status);
CREATE INDEX IF NOT EXISTS market_listings_price ON market_listings(status, price_cents);
CREATE INDEX IF NOT EXISTS market_listings_condition ON market_listings(status, condition);
CREATE INDEX IF NOT EXISTS market_listings_weight ON market_listings(status, weight_g);
CREATE INDEX IF NOT EXISTS market_listings_seller ON market_listings(seller_id, status);
CREATE INDEX IF NOT EXISTS market_listings_withdrawn ON market_listings(status, withdrawal_final, withdrawn_at);

CREATE TABLE IF NOT EXISTS market_listing_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id   INTEGER NOT NULL REFERENCES market_listings(id),
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS market_listing_photos_listing ON market_listing_photos(listing_id, sort_order, id);

CREATE TABLE IF NOT EXISTS market_offers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id   INTEGER NOT NULL REFERENCES market_listings(id),
  buyer_id     TEXT NOT NULL,
  offered_ids  TEXT NOT NULL DEFAULT '[]',
  offered_text TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'withdrawn')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS market_offers_listing ON market_offers(listing_id, status);
CREATE INDEX IF NOT EXISTS market_offers_buyer ON market_offers(buyer_id, status);

-- A deal is one buyer's commitment on a listing; the seller completes (sold / traded) or releases it,
-- the buyer can cancel while it is pending.
CREATE TABLE IF NOT EXISTS market_deals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id    INTEGER NOT NULL REFERENCES market_listings(id),
  seller_id     TEXT NOT NULL,
  buyer_id      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('buy', 'trade')),
  offer_id      INTEGER REFERENCES market_offers(id),
  price_cents   INTEGER,
  listing_title TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'released')),
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('sold', 'traded')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  closed_at     TEXT,
  CHECK (seller_id <> buyer_id)
);
CREATE INDEX IF NOT EXISTS market_deals_listing ON market_deals(listing_id, status);
CREATE INDEX IF NOT EXISTS market_deals_seller ON market_deals(seller_id, status, completed_at);
CREATE INDEX IF NOT EXISTS market_deals_buyer ON market_deals(buyer_id, status, completed_at);
-- At most one pending deal per listing, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS market_deals_one_pending ON market_deals(listing_id) WHERE status = 'pending';

-- Every listing / deal / offer state change.
CREATE TABLE IF NOT EXISTS market_deal_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id  INTEGER,
  deal_id     INTEGER,
  offer_id    INTEGER,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS market_deal_log_listing ON market_deal_log(listing_id, id);
CREATE INDEX IF NOT EXISTS market_deal_log_deal ON market_deal_log(deal_id, id);

CREATE TABLE IF NOT EXISTS market_wanted (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  poster_id       TEXT NOT NULL,
  brand           TEXT NOT NULL DEFAULT '',
  mold            TEXT NOT NULL DEFAULT '',
  plastic         TEXT NOT NULL DEFAULT '',
  disc_type       TEXT CHECK (disc_type IS NULL OR disc_type IN ('driver', 'fairway', 'midrange', 'putter')),
  weight_min      INTEGER,
  weight_max      INTEGER,
  condition_min   INTEGER CHECK (condition_min IS NULL OR condition_min BETWEEN 1 AND 10),
  max_price_cents INTEGER,
  open_to_trade   INTEGER NOT NULL DEFAULT 0 CHECK (open_to_trade IN (0, 1)),
  notes           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  hidden          INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS market_wanted_browse ON market_wanted(status, hidden, expires_at, created_at DESC);
CREATE INDEX IF NOT EXISTS market_wanted_poster ON market_wanted(poster_id, status);

CREATE TABLE IF NOT EXISTS market_wanted_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wanted_id  INTEGER NOT NULL REFERENCES market_wanted(id),
  replier_id TEXT NOT NULL,
  listing_id INTEGER REFERENCES market_listings(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS market_wanted_replies_wanted ON market_wanted_replies(wanted_id, id);

-- Feedback: one per party per completed deal; editable once within 7 days; one reply by the subject.
CREATE TABLE IF NOT EXISTS market_feedback (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id        INTEGER NOT NULL REFERENCES market_deals(id),
  author_id      TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  subject_role   TEXT NOT NULL CHECK (subject_role IN ('buyer', 'seller')),
  rating         TEXT NOT NULL CHECK (rating IN ('positive', 'neutral', 'negative')),
  comment        TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at      TEXT,
  removed_at     TEXT,
  removed_by     TEXT,
  removed_reason TEXT,
  UNIQUE (deal_id, author_id),
  CHECK (author_id <> subject_id)
);
CREATE INDEX IF NOT EXISTS market_feedback_subject ON market_feedback(subject_id, removed_at, created_at DESC);

CREATE TABLE IF NOT EXISTS market_feedback_replies (
  feedback_id INTEGER PRIMARY KEY REFERENCES market_feedback(id),
  author_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS market_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('listing', 'wanted', 'feedback')),
  target_id   INTEGER NOT NULL,
  reporter_id TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution  TEXT,
  UNIQUE (target_kind, target_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS market_reports_queue ON market_reports(status, created_at);

CREATE TABLE IF NOT EXISTS market_suspensions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  lifted_at  TEXT,
  lifted_by  TEXT,
  lift_reason TEXT
);
CREATE INDEX IF NOT EXISTS market_suspensions_owner ON market_suspensions(owner_id, lifted_at);

-- Admin moderation actions, each with a reason.
CREATE TABLE IF NOT EXISTS market_mod_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS market_mod_log_recent ON market_mod_log(id DESC);
