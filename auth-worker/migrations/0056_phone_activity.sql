CREATE TABLE phone_activity_devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  revoked_at INTEGER,
  member_id TEXT,
  pin_version INTEGER,
  round_key TEXT,
  round_id TEXT,
  card_id TEXT,
  actor_index INTEGER
);
CREATE INDEX phone_activity_devices_owner ON phone_activity_devices(member_id, expires_at);
CREATE INDEX phone_activity_devices_round ON phone_activity_devices(member_id, round_key, round_id);
CREATE INDEX phone_activity_devices_expiry ON phone_activity_devices(expires_at) WHERE approved_at IS NULL;

CREATE TABLE phone_activity_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER NOT NULL,
  distance_m INTEGER NOT NULL,
  point_count INTEGER NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  snapshot TEXT NOT NULL
);
CREATE INDEX phone_activity_tracks_owner ON phone_activity_tracks(member_id, id DESC);
