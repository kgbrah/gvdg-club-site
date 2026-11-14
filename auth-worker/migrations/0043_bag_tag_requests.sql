-- A member can ask for a physical tag. They do not pick the number.
-- Assigning the tag removes the request. One open request per member.
CREATE TABLE bag_tag_requests (
  series_id   INTEGER NOT NULL,
  member_id   TEXT NOT NULL,
  member_name TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (series_id, member_id)
);
