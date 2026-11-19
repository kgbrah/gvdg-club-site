-- PDGA REST API player records (one per PDGA number), read with the club's PDGA developer account. Kept a few
-- hours so a page and the daily rating job don't each call PDGA (70 requests per 10 seconds per IP, login included).
CREATE TABLE IF NOT EXISTS pdga_api_players (
  pdga_number TEXT PRIMARY KEY,
  data        TEXT,              -- the API's player record as JSON; NULL = PDGA has no such number
  fetched_at  INTEGER NOT NULL   -- epoch ms
);
