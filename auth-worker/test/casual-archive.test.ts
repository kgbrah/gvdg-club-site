import { describe, expect, it } from "vitest";
import { buildCasualArchiveSnapshot, publicMemberCasualResult, shouldUseCasualArchive } from "../src/casual-archive.js";

function dbWith(round: Record<string, unknown> | null, results: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}) {
  return {
    prepare: (sql: string) => ({
      bind() { return this; },
      first: async () => {
        if (/FROM casual_rounds/i.test(sql)) return round;
        if (/FROM course_layouts/i.test(sql)) return extra.layout ?? null;
        if (/FROM courses/i.test(sql)) return extra.course ?? null;
        return null;
      },
      all: async () => ({ results, success: true }),
      run: async () => ({ results: [], success: true }),
    }),
  };
}

describe("casual archive snapshot", () => {
  it("uses the live or final DO snapshot and archives the rest", () => {
    expect(shouldUseCasualArchive({ status: "live" })).toBe(false);
    expect(shouldUseCasualArchive({ status: "final" })).toBe(false);
    expect(shouldUseCasualArchive({ status: "none" })).toBe(true);
    expect(shouldUseCasualArchive({})).toBe(true);
    expect(shouldUseCasualArchive(null)).toBe(true);
  });

  it("redacts member identity from the member history row", () => {
    expect(publicMemberCasualResult({
      id: 9,
      member_id: "m_jane",
      round_code: "JQEU74",
      course_name: "Ayden Park",
      layout_name: "Blue",
      total: 56,
      to_par: 2,
      created_by: "m_jane",
    })).toEqual({
      id: 9,
      round_code: "JQEU74",
      course_name: "Ayden Park",
      layout_name: "Blue",
      layout_id: null,
      finalized_at: null,
      total: 56,
      to_par: 2,
      place: null,
      udisc_course_id: null,
      scorecard: null,
    });
  });

  it("rebuilds a final watch snapshot from durable results and layout geometry", async () => {
    const snapshot = await buildCasualArchiveSnapshot(dbWith(
      {
        id: 7,
        round_code: "AB23CD",
        course_id: 3,
        layout_id: 5,
        course_name: "North Rec",
        layout_name: "Blue",
        holes: JSON.stringify([{ hole: 1, par: 3 }]),
        scoring_config: JSON.stringify({ groupFormat: "singles", scoringStyle: "stroke" }),
        finalized_at: "2026-09-18T12:00:00Z",
      },
      [{
        name: "Jane",
        total: 7,
        to_par: 0,
        scorecard: JSON.stringify([{ hole: 1, par: 3, strokes: 3 }, { hole: 2, par: 4, strokes: 4 }]),
      }],
      {
        layout: { id: 5, holes: JSON.stringify([{ hole: 1, par: 3, tee: { lat: 1, lng: 2 }, target: { lat: 3, lng: 4 } }, { hole: 2, par: 4 }]) },
        course: { id: 3, udisc_course_id: "AYD" },
      },
    ) as never, "AB23CD");

    expect(snapshot).toMatchObject({
      status: "final",
      archived: true,
      courseName: "North Rec",
      layoutName: "Blue",
      udiscCourseId: "AYD",
    });
    expect(snapshot?.holes[0]).toMatchObject({ hole: 1, par: 3, tee: { lat: 1, lng: 2 } });
    expect(snapshot?.players[0]).toMatchObject({ name: "Jane", scores: { 1: 3, 2: 4 } });
    expect(snapshot?.standings[0]).toMatchObject({ name: "Jane", total: 7, toPar: 0, thru: 2 });
  });

  it("returns null when the round was never finalized", async () => {
    await expect(buildCasualArchiveSnapshot(dbWith(null) as never, "NONE00")).resolves.toBeNull();
  });
});
