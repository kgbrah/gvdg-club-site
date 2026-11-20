-- Donations to the club, +10 karma for every dollar (owner, 2026-11-20: "Let's make ALL donations reward +10 karma per
-- dollar"; an admin confirms each one, and gifts already confirmed are raised too).
--
-- Donations straight to the club's PayPal (the Donate buttons, the $1 prompts, fundraisers): PayPal.me can't tell the
-- app who gave, so a signed-in member reports it and an admin confirms it arrived. `karma` is set when confirmed.
CREATE TABLE IF NOT EXISTS club_donations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id    TEXT NOT NULL,
  member_name  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 100 AND 100000),
  source       TEXT NOT NULL,                   -- club-card, round, event, fundraiser, other
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'not_received')),
  karma        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at  TEXT,
  reviewed_by  TEXT,
  review_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_club_donations_status ON club_donations (status, id);
CREATE INDEX IF NOT EXISTS idx_club_donations_member ON club_donations (member_id, id);

-- Marketplace gifts the club already confirmed: from +1 to +10 karma for every whole dollar.
UPDATE market_donations SET karma = (amount_cents / 100) * 10 WHERE status = 'confirmed';
