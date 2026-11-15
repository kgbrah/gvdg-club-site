-- Import snapshots belong to personal history only. No result or rating table references them.
CREATE TABLE member_archive_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('round', 'disc', 'throw', 'putting', 'clip')),
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_bytes INTEGER GENERATED ALWAYS AS (length(CAST(payload AS BLOB))) STORED,
  imported_at TEXT NOT NULL,
  UNIQUE (owner, kind, source_id, fingerprint)
);
CREATE INDEX idx_member_archive_library ON member_archive_records(owner, id DESC);
CREATE INDEX idx_member_archive_kind ON member_archive_records(owner, kind, id DESC);

-- Preserve the original wall-time and UTC offset text when a new scorecard CSV supplies it.
ALTER TABLE udisc_history ADD COLUMN source_played_at TEXT;
ALTER TABLE udisc_history ADD COLUMN source_finished_at TEXT;

-- An over-capacity chunk fails as a single transaction. Exact repeats consume neither limit.
CREATE TRIGGER member_archive_owner_limit
BEFORE INSERT ON member_archive_records
WHEN NOT EXISTS (
  SELECT 1 FROM member_archive_records
   WHERE owner = NEW.owner AND kind = NEW.kind AND source_id = NEW.source_id AND fingerprint = NEW.fingerprint
)
BEGIN
  SELECT CASE WHEN COUNT(*) >= 8000
    OR COALESCE(SUM(payload_bytes), 0) + length(CAST(NEW.payload AS BLOB)) > 83886080
    THEN RAISE(ABORT, 'member_archive_limit') END
    FROM member_archive_records WHERE owner = NEW.owner;
END;
