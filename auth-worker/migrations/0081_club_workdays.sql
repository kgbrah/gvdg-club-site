-- Club workday organizer: admin announcements, member sign-ups (shown on Member Home),
-- browser GPS check-in, and admin-verified karma rewards.
CREATE TABLE IF NOT EXISTS club_workdays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  location_name TEXT NOT NULL,
  lat REAL,
  lng REAL,
  radius_ft INTEGER NOT NULL DEFAULT 2000 CHECK (radius_ft >= 100 AND radius_ft <= 26400),
  workday_date TEXT NOT NULL,
  start_time TEXT,
  karma_reward INTEGER NOT NULL DEFAULT 25 CHECK (karma_reward >= 0 AND karma_reward <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'completed', 'cancelled')),
  announced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_club_workdays_status_date ON club_workdays (status, workday_date, id);

CREATE TABLE IF NOT EXISTS club_workday_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workday_id INTEGER NOT NULL REFERENCES club_workdays(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'signed_up' CHECK (status IN ('signed_up', 'checked_in', 'verified', 'no_show')),
  signed_up_at TEXT NOT NULL DEFAULT (datetime('now')),
  gps_lat REAL,
  gps_lng REAL,
  gps_accuracy_m REAL,
  gps_distance_ft INTEGER,
  gps_verified INTEGER NOT NULL DEFAULT 0 CHECK (gps_verified IN (0, 1)),
  checked_in_at TEXT,
  verified_at TEXT,
  verified_by TEXT,
  karma_awarded INTEGER NOT NULL DEFAULT 0 CHECK (karma_awarded >= 0),
  admin_note TEXT,
  UNIQUE (workday_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_workday_signups_workday ON club_workday_signups (workday_id, status, id);
CREATE INDEX IF NOT EXISTS idx_workday_signups_member ON club_workday_signups (member_id, status);
