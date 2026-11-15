-- No member is published until they save an explicit audience.
CREATE TABLE community_profiles (
  member_id TEXT PRIMARY KEY,
  profile_key TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL CHECK (audience IN ('private', 'friends', 'club', 'public')),
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  share_progress INTEGER NOT NULL DEFAULT 0 CHECK (share_progress IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX community_profiles_directory ON community_profiles(audience, display_name, profile_key);

CREATE TABLE community_connections (
  member_low TEXT NOT NULL,
  member_high TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (member_low, member_high),
  CHECK (member_low < member_high AND (requested_by = member_low OR requested_by = member_high))
);
CREATE INDEX community_connections_high ON community_connections(member_high);

CREATE TABLE community_blocks (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
);
CREATE INDEX community_blocks_target ON community_blocks(blocked, blocker);

CREATE TABLE community_course_metadata (
  course_id INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('unknown', 'beginner', 'intermediate', 'advanced')),
  amenities TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE community_course_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'hidden', 'removed')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  UNIQUE (course_id, member_id)
);
CREATE INDEX community_course_reviews_public ON community_course_reviews(course_id, state, published_at DESC, id);
CREATE INDEX community_course_reviews_queue ON community_course_reviews(state, updated_at, id);

CREATE TABLE community_review_reports (
  review_id INTEGER NOT NULL REFERENCES community_course_reviews(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  reporter TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('abuse', 'unsafe', 'misleading', 'other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_id, revision, reporter)
);
CREATE INDEX community_review_reports_queue ON community_review_reports(status, review_id, revision);
