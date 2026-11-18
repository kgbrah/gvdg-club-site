-- Guest accounts (the owner's promotion): the first GUEST_PROMO_LIMIT (100) approved guest applications get promo
-- access (round history and stats, like a member). One row per promo guest; the limit is enforced by an
-- INSERT ... SELECT ... WHERE COUNT < limit at approval, so concurrent approvals can't pass it.
CREATE TABLE IF NOT EXISTS guest_promo (
  member_id   TEXT PRIMARY KEY,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by TEXT
);
