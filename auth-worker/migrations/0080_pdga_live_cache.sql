-- PDGA Live API temporary caches & Section 6(a) record-ID matching (no permanent PDGA database).
-- Every cache carries an explicit expires_at and is purged hourly by purgePdgaCaches / purgePdgaLiveCaches.

CREATE TABLE IF NOT EXISTS pdga_live_cache (
  cache_key TEXT PRIMARY KEY,
  etag TEXT,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdga_live_cache_expires ON pdga_live_cache(expires_at);

CREATE TABLE IF NOT EXISTS pdga_watch_events (
  event_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  listed_at INTEGER NOT NULL,
  read_at INTEGER,
  read_error TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdga_watch_events_due ON pdga_watch_events(completed, start_date, read_at);
CREATE INDEX IF NOT EXISTS idx_pdga_watch_events_expires ON pdga_watch_events(expires_at);

CREATE TABLE IF NOT EXISTS pdga_member_event_links (
  event_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  pdga_number TEXT NOT NULL,
  result_id INTEGER NOT NULL,
  division TEXT NOT NULL DEFAULT '',
  event_start TEXT NOT NULL DEFAULT '',
  event_end TEXT NOT NULL DEFAULT '',
  matched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_pdga_member_event_links_member ON pdga_member_event_links(member_id, event_start DESC);
CREATE INDEX IF NOT EXISTS idx_pdga_member_event_links_pdga ON pdga_member_event_links(pdga_number, event_start DESC);
CREATE INDEX IF NOT EXISTS idx_pdga_member_event_links_expires ON pdga_member_event_links(expires_at);
