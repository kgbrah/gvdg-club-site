import { describe, expect, it } from "vitest";
import {
  HEATMAP_FIELD_CAP,
  marksFromScorecard,
  marksFromThrows,
  parseThrowPoint,
  publicHeatmapPayload,
  shotMemberKey,
  shotRoundKey,
} from "../src/hole-shot-marks.js";

describe("parseThrowPoint", () => {
  it("keeps finite coords and a 1-based throw number", () => {
    expect(parseThrowPoint({ lat: 35.612349, lng: -77.366129, n: 2 })).toEqual({
      lat: 35.61235,
      lng: -77.36613,
      n: 2,
    });
    expect(parseThrowPoint({ lat: 35.6, lng: -77.37 }, 4)).toEqual({
      lat: 35.6,
      lng: -77.37,
      n: 5,
    });
  });

  it("rejects missing, non-numeric, and out-of-range coords", () => {
    expect(parseThrowPoint(null)).toBeNull();
    expect(parseThrowPoint({ lat: "nope", lng: -77 })).toBeNull();
    expect(parseThrowPoint({ lat: 91, lng: 0 })).toBeNull();
    expect(parseThrowPoint({ lat: 35, lng: 181 })).toBeNull();
  });
});

describe("marksFromThrows / scorecard", () => {
  it("renumbers surviving throws and stops at 18", () => {
    const marks = marksFromThrows([
      { lat: 35.1, lng: -77.1 },
      { lat: "bad", lng: -77.1 },
      { lat: 35.2, lng: -77.2, n: 9 },
    ]);
    expect(marks).toEqual([
      { lat: 35.1, lng: -77.1, n: 1 },
      { lat: 35.2, lng: -77.2, n: 2 },
    ]);
  });

  it("reads throws off a JSON scorecard", () => {
    const holes = marksFromScorecard(JSON.stringify([
      { hole: 7, throws: [{ lat: 35.6, lng: -77.37 }] },
      { hole: 0, throws: [{ lat: 35.6, lng: -77.37 }] },
      { hole: 8, score: 3 },
    ]));
    expect(holes).toEqual([{ hole: 7, throws: [{ lat: 35.6, lng: -77.37, n: 1 }] }]);
  });
});

describe("publicHeatmapPayload", () => {
  it("splits field vs you and prefers drives when capping", () => {
    const rows = [
      { lat: 35.6, lng: -77.37, n: 1, memberId: "m_me" },
      { lat: 35.601, lng: -77.371, n: 2, memberId: "m_me" },
      { lat: 35.602, lng: -77.372, n: 2, memberId: "m_a" },
      { lat: 35.603, lng: -77.373, n: 1, memberId: "m_b" },
    ];
    const payload = publicHeatmapPayload(rows, "m_me", 3);
    expect(payload.hole).toBe(3);
    expect(payload.samples).toBe(2);
    expect(payload.you).toEqual([
      { lat: 35.6, lng: -77.37, n: 1 },
      { lat: 35.601, lng: -77.371, n: 2 },
    ]);
    expect(payload.drives).toEqual([{ lat: 35.603, lng: -77.373, n: 1 }]);
    expect(payload.lies[0]).toEqual({ lat: 35.603, lng: -77.373, n: 1 });
    expect(payload.lies[1]).toEqual({ lat: 35.602, lng: -77.372, n: 2 });
  });

  it("keeps anonymous field marks when there is no member", () => {
    const payload = publicHeatmapPayload(
      [{ lat: 35.6, lng: -77.37, n: 1, memberId: "" }],
      null,
      1,
    );
    expect(payload.you).toEqual([]);
    expect(payload.lies).toHaveLength(1);
    expect(HEATMAP_FIELD_CAP).toBe(250);
  });
});

describe("shot keys", () => {
  it("uses empty string instead of NULL and prefixes event rounds", () => {
    expect(shotMemberKey(null)).toBe("");
    expect(shotMemberKey("  m_jane  ")).toBe("m_jane");
    expect(shotRoundKey("abc123")).toBe("abc123");
    expect(shotRoundKey("", 44)).toBe("event:44");
    expect(shotRoundKey(null, null)).toBe("");
  });
});
