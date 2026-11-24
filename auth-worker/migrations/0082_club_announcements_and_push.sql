-- Dedicated club announcements preference (default ON for everyone with push enabled)
-- and admin-posted club announcements log.

ALTER TABLE member_push_subscriptions ADD COLUMN announcements INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS club_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT NOT NULL DEFAULT '/gvdg-members.html#home',
  created_by TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS club_announcements_created
  ON club_announcements(created_at DESC, id DESC);
