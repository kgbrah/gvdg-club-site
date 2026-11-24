-- Temporary cache for official PDGA REST API /services/json/player-statistics responses.
-- Purged hourly past PDGA_PLAYER_CACHE_MAX_MS (6 hours) by purgePdgaCaches (License Section 6).
CREATE TABLE IF NOT EXISTS pdga_api_player_stats (
  pdga_number TEXT NOT NULL,
  year        INTEGER NOT NULL,
  data        TEXT,              -- JSON array of annual stat rows; "[]" = none for that year
  fetched_at  INTEGER NOT NULL,  -- epoch ms
  PRIMARY KEY (pdga_number, year)
);
CREATE INDEX IF NOT EXISTS idx_pdga_api_player_stats_fetched ON pdga_api_player_stats(fetched_at);
