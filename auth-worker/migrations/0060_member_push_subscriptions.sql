-- Member Web Push: one row per device (endpoint). bag_tags is the member's "Bag tag challenges"
-- preference (1 = on); it is kept equal across all of a member's devices.
CREATE TABLE IF NOT EXISTS member_push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  bag_tags   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS member_push_subscriptions_member ON member_push_subscriptions(member_id);
