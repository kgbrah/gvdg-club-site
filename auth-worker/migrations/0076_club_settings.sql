-- Club-wide settings an admin changes from time to time (one row per setting, value as JSON). First: the PDGA club
-- discount code ($5 off a new or renewing PDGA membership; PDGA issues a new one each year), shown only to signed-in
-- club members, as PDGA asks clubs to keep it within the club.
CREATE TABLE IF NOT EXISTS club_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
