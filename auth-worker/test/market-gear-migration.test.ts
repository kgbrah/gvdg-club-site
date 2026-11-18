// Migration 0068 rebuilds market_listings (bags and accessories as well as discs). It runs on a live database whose
// listings already have photos, offers, deals, feedback, wanted replies and lost-disc checks pointing at them, so this
// replays it the way D1 does (one transaction, foreign keys enforced) on a database full of those rows.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../migrations/", import.meta.url);
const GEAR = "0068_market_gear.sql";
const LISTING_COLUMNS = `id, seller_id, brand, mold, plastic, disc_type, speed, glide, turn, fade, weight_g, color, condition,
  condition_notes, price_cents, open_to_trade, trade_for, quantity, location, status, hidden, withdrawn_at, withdrawal_final,
  created_at, updated_at`;

async function seededBeforeGear() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  for (const file of readdirSync(DIR).sort()) if (file < GEAR) db.exec(readFileSync(new URL(file, DIR), "utf8"));
  db.exec(`
    INSERT INTO market_listings (id, seller_id, brand, mold, plastic, disc_type, speed, glide, turn, fade, weight_g, color, condition,
      condition_notes, price_cents, open_to_trade, trade_for, quantity, location, status, created_at, updated_at)
    VALUES (1, 'm_ada', 'Innova', 'Destroyer', 'Star', 'driver', 12, 5, -1, 3, 175, 'Orange', 8, 'Light ink', 1800, 1, 'A Firebird', 1,
      'Sunday Baggers', 'active', '2026-10-01 12:00:00', '2026-10-02 12:00:00');
    INSERT INTO market_listings (id, seller_id, mold, disc_type, condition, price_cents, status, withdrawn_at, created_at, updated_at)
    VALUES (2, 'm_bo', 'Buzzz', 'midrange', 6, 1200, 'withdrawn', '2026-10-03 08:00:00', '2026-10-01 09:00:00', '2026-10-03 08:00:00');
    INSERT INTO market_listings (id, seller_id, mold, disc_type, condition, price_cents, open_to_trade, status, created_at, updated_at)
    VALUES (3, 'm_cy', 'Aviar', 'putter', 9, NULL, 1, 'sold', '2026-09-01 09:00:00', '2026-09-05 09:00:00');
    INSERT INTO market_listing_photos (listing_id, r2_key, content_type, bytes) VALUES (1, 'market/1/a.jpg', 'image/jpeg', 10),
      (2, 'market/2/a.jpg', 'image/jpeg', 10), (3, 'market/3/a.jpg', 'image/jpeg', 10);
    INSERT INTO market_offers (id, listing_id, buyer_id, offered_ids, body) VALUES (1, 1, 'm_bo', '[2]', 'Buzzz for it?');
    INSERT INTO market_deals (id, listing_id, seller_id, buyer_id, kind, offer_id, listing_title, status, outcome)
    VALUES (1, 3, 'm_cy', 'm_ada', 'buy', NULL, 'Aviar', 'completed', 'sold'), (2, 1, 'm_ada', 'm_bo', 'trade', 1, 'Innova Star Destroyer', 'pending', NULL);
    INSERT INTO market_deal_log (deal_id, listing_id, actor_id, action) VALUES (1, 3, 'm_ada', 'buy'), (NULL, 1, 'm_ada', 'list');
    INSERT INTO market_feedback (deal_id, author_id, subject_id, subject_role, rating) VALUES (1, 'm_ada', 'm_cy', 'seller', 'positive');
    INSERT INTO market_wanted (id, poster_id, mold, expires_at) VALUES (1, 'm_bo', 'Destroyer', '2026-12-01 00:00:00');
    INSERT INTO market_wanted_replies (wanted_id, replier_id, listing_id, body) VALUES (1, 'm_ada', 1, 'Mine is for sale');
    INSERT INTO market_reports (target_kind, target_id, reporter_id, reason) VALUES ('listing', 2, 'm_cy', 'spam');
    INSERT INTO market_listing_reads (listing_id) VALUES (1);
    INSERT INTO lf_posts (id, kind, owner_id, expires_at) VALUES (1, 'lost', 'm_cy', '2026-12-01 00:00:00');
    INSERT INTO market_lost_checks (listing_id, lost_id, verdict) VALUES (1, 1, 'strong');
  `);
  return db;
}

function applyGearLikeD1(db: import("node:sqlite").DatabaseSync) {
  db.exec("BEGIN");
  try {
    db.exec(readFileSync(new URL(GEAR, DIR), "utf8"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("migration 0068: market_listings rebuilt for bags and accessories", () => {
  it("keeps every listing and every row that points at one, with foreign keys enforced", async () => {
    const db = await seededBeforeGear();
    const before = db.prepare(`SELECT ${LISTING_COLUMNS} FROM market_listings ORDER BY id`).all();
    const children = ["market_listing_photos", "market_offers", "market_deals", "market_deal_log", "market_feedback", "market_wanted_replies",
      "market_reports", "market_listing_reads", "market_lost_checks"].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]);

    applyGearLikeD1(db);

    expect(db.prepare(`SELECT ${LISTING_COLUMNS} FROM market_listings ORDER BY id`).all()).toEqual(before);
    expect(db.prepare("SELECT DISTINCT item_kind, gear_type, bag_ref FROM market_listings").all()).toEqual([{ item_kind: "disc", gear_type: "", bag_ref: null }]);
    for (const [table, rows] of children) expect(db.prepare(`SELECT * FROM ${table as string}`).all(), table as string).toEqual(rows);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'market_listings%' ORDER BY name").all().map((row) => row.name)).toEqual([
      "market_listings", "market_listings_bag", "market_listings_brand", "market_listings_browse", "market_listings_condition",
      "market_listings_kind", "market_listings_price", "market_listings_seller", "market_listings_type", "market_listings_weight",
      "market_listings_withdrawn",
    ]);
    // Children still reference the rebuilt table, and the reference is still enforced.
    expect(() => db.exec("INSERT INTO market_listing_photos (listing_id, r2_key, content_type, bytes) VALUES (99, 'x', 'image/jpeg', 1)"))
      .toThrow(/FOREIGN KEY/);
    expect(() => db.exec("DELETE FROM market_listings WHERE id = 1")).toThrow(/FOREIGN KEY/);
    // New listings carry on after the old ids.
    const next = db.prepare("INSERT INTO market_listings (seller_id, mold, disc_type, condition, price_cents) VALUES ('m_ada', 'Wraith', 'driver', 7, 1500) RETURNING id").get();
    expect(next).toEqual({ id: 4 });
  });

  it("allows bags and accessories, without disc-only details", async () => {
    const db = await seededBeforeGear();
    applyGearLikeD1(db);
    const insert = (columns: string, values: string) => db.exec(`INSERT INTO market_listings (seller_id, condition, price_cents, ${columns}) VALUES ('m_ada', 8, 4000, ${values})`);
    insert("item_kind, mold, brand, bag_ref", "'bag', 'AX5', 'Grip', 'bag'");
    insert("item_kind, gear_type, mold, bag_ref", "'accessory', 'cart', 'Zuca cart', 'accessory:3'");
    expect(() => insert("item_kind, mold, disc_type", "'bag', 'AX5', 'driver'")).toThrow(/CHECK/);
    expect(() => insert("item_kind, mold", "'disc', 'Destroyer'")).toThrow(/CHECK/);
    expect(() => insert("item_kind, mold, weight_g", "'accessory', 'Towel', 175")).toThrow(/CHECK/);
    expect(() => insert("item_kind, mold, plastic", "'bag', 'AX5', 'Star'")).toThrow(/CHECK/);
    expect(() => insert("item_kind, gear_type, mold", "'bag', 'cart', 'AX5'")).toThrow(/CHECK/);
    expect(() => insert("item_kind, mold", "'hat', 'Cap'")).toThrow(/CHECK/);
  });

  it("also applies on an empty database outside a transaction (how the test suites build theirs)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(DIR).sort()) db.exec(readFileSync(new URL(file, DIR), "utf8"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM market_listings").get()).toEqual({ n: 0 });
  });
});
