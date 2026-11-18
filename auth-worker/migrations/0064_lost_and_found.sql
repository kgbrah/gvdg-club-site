-- Lost & Found: found and lost disc posts, privately stored original photos with public copies whose writing
-- the poster's browser hid and the AI verified, AI extractions (private ink text + boxes), suggested matches, claims and returns with a state
-- log, an append-only karma ledger, celebrations with photos, reports and an admin moderation log.
--
-- Identities are the marketplace's: an owner id is a roster member id or a verified guest ("mg_<n>",
-- market_guests from 0063), so one emailed-code guest identity works for both. Public payloads use
-- market_traders.trader_key, never owner ids or emails.
--
-- PRIVACY: lf_posts.private_ink, lf_extractions.ink_json / ink_names / ink_phones and
-- lf_photos.original_key / candidate_key are for matching and hiding only; an original reaches nobody but its
-- uploader, and only while the writing is being hidden.

CREATE TABLE IF NOT EXISTS lf_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('found', 'lost')),
  owner_id     TEXT NOT NULL,
  -- open -> claimed (a return is under way) -> returned (owner confirmed); or closed / expired / merged.
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'returned', 'closed', 'expired', 'merged')),
  brand        TEXT NOT NULL DEFAULT '',
  mold         TEXT NOT NULL DEFAULT '',
  plastic      TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  course_id    INTEGER,
  course_name  TEXT NOT NULL DEFAULT '',
  area         TEXT NOT NULL DEFAULT '',
  event_date   TEXT,
  -- Found posts: who holds the disc now.
  holding      TEXT CHECK (holding IS NULL OR holding IN ('finder', 'club_bin')),
  bin_note     TEXT NOT NULL DEFAULT '',
  -- Lost posts: an optional public reward note and the PRIVATE "what's written on it".
  reward_note  TEXT NOT NULL DEFAULT '',
  private_ink  TEXT NOT NULL DEFAULT '',
  -- Which details the AI filled in (comma list of field names), shown as "read from the photo".
  ai_fields    TEXT NOT NULL DEFAULT '',
  ai_compares  INTEGER NOT NULL DEFAULT 0,
  hidden       INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  merged_into  INTEGER,
  close_reason TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS lf_posts_browse ON lf_posts(kind, status, hidden, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS lf_posts_owner ON lf_posts(owner_id, status);
CREATE INDEX IF NOT EXISTS lf_posts_expiry ON lf_posts(status, expires_at);
CREATE INDEX IF NOT EXISTS lf_posts_course ON lf_posts(course_id, kind, status);

-- One row per uploaded photo (a post's or a celebration's). The original lives under a private R2 key that
-- only its uploader can fetch, and only while the writing is being hidden. The Worker never decodes an image:
-- the AI returns boxes, the POSTER'S BROWSER paints a solid patch over each one and uploads that copy
-- (candidate_key, private), and the AI checks it; only a copy that passed the check becomes public_key.
CREATE TABLE IF NOT EXISTS lf_photos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id        INTEGER REFERENCES lf_posts(id),
  celebration_id INTEGER,
  owner_id       TEXT NOT NULL,
  original_key   TEXT,
  original_type  TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  -- Pixel size read from the file header at upload (no decode); the public copy must keep the aspect ratio.
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  candidate_key  TEXT,
  public_key     TEXT,
  public_bytes   INTEGER,
  -- pending: waiting for the AI read; hiding: boxes ready, waiting for the poster's browser; verifying: the
  -- poster's copy waits for the AI check; public: verified copy served; failed: retries used up (admin queue);
  -- removed: taken down.
  redaction      TEXT NOT NULL DEFAULT 'pending' CHECK (redaction IN ('pending', 'hiding', 'verifying', 'public', 'failed', 'removed')),
  boxes          INTEGER NOT NULL DEFAULT 0,
  -- Times the AI check found writing still readable; each one widens the patches the browser paints.
  rejections     INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error     TEXT NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at   TEXT,
  CHECK ((post_id IS NULL) <> (celebration_id IS NULL))
);
CREATE INDEX IF NOT EXISTS lf_photos_post ON lf_photos(post_id, sort_order, id);
CREATE INDEX IF NOT EXISTS lf_photos_celebration ON lf_photos(celebration_id, sort_order, id);
CREATE INDEX IF NOT EXISTS lf_photos_queue ON lf_photos(redaction, next_attempt_at);
CREATE INDEX IF NOT EXISTS lf_photos_owner ON lf_photos(owner_id, redaction);

-- One AI extraction per photo (re-run only while the photo is still pending). ink_* are PRIVATE; boxes_json
-- holds only the normalised rectangles the poster's browser needs (never any text).
CREATE TABLE IF NOT EXISTS lf_extractions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id     INTEGER NOT NULL UNIQUE REFERENCES lf_photos(id),
  post_id      INTEGER,
  source       TEXT NOT NULL DEFAULT '',
  -- ok: trusted read, every piece of writing boxed; unsure: writing it could not box or read, or an
  -- untrusted provider; empty: nothing usable came back.
  status       TEXT NOT NULL CHECK (status IN ('ok', 'unsure', 'empty')),
  brand        TEXT NOT NULL DEFAULT '',
  mold         TEXT NOT NULL DEFAULT '',
  plastic      TEXT NOT NULL DEFAULT '',
  colors       TEXT NOT NULL DEFAULT '[]',
  stamp        TEXT NOT NULL DEFAULT '',
  ink_json     TEXT NOT NULL DEFAULT '[]',
  ink_names    TEXT NOT NULL DEFAULT '',
  ink_phones   TEXT NOT NULL DEFAULT '',
  boxes_json   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lf_extractions_post ON lf_extractions(post_id);

-- Suggested matches between a found post and a possible owner: the poster of a lost post, or a club member
-- whose name is written on the disc (lost_id NULL). The AI only suggests; the owner decides.
CREATE TABLE IF NOT EXISTS lf_matches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  found_id     INTEGER NOT NULL REFERENCES lf_posts(id),
  lost_id      INTEGER REFERENCES lf_posts(id),
  candidate_id TEXT NOT NULL,
  score        INTEGER NOT NULL,
  reasons      TEXT NOT NULL DEFAULT '[]',
  ai_verdict   TEXT CHECK (ai_verdict IS NULL OR ai_verdict IN ('same', 'different', 'unsure')),
  status       TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'notified', 'claimed', 'declined', 'dismissed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at  TEXT,
  UNIQUE (found_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS lf_matches_candidate ON lf_matches(candidate_id, status);
CREATE INDEX IF NOT EXISTS lf_matches_lost ON lf_matches(lost_id, status);
CREATE INDEX IF NOT EXISTS lf_matches_review ON lf_matches(status, score DESC);

-- "That's mine": the owner claims a found disc. The finder marks it returned; the owner confirms.
CREATE TABLE IF NOT EXISTS lf_claims (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  found_id     INTEGER NOT NULL REFERENCES lf_posts(id),
  lost_id      INTEGER REFERENCES lf_posts(id),
  match_id     INTEGER REFERENCES lf_matches(id),
  finder_id    TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'returned', 'confirmed', 'cancelled', 'declined')),
  message      TEXT NOT NULL DEFAULT '',
  dm_thread_id INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  returned_at  TEXT,
  confirmed_at TEXT,
  closed_at    TEXT,
  CHECK (finder_id <> owner_id)
);
CREATE INDEX IF NOT EXISTS lf_claims_found ON lf_claims(found_id, status);
CREATE INDEX IF NOT EXISTS lf_claims_finder ON lf_claims(finder_id, status);
CREATE INDEX IF NOT EXISTS lf_claims_owner ON lf_claims(owner_id, status);
-- One live claim per person per disc; at most one return in progress per found post.
CREATE UNIQUE INDEX IF NOT EXISTS lf_claims_one_open ON lf_claims(found_id, owner_id) WHERE status IN ('open', 'returned');
CREATE UNIQUE INDEX IF NOT EXISTS lf_claims_one_return ON lf_claims(found_id) WHERE status IN ('returned', 'confirmed');

CREATE TABLE IF NOT EXISTS lf_claim_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id    INTEGER,
  post_id     INTEGER,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lf_claim_log_claim ON lf_claim_log(claim_id, id);
CREATE INDEX IF NOT EXISTS lf_claim_log_post ON lf_claim_log(post_id, id);

-- Relayed messages for a claim when either side is a guest (members use direct messages). Email relay
-- never reveals an address.
CREATE TABLE IF NOT EXISTS lf_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id   INTEGER NOT NULL REFERENCES lf_claims(id),
  sender_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lf_messages_claim ON lf_messages(claim_id, id);

-- Karma: append-only. +10 once per confirmed return, an admin reversal at most once per return. A finder's
-- score is SUM(delta); discs returned = confirmed returns without a reversal.
CREATE TABLE IF NOT EXISTS lf_karma (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  TEXT NOT NULL,
  claim_id   INTEGER NOT NULL REFERENCES lf_claims(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('return_confirmed', 'admin_reversal')),
  admin_id   TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (claim_id, reason)
);
CREATE INDEX IF NOT EXISTS lf_karma_person ON lf_karma(person_id);
CREATE TRIGGER IF NOT EXISTS lf_karma_no_update BEFORE UPDATE ON lf_karma
BEGIN SELECT RAISE(ABORT, 'lf_karma is append-only'); END;
CREATE TRIGGER IF NOT EXISTS lf_karma_no_delete BEFORE DELETE ON lf_karma
BEGIN SELECT RAISE(ABORT, 'lf_karma is append-only'); END;

-- After a confirmed return the finder (and optionally the owner) can post a celebration: a caption and 1-2
-- photos that go through the same redaction pipeline.
CREATE TABLE IF NOT EXISTS lf_celebrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id   INTEGER NOT NULL REFERENCES lf_claims(id),
  author_id  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('finder', 'owner')),
  caption    TEXT NOT NULL DEFAULT '',
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (claim_id, author_id)
);
CREATE INDEX IF NOT EXISTS lf_celebrations_wall ON lf_celebrations(hidden, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS lf_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'celebration')),
  target_id   INTEGER NOT NULL,
  reporter_id TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution  TEXT,
  UNIQUE (target_kind, target_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS lf_reports_queue ON lf_reports(status, created_at);

CREATE TABLE IF NOT EXISTS lf_mod_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lf_mod_log_recent ON lf_mod_log(id DESC);
