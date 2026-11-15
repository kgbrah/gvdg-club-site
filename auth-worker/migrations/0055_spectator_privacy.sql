CREATE TABLE casual_round_sharing (
  round_code TEXT PRIMARY KEY COLLATE NOCASE,
  visibility TEXT NOT NULL CHECK (visibility IN ('card', 'link', 'public')),
  link_hash TEXT,
  include_marked INTEGER NOT NULL DEFAULT 0 CHECK (include_marked IN (0, 1)),
  CHECK ((visibility = 'link') = (link_hash IS NOT NULL))
);

CREATE UNIQUE INDEX idx_casual_round_watch_link ON casual_round_sharing(link_hash) WHERE link_hash IS NOT NULL;

-- Keep established clips available. Every new upload explicitly stores 'private'.
ALTER TABLE throw_clips ADD COLUMN visibility TEXT NOT NULL DEFAULT 'round'
  CHECK (visibility IN ('private', 'round'));

-- Bind new clips to the immutable round generation and durable player label.
ALTER TABLE throw_clips ADD COLUMN round_generation TEXT;
ALTER TABLE casual_results ADD COLUMN live_player_index INTEGER;
ALTER TABLE casual_rounds ADD COLUMN live_generation TEXT;
