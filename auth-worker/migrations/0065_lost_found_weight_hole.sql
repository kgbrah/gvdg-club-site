-- Lost & Found posts gain the disc's weight (grams, from the weight pick-list) and the hole it was found or lost on
-- (from the course's hole pick-list), so matching can compare them. Both optional; older posts keep NULL.
ALTER TABLE lf_posts ADD COLUMN weight_g INTEGER CHECK (weight_g IS NULL OR (weight_g BETWEEN 100 AND 200));
ALTER TABLE lf_posts ADD COLUMN hole INTEGER CHECK (hole IS NULL OR (hole BETWEEN 1 AND 40));
