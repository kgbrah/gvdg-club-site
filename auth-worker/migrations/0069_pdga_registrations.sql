-- Which club members are registered for upcoming PDGA events in North Carolina, Virginia and South Carolina (the
-- owner's choice), read from pdga.com every hour (pdga-registrations.ts). Each member sees their own in Upcoming
-- events; signed-in members also see which clubmates are going.
--
-- pdga_watch_events: the upcoming events from PDGA's event search, one state per hourly tick; read_at is when the
-- event's own page (its registered players) was last read.
CREATE TABLE IF NOT EXISTS pdga_watch_events (
  event_id   INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL CHECK (state IN ('NC', 'VA', 'SC')),
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  listed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT,
  read_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS pdga_watch_events_dates ON pdga_watch_events(end_date, start_date);
CREATE INDEX IF NOT EXISTS pdga_watch_events_read ON pdga_watch_events(read_at);

-- A club member on an event's registration list (matched by PDGA number). member_name is the roster name when it was
-- read, for "clubmates going" without a roster read per request. Rows go when the member drops off the list or the
-- event is over.
CREATE TABLE IF NOT EXISTS pdga_registrations (
  event_id    INTEGER NOT NULL REFERENCES pdga_watch_events(event_id),
  member_id   TEXT NOT NULL,
  pdga_number TEXT NOT NULL,
  member_name TEXT NOT NULL DEFAULT '',
  division    TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS pdga_registrations_member ON pdga_registrations(member_id);
