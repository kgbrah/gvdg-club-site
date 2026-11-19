-- Club-run PDGA events take registrations on the club site instead of Disc Golf Scene, so players don't pay its
-- handling fee. PDGA Competition Manual 1.02: a player is entered only once their entry fee is received (paid_at),
-- the field fills first come, first served by that time (ties: lowest PDGA number), a published cap sends later
-- players to a waitlist kept in order, and only paid players are listed. 1.03: withdrawals go to the TD (td_email). Each player's PDGA number is checked with the PDGA API (membership and rating, kept on the
-- registration as it was when checked); divisions can have rating limits; a non-member fee can apply; a capped
-- field puts later sign-ups on a waitlist (PDGA requires it shown on the registration page). Payment is PayPal
-- (the player can be asked to cover PayPal's fee) or Zelle to the event's account, which an admin confirms.
-- A player can add a donation to the club (suggested: what Disc Golf Scene would have charged).

-- The PDGA event this club event is, the PDGA event record when it was last read, and the event's rules:
-- {"membersOnly":bool,"nonMemberFeeCents":int,"divisionLimits":{"MA3":899,...}} (limit = highest rating allowed).
ALTER TABLE event_config ADD COLUMN pdga_event_id INTEGER;
ALTER TABLE event_config ADD COLUMN pdga_event TEXT;
ALTER TABLE event_config ADD COLUMN pdga_rules TEXT;
-- Registrations past this many go on the waitlist (NULL = no cap).
ALTER TABLE event_config ADD COLUMN player_cap INTEGER CHECK (player_cap IS NULL OR player_cap > 0);
-- 1 = PayPal's fee is added to what the player pays (the club receives the full entry).
ALTER TABLE event_config ADD COLUMN paypal_fee_passthrough INTEGER NOT NULL DEFAULT 0;
-- Zelle is offered when the event names where to send it (an email or phone) and whose account that is.
ALTER TABLE event_config ADD COLUMN zelle_to TEXT;
ALTER TABLE event_config ADD COLUMN zelle_name TEXT;
-- Where withdrawal requests go (PDGA 1.03.1: by email or phone to the Tournament Director only).
ALTER TABLE event_config ADD COLUMN td_email TEXT;

ALTER TABLE registrations ADD COLUMN pdga_number TEXT;
ALTER TABLE registrations ADD COLUMN pdga_status TEXT;      -- PDGA membership_status when checked ('current', 'expired', ...); NULL = not checked
ALTER TABLE registrations ADD COLUMN pdga_rating INTEGER;
ALTER TABLE registrations ADD COLUMN pdga_checked_at TEXT;
ALTER TABLE registrations ADD COLUMN waitlisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN waitlisted_at TEXT;    -- place in line: when the player joined the waitlist
ALTER TABLE registrations ADD COLUMN offered_at TEXT;       -- an admin offered this waitlisted player an open spot
ALTER TABLE registrations ADD COLUMN paid_at TEXT;          -- when the entry fee was received (the field's order)
ALTER TABLE registrations ADD COLUMN spot_claimed_at TEXT;  -- a spot held while a PayPal payment completes
ALTER TABLE registrations ADD COLUMN payment_method TEXT;   -- paypal | zelle | wallet (NULL until chosen)
ALTER TABLE registrations ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0;       -- PayPal fee the player covers
ALTER TABLE registrations ADD COLUMN donation_cents INTEGER NOT NULL DEFAULT 0;  -- gift to the club with this payment
ALTER TABLE registrations ADD COLUMN zelle_code TEXT;       -- memo the player puts on the Zelle payment
ALTER TABLE registrations ADD COLUMN zelle_sent_at TEXT;    -- when the player said they sent it

CREATE INDEX IF NOT EXISTS idx_reg_event_waitlist ON registrations(event_id, waitlisted, waitlisted_at, id);

