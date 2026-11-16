-- Online membership dues + applicant push opt-in. Applications themselves live in ROSTER KV
-- (apply:<id>); this table holds each application's payment record so capture can be reserved and
-- recorded atomically (PayPal order id is UNIQUE => a retried capture can never double-record).
-- Rows outlive the application (kept after approve/reject as the audit trail; member_id is set on approve).
CREATE TABLE IF NOT EXISTS membership_dues (
  application_id TEXT PRIMARY KEY,
  method TEXT NOT NULL DEFAULT 'none' CHECK (method IN ('paypal', 'manual', 'none')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  reserved_order_id TEXT,
  claimed_other INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  marked_by TEXT,
  marked_by_id TEXT,
  note TEXT,
  member_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_dues_order ON membership_dues(paypal_order_id) WHERE paypal_order_id IS NOT NULL;

-- One optional Web Push subscription per pending application; deleted when the application is
-- approved (after the welcome push) or rejected.
CREATE TABLE IF NOT EXISTS membership_push_subscriptions (
  application_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
