-- Queue + progress for the 15-minute UDisc layout importer.
-- One course per cron tick uses the existing parseUdiscLayouts importer (not a new scraper).
CREATE TABLE udisc_layout_imports (
  course_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  udisc_url TEXT,
  layouts_imported INTEGER NOT NULL DEFAULT 0,
  mapped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX idx_udisc_layout_imports_status ON udisc_layout_imports (status, attempted_at);

CREATE TABLE udisc_layout_import_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hydrated_at INTEGER,
  last_course_id INTEGER,
  last_status TEXT,
  last_name TEXT,
  last_error TEXT,
  last_run_at INTEGER
);

INSERT INTO udisc_layout_import_state (id) VALUES (1);
