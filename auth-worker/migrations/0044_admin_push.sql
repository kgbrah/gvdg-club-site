-- Admin phones that asked for Web Push. The endpoint is the push service URL.
-- Losing a row only means that phone stops getting alerts; it does not affect the action.
CREATE TABLE admin_push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_push_member ON admin_push_subscriptions (member_id);
