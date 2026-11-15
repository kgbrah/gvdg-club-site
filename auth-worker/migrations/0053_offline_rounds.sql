CREATE TABLE offline_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('member', 'open')),
  payload_hash TEXT NOT NULL,
  course_name TEXT NOT NULL,
  layout_name TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX offline_rounds_owner ON offline_rounds(owner_kind, owner_id, id DESC);

CREATE TABLE offline_round_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offline_round_id INTEGER NOT NULL REFERENCES offline_rounds(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  hole INTEGER NOT NULL,
  player_index INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  highlight INTEGER NOT NULL CHECK (highlight IN (0, 1)),
  moment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (offline_round_id, client_id)
);
