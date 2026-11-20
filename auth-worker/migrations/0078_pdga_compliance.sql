-- PDGA Developer Program review (2026-11-20). PDGA asked the club to read PDGA data only through its documented
-- APIs (no pdga.com pages, no internal /api/v1/feat/... endpoints) and reminded us that its API license (Section 6)
-- allows temporary caching only: PDGA data can't be stored permanently or used to build our own database.

-- 1. Data read from pdga.com pages or internal endpoints, and PDGA rounds stored to build course baselines: deleted.
--    (Dropping pdga_rated_rounds / pdga_layout_matches drops the pdga_evidence_* triggers defined on them.)
DROP TABLE IF EXISTS pdga_cache;
DROP TABLE IF EXISTS pdga_watch_events;
DROP TABLE IF EXISTS pdga_registrations;
DROP TABLE IF EXISTS pdga_evidence_changes;
DROP TABLE IF EXISTS pdga_round_scores;
DROP TABLE IF EXISTS pdga_layout_matches;
DROP TABLE IF EXISTS pdga_rated_rounds;
DROP TABLE IF EXISTS pdga_ingest_queue;
DROP TABLE IF EXISTS pdga_discovery_state;

-- 2. Club round ratings that were derived from a PDGA layout baseline: re-rated from club data by the next ratings
--    run (queued below), unrated until then. No round keeps a PDGA baseline number.
INSERT OR REPLACE INTO rating_repair_issues (stream, source_id, attempts, last_code, checked_at, retry_at)
  SELECT DISTINCT 'competition', rr.event_id, 1, 'pdga-baseline-removed',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM round_ratings rr
  WHERE rr.stream = 'competition' AND rr.rating_method = 'pdga' AND rr.event_id IS NOT NULL;
INSERT OR REPLACE INTO rating_repair_issues (stream, source_id, attempts, last_code, checked_at, retry_at)
  SELECT DISTINCT 'casual', cr.casual_round_id, 1, 'pdga-baseline-removed',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM round_ratings rr JOIN casual_results cr ON cr.id = rr.source_result_id
  WHERE rr.stream = 'casual' AND rr.rating_method = 'pdga' AND cr.casual_round_id IS NOT NULL;
UPDATE round_ratings SET round_rating = NULL, ssa = NULL, ppt = NULL, weather_adjustment = 0, rating_method = 'unrated',
    unrated_reason = 'pdga-baseline-removed'
  WHERE rating_method = 'pdga';
UPDATE round_ratings SET pdga_baseline_ssa = NULL, pdga_baseline_rounds = NULL
  WHERE pdga_baseline_ssa IS NOT NULL OR pdga_baseline_rounds IS NOT NULL;

-- 3. Members' PDGA ratings as rating anchors: kept only while the PDGA API keeps confirming them (daily) and for 7
--    days after (ratings-recompute.ts). The history of past ratings goes; each member's newest one stays until the
--    next daily refresh confirms or replaces it.
ALTER TABLE rating_anchor_snapshots ADD COLUMN confirmed_at TEXT;
DELETE FROM rating_anchor_snapshots WHERE EXISTS (
  SELECT 1 FROM rating_anchor_snapshots newer
  WHERE newer.member_id = rating_anchor_snapshots.member_id
    AND (newer.effective_at > rating_anchor_snapshots.effective_at
      OR (newer.effective_at = rating_anchor_snapshots.effective_at AND newer.observed_at > rating_anchor_snapshots.observed_at))
);
UPDATE rating_anchor_snapshots SET confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE INDEX IF NOT EXISTS idx_rating_anchor_confirmed ON rating_anchor_snapshots(confirmed_at);

-- 4. PDGA API caches start empty (they refill from the API and are purged hourly past their cache time).
DELETE FROM pdga_api_players;
DELETE FROM kv_store WHERE ns = 'pdgaevents';

-- 5. The club's own PDGA events: the PDGA event details copy is re-read from the API hourly (pdga-event-cache.ts);
--    registrants' PDGA status/rating are cleared once an event is two weeks past.
UPDATE event_config SET pdga_event = NULL WHERE pdga_event IS NOT NULL;
UPDATE registrations SET pdga_status = NULL, pdga_rating = NULL, pdga_checked_at = NULL
  WHERE (pdga_status IS NOT NULL OR pdga_rating IS NOT NULL)
    AND event_id IN (SELECT e.id FROM events e WHERE e.date IS NOT NULL AND substr(e.date, 1, 10) < date('now', '-14 days'));
