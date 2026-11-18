-- My Bag: photos of the whole bag, and accessories (cart, towel, minis, rangefinder…) with their own photos.
-- Private like the disc photos: only the owner sees them. bag_photos.subject says what a photo shows; disc_id holds
-- the bag disc id ('disc'), 'bag' ('bag'), or 'acc-<accessory id>' ('accessory').
CREATE TABLE IF NOT EXISTS bag_accessories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'other',
  name       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bag_accessories_owner ON bag_accessories(owner, id);

ALTER TABLE bag_photos ADD COLUMN subject TEXT NOT NULL DEFAULT 'disc' CHECK (subject IN ('disc', 'bag', 'accessory'));
