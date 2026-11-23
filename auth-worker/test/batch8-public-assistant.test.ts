import { describe, expect, it } from "vitest";
import { suggestCrottsActions } from "../src/assistant-actions.js";
import { publicField } from "../src/db-tournament.js";
import type { D1Like } from "../src/db-types.js";
import { karmaKey } from "../src/karma-directory.js";

function fieldDb(rows: Record<string, unknown>[]): D1Like {
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async all<T>() {
          expect(sql).toMatch(/SELECT[\s\S]*member_id[\s\S]*FROM registrations/i);
          expect(args).toEqual([42]);
          return { success: true, results: rows as T[] };
        },
        async first<T>() { return null as T | null; },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  return db as unknown as D1Like;
}

describe("Batch 8 assistant actions & tournament field karma privacy", () => {
  it("suggests lost-found.html for lost or found disc queries", () => {
    const lost = suggestCrottsActions({ message: "I lost my disc on hole 7 yesterday" });
    expect(lost).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: "lost-found.html" }),
    ]));

    const found = suggestCrottsActions({ message: "Found a disc near Meadowbrook tee 4" });
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: "lost-found.html" }),
    ]));

    const phrase = suggestCrottsActions({ message: "Where is the lost and found?" });
    expect(phrase).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: "lost-found.html" }),
    ]));

    const unrelated = suggestCrottsActions({ message: "What are the weekly league formats?" });
    expect(unrelated.some((action) => action.href === "lost-found.html")).toBe(false);
  });

  it("attaches opaque karmaKey for member registrations and omits it for guests in publicField", async () => {
    const db = fieldDb([
      {
        id: 1,
        member_id: "m_ada",
        name: "Ada Lovelace",
        division: "FPO",
        paid_entry: 1,
        paid_at: "2026-09-01T10:00:00.000Z",
        pdga_number: 1001,
        waitlisted: 0,
        waitlisted_at: null,
        spot_claimed_at: null,
        offered_at: null,
      },
      {
        id: 2,
        member_id: "g_guest123",
        name: "Guest Thrower",
        division: "MA2",
        paid_entry: 1,
        paid_at: "2026-09-01T11:00:00.000Z",
        pdga_number: null,
        waitlisted: 0,
        waitlisted_at: null,
        spot_claimed_at: null,
        offered_at: null,
      },
      {
        id: 3,
        member_id: "op_opt456",
        name: "Opt Guest",
        division: "MA2",
        paid_entry: 1,
        paid_at: "2026-09-01T11:30:00.000Z",
        pdga_number: null,
        waitlisted: 0,
        waitlisted_at: null,
        spot_claimed_at: null,
        offered_at: null,
      },
      {
        id: 4,
        member_id: "m_grace",
        name: "Grace Hopper",
        division: "FPO",
        paid_entry: 0,
        paid_at: null,
        pdga_number: 1002,
        waitlisted: 1,
        waitlisted_at: "2026-09-01T12:00:00.000Z",
        spot_claimed_at: null,
        offered_at: null,
      },
      {
        id: 5,
        member_id: "mg_mobile789",
        name: "Mobile Guest",
        division: "MA3",
        paid_entry: 0,
        paid_at: null,
        pdga_number: null,
        waitlisted: 1,
        waitlisted_at: "2026-09-01T12:30:00.000Z",
        spot_claimed_at: null,
        offered_at: null,
      },
      {
        id: 6,
        member_id: null,
        name: "Waitlist Null",
        division: "MA3",
        paid_entry: 0,
        paid_at: null,
        pdga_number: null,
        waitlisted: 1,
        waitlisted_at: "2026-09-01T13:00:00.000Z",
        spot_claimed_at: null,
        offered_at: null,
      },
    ]);

    const result = await publicField(db, 42, new Date("2026-09-02T12:00:00.000Z"), 6);

    expect(result.used).toBe(3);
    expect(result.position).toBe(3);
    expect(result.paid).toEqual([
      { name: "Ada Lovelace", division: "FPO", karmaKey: karmaKey("m_ada") },
      { name: "Guest Thrower", division: "MA2" },
      { name: "Opt Guest", division: "MA2" },
    ]);
    expect(result.waitlist).toEqual([
      { position: 1, name: "Grace Hopper", division: "FPO", karmaKey: karmaKey("m_grace") },
      { position: 2, name: "Mobile Guest", division: "MA3" },
      { position: 3, name: "Waitlist Null", division: "MA3" },
    ]);
    expect("karmaKey" in result.paid[1]!).toBe(false);
    expect("karmaKey" in result.paid[2]!).toBe(false);
    expect("karmaKey" in result.waitlist[1]!).toBe(false);
    expect("karmaKey" in result.waitlist[2]!).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("m_ada");
    expect(serialized).not.toContain("m_grace");
    expect(serialized).not.toContain("g_guest123");
    expect(serialized).not.toContain("op_opt456");
    expect(serialized).not.toContain("mg_mobile789");
  });
});
