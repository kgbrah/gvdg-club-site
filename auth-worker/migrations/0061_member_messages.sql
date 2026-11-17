-- Direct messages between two members, plus in-app notices for updates they have not opened.
CREATE TABLE IF NOT EXISTS member_threads (
  id INTEGER PRIMARY KEY,
  member_low TEXT NOT NULL,
  member_high TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_body TEXT NOT NULL DEFAULT '',
  last_sender_id TEXT NOT NULL DEFAULT '',
  UNIQUE (member_low, member_high)
);

CREATE TABLE IF NOT EXISTS member_messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES member_threads(id),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS member_messages_thread ON member_messages(thread_id, id);

CREATE TABLE IF NOT EXISTS member_thread_reads (
  thread_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, member_id)
);

CREATE TABLE IF NOT EXISTS member_notices (
  id INTEGER PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS member_notices_ref ON member_notices(member_id, ref_key);
CREATE INDEX IF NOT EXISTS member_notices_member ON member_notices(member_id, id DESC);

ALTER TABLE member_push_subscriptions ADD COLUMN messages INTEGER NOT NULL DEFAULT 1;
