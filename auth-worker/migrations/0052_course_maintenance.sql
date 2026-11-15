CREATE TABLE course_maintenance_tasks (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'completed')),
  due_date TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_request_key TEXT NOT NULL,
  UNIQUE (course_id, id)
);
CREATE INDEX idx_course_maintenance_status ON course_maintenance_tasks(course_id, status, id DESC);

CREATE TABLE course_maintenance_operations (
  course_id INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'edit')),
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (course_id, request_key),
  FOREIGN KEY (course_id, task_id) REFERENCES course_maintenance_tasks(course_id, id) ON DELETE CASCADE
);
