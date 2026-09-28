-- Rocky Ford (Kittrell) was seeded at a house on Rocky Ford Road in Franklinton and
-- marked done when the public UDisc directory did not list it. The layout is private:
-- https://udisc.com/courses/rocky-ford-FdSt (course 28909), pin published by UDisc.
-- Runaway Rocks is the second course on the same property and was never inserted.
-- Clearing the import row lets the next cron tick pull layouts.

UPDATE courses
SET location = 'Kittrell, NC',
    udisc_url = 'https://udisc.com/courses/rocky-ford-FdSt',
    udisc_course_id = '28909',
    lat = 36.177604,
    lng = -78.343701
WHERE name = 'Rocky Ford'
  AND location = 'Franklinton, NC';

DELETE FROM udisc_layout_imports
WHERE course_id IN (SELECT id FROM courses WHERE name = 'Rocky Ford');

INSERT OR IGNORE INTO courses (name, location, udisc_url, udisc_course_id, lat, lng, is_default, created_by)
VALUES (
  'Runaway Rocks',
  'Kittrell, NC',
  'https://udisc.com/courses/runaway-rocks-08Hj',
  '28910',
  36.177604,
  -78.343701,
  1,
  'nearby-courses'
);

INSERT INTO course_layouts (course_id, name, holes, total_par)
SELECT id, 'Default (par 3s)',
  '[{"hole":1,"par":3},{"hole":2,"par":3},{"hole":3,"par":3},{"hole":4,"par":3},{"hole":5,"par":3},{"hole":6,"par":3},{"hole":7,"par":3},{"hole":8,"par":3},{"hole":9,"par":3},{"hole":10,"par":3},{"hole":11,"par":3},{"hole":12,"par":3},{"hole":13,"par":3},{"hole":14,"par":3},{"hole":15,"par":3},{"hole":16,"par":3},{"hole":17,"par":3},{"hole":18,"par":3}]',
  54
FROM courses
WHERE name = 'Runaway Rocks'
  AND NOT EXISTS (SELECT 1 FROM course_layouts WHERE course_id = courses.id);
