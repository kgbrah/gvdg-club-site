-- The 22:15 importer tick linked two catalog courses to the wrong UDisc pages:
-- Natural Bridge State Park (Natural Bridge, VA) -> Natural Bridge KOA in New York (49238),
-- James Island County Park (Charleston, SC) -> Island Park in Manitoba (6322).
-- UDisc has no page for either catalog course. Drop those links, the imported tee maps,
-- and the extra layout rows, then close the search so the next tick cannot put them back.

DELETE FROM course_positions
WHERE course_id IN (
  SELECT id FROM courses
  WHERE (name = 'Natural Bridge State Park' AND udisc_course_id = '49238')
     OR (name = 'James Island County Park' AND udisc_course_id = '6322')
);

DELETE FROM course_layouts
WHERE id IN (
  SELECT cl.id
  FROM course_layouts cl
  JOIN courses c ON c.id = cl.course_id
  WHERE (
      (c.name = 'Natural Bridge State Park' AND c.udisc_course_id = '49238' AND cl.name = 'Red Disc & Target Set')
      OR (c.name = 'James Island County Park' AND c.udisc_course_id = '6322' AND cl.name = 'Portage Open 2024')
    )
    AND NOT EXISTS (SELECT 1 FROM events ev WHERE ev.layout_id = cl.id)
    AND NOT EXISTS (SELECT 1 FROM round_ratings rr WHERE rr.layout_id = cl.id)
    AND NOT EXISTS (SELECT 1 FROM casual_round_requests q WHERE q.layout_id = cl.id)
    AND NOT EXISTS (SELECT 1 FROM casual_rounds cr WHERE cr.layout_id = cl.id)
    AND NOT EXISTS (SELECT 1 FROM event_courses e WHERE e.layout_id = cl.id)
);

UPDATE course_layouts
SET name = 'Default (par 3s)',
    holes = '[{"hole":1,"par":3},{"hole":2,"par":3},{"hole":3,"par":3},{"hole":4,"par":3},{"hole":5,"par":3},{"hole":6,"par":3},{"hole":7,"par":3},{"hole":8,"par":3},{"hole":9,"par":3},{"hole":10,"par":3},{"hole":11,"par":3},{"hole":12,"par":3},{"hole":13,"par":3},{"hole":14,"par":3},{"hole":15,"par":3},{"hole":16,"par":3},{"hole":17,"par":3},{"hole":18,"par":3}]',
    total_par = 54
WHERE course_id IN (
  SELECT id FROM courses
  WHERE (name = 'Natural Bridge State Park' AND udisc_course_id = '49238')
     OR (name = 'James Island County Park' AND udisc_course_id = '6322')
);

UPDATE courses
SET udisc_url = NULL,
    udisc_course_id = NULL
WHERE (name = 'Natural Bridge State Park' AND udisc_course_id = '49238')
   OR (name = 'James Island County Park' AND udisc_course_id = '6322');

INSERT INTO udisc_layout_imports (course_id, status, udisc_url, layouts_imported, mapped, error, attempts, attempted_at, finished_at)
SELECT id, 'no_url', NULL, 0, 0, 'no_udisc_search', 3, unixepoch() * 1000, unixepoch() * 1000
FROM courses
WHERE name IN ('Natural Bridge State Park', 'James Island County Park')
ON CONFLICT(course_id) DO UPDATE SET
  status = 'no_url',
  udisc_url = NULL,
  layouts_imported = 0,
  mapped = 0,
  error = 'no_udisc_search',
  attempts = 3,
  finished_at = unixepoch() * 1000;
