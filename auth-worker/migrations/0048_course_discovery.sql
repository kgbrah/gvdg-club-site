-- Record edits from the existing admin layout, approved tee sign, and import flows.
ALTER TABLE course_layouts ADD COLUMN updated_at TEXT;
ALTER TABLE course_layouts ADD COLUMN expected_holes INTEGER CHECK (expected_holes BETWEEN 1 AND 36);
CREATE TRIGGER course_layouts_mark_updated
AFTER UPDATE OF name, holes, total_par, expected_holes ON course_layouts
WHEN OLD.name IS NOT NEW.name OR OLD.holes IS NOT NEW.holes OR OLD.total_par IS NOT NEW.total_par OR OLD.expected_holes IS NOT NEW.expected_holes
BEGIN
  UPDATE course_layouts SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Favorites belong to the signed-in account and follow it across devices.
CREATE TABLE member_course_favorites (
  member_id TEXT NOT NULL,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (member_id, course_id)
);
CREATE INDEX idx_member_course_favorites_course ON member_course_favorites(course_id);
