-- Batch 6: idempotent store-order restock guard, PayPal SDK guest contact persistence,
-- and unique member constraint on imported bag-tag league ladders.
ALTER TABLE store_orders ADD COLUMN restocked_at TEXT;
ALTER TABLE store_payment_sessions ADD COLUMN contact TEXT;

-- Deduplicate any pre-existing duplicate (league_id, member_id) rows before adding the unique index.
UPDATE bag_tag_league_ladder
SET member_id = NULL
WHERE member_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM bag_tag_league_ladder
    WHERE member_id IS NOT NULL
    GROUP BY league_id, member_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_bag_tag_league_ladder_member_uniq
  ON bag_tag_league_ladder(league_id, member_id)
  WHERE member_id IS NOT NULL;
