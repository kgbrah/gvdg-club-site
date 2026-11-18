-- Round karma watch (the owner's rule): +1 karma for every round finished in the app, but a member who finishes more
-- than 3 rounds in one day (club time) is flagged for an admin (push + the admin badge). The admin either clears it, or
-- finds them gaming the system: that day's round karma is taken back and 3x as much again is taken as a penalty. A
-- penalty can be undone (one entry gives it all back), which closes the flag as 'undone'.
CREATE TABLE IF NOT EXISTS karma_flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   TEXT NOT NULL,
  day         TEXT NOT NULL,
  rounds      INTEGER NOT NULL CHECK (rounds > 0),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'penalized', 'undone')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  UNIQUE (member_id, day)
);
CREATE INDEX IF NOT EXISTS karma_flags_status ON karma_flags(status, created_at);

-- Admin karma changes, append-only like the Lost & Found ledger: who, how much, why, and which flag.
CREATE TABLE IF NOT EXISTS karma_adjustments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  TEXT NOT NULL,
  delta      INTEGER NOT NULL CHECK (delta <> 0),
  reason     TEXT NOT NULL CHECK (reason IN ('rounds_removed', 'gaming_penalty', 'penalty_undone')),
  flag_id    INTEGER REFERENCES karma_flags(id),
  admin_id   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (flag_id, reason)
);
CREATE INDEX IF NOT EXISTS karma_adjustments_member ON karma_adjustments(member_id);
CREATE TRIGGER IF NOT EXISTS karma_adjustments_no_update BEFORE UPDATE ON karma_adjustments
BEGIN SELECT RAISE(ABORT, 'karma_adjustments is append-only'); END;
CREATE TRIGGER IF NOT EXISTS karma_adjustments_no_delete BEFORE DELETE ON karma_adjustments
BEGIN SELECT RAISE(ABORT, 'karma_adjustments is append-only'); END;
