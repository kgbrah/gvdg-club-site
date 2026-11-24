-- Opt-in flag allowing a member to share their linked PDGA # on their community profile
-- so viewers can load official PDGA stats on demand.
ALTER TABLE community_profiles ADD COLUMN share_pdga INTEGER NOT NULL DEFAULT 0 CHECK (share_pdga IN (0, 1));
