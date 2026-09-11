-- Spectator chat for live events. Writes only while the event is live; public reads.
CREATE TABLE event_chat (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   TEXT,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_chat_event_id ON event_chat(event_id, id);
