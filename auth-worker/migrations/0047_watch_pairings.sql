CREATE TABLE watch_pairings (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  revoked_at INTEGER,
  actor_id TEXT,
  pin_version INTEGER,
  round_key TEXT,
  round_id TEXT,
  card_id TEXT,
  actor_index INTEGER
);

CREATE INDEX watch_pairings_expiration ON watch_pairings(expires_at);
CREATE INDEX watch_pairings_owner ON watch_pairings(actor_id, round_key, expires_at);
