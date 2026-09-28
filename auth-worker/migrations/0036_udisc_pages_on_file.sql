-- Pin catalog rows whose UDisc pages the name search could not safely auto-attach, and
-- drop the Fuquay-Varina Higher Ground link to Croswell, Michigan (course 45860).
-- UDisc has no Fuquay-Varina Higher Ground. The import row is closed so a later tick
-- does not search that name again and put the Michigan page back.
-- Chester's Burgundy 9 is a second UDisc course on the same park (Green is the 18).
-- Clearing import rows lets the next cron ticks copy layouts. Pisgah Brewery is already
-- linked (hhKx) and its page has pars but no tee GPS, so it stays unmapped.

UPDATE courses
SET udisc_url = NULL,
    udisc_course_id = NULL
WHERE name = 'Higher Ground'
  AND udisc_course_id = '45860';

UPDATE course_layouts
SET name = 'Default (par 3s)',
    holes = '[{"hole":1,"par":3},{"hole":2,"par":3},{"hole":3,"par":3},{"hole":4,"par":3},{"hole":5,"par":3},{"hole":6,"par":3},{"hole":7,"par":3},{"hole":8,"par":3},{"hole":9,"par":3},{"hole":10,"par":3},{"hole":11,"par":3},{"hole":12,"par":3},{"hole":13,"par":3},{"hole":14,"par":3},{"hole":15,"par":3},{"hole":16,"par":3},{"hole":17,"par":3},{"hole":18,"par":3}]',
    total_par = 54
WHERE course_id IN (SELECT id FROM courses WHERE name = 'Higher Ground' AND udisc_url IS NULL)
  AND name = 'Main'
  AND holes NOT LIKE '%"lat":%';

INSERT INTO udisc_layout_imports (course_id, status, udisc_url, layouts_imported, mapped, error, attempts, attempted_at, finished_at)
SELECT id, 'no_url', NULL, 0, 0, 'no_udisc_search', 3, unixepoch() * 1000, unixepoch() * 1000
FROM courses
WHERE name = 'Higher Ground'
ON CONFLICT(course_id) DO UPDATE SET
  status = 'no_url',
  udisc_url = NULL,
  layouts_imported = 0,
  mapped = 0,
  error = 'no_udisc_search',
  attempts = 3,
  finished_at = unixepoch() * 1000;

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/ballyknock-5F4u',
    udisc_course_id = '4146',
    lat = 38.490631,
    lng = -79.343887
WHERE name = 'Ballyknock'
  AND location = 'Sugar Grove, WV'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/ballyknock-5F4u');

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/chester-state-park-green-urME',
    udisc_course_id = '4268',
    lat = 34.677363,
    lng = -81.237172
WHERE name = 'Chester State Park'
  AND location = 'Chester, SC'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/chester-state-park-green-urME');

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/hazel-grove-at-wpr-3QAd',
    udisc_course_id = '28285'
WHERE name = 'Hazel Grove at Wilderness Presidential Resort'
  AND location = 'Spotsylvania, VA'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/hazel-grove-at-wpr-3QAd');

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/jefferson-elementary-school-y3f7',
    udisc_course_id = '28140'
WHERE name = 'Jefferson Elementary School'
  AND location = 'York, SC'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/jefferson-elementary-school-y3f7');

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/virginia-wesleyan-m1If',
    udisc_course_id = '4283'
WHERE name = 'Virginia Wesleyan College'
  AND location = 'Virginia Beach, VA'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/virginia-wesleyan-m1If');

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/york-preparatory-academy-OBiK',
    udisc_course_id = '20182'
WHERE name = 'York Preparatory Academy'
  AND location = 'Rock Hill, SC'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/york-preparatory-academy-OBiK');

UPDATE courses
SET udisc_url = 'https://udisc.com/courses/shaw-afb-disc-golf-course-nDUf',
    udisc_course_id = '23530'
WHERE name = 'Shaw Air Force Base'
  AND location = 'Shaw AFB, SC'
  AND (udisc_url IS NULL OR trim(udisc_url) = '' OR udisc_url = 'https://udisc.com/courses/shaw-afb-disc-golf-course-nDUf');

INSERT OR IGNORE INTO courses (name, location, udisc_url, udisc_course_id, lat, lng, is_default, created_by)
VALUES (
  'Chester State Park - Burgundy',
  'Chester, SC',
  'https://udisc.com/courses/chester-state-park-burgundy-U9Vw',
  '22092',
  34.678556,
  -81.238401,
  1,
  'nearby-courses'
);

INSERT INTO course_layouts (course_id, name, holes, total_par)
SELECT id, 'Default (par 3s)',
  '[{"hole":1,"par":3},{"hole":2,"par":3},{"hole":3,"par":3},{"hole":4,"par":3},{"hole":5,"par":3},{"hole":6,"par":3},{"hole":7,"par":3},{"hole":8,"par":3},{"hole":9,"par":3}]',
  27
FROM courses
WHERE name = 'Chester State Park - Burgundy'
  AND NOT EXISTS (SELECT 1 FROM course_layouts WHERE course_id = courses.id);

DELETE FROM udisc_layout_imports
WHERE course_id IN (
  SELECT id FROM courses WHERE name IN (
    'Ballyknock',
    'Chester State Park',
    'Chester State Park - Burgundy',
    'Hazel Grove at Wilderness Presidential Resort',
    'Jefferson Elementary School',
    'Virginia Wesleyan College',
    'York Preparatory Academy',
    'Shaw Air Force Base'
  )
);
