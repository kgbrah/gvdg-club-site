-- Jump Ashe County Park to the front of live mapping: attach the known UDisc course URL
-- so the next importer tick can pull tee/pin layouts instead of waiting on index hydration.
UPDATE courses
SET udisc_url = 'https://udisc.com/courses/ashe-county-park-wllg'
WHERE name = 'Ashe County Park'
  AND (udisc_url IS NULL OR trim(udisc_url) = '');
