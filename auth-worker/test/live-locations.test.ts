import { describe, expect, it } from "vitest";

import {
  isLoggedInMemberId,
  locationMoved,
  locationOnCourse,
  parseLocationBody,
  playerInitials,
  publicPlayerLocations,
} from "../src/live-locations.js";

const NORTH_REC = [{ tee: { lat: 35.6, lng: -77.37 }, target: { lat: 35.601, lng: -77.37 } }];

describe("live player locations", () => {
  it("initials use first and last name characters", () => {
    expect(playerInitials("Alex Schwarga")).toBe("AS");
    expect(playerInitials("TJ Braley")).toBe("TB");
    expect(playerInitials("Jesus")).toBe("J");
    expect(playerInitials("  ")).toBe("");
  });

  it("only logged-in members share GPS, not guests", () => {
    expect(isLoggedInMemberId("m_a")).toBe(true);
    expect(isLoggedInMemberId("g_token")).toBe(false);
    expect(isLoggedInMemberId(null)).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseLocationBody({ lat: 35.6, lng: -77.37 })).toEqual({ lat: 35.6, lng: -77.37 });
    expect(parseLocationBody({ lat: 91, lng: 0 })).toBeNull();
    expect(parseLocationBody({ lat: "nope", lng: -77 })).toBeNull();
  });

  it("treats GPS jitter under ~4m as not moved", () => {
    const prev = { lat: 35.6, lng: -77.37, at: 1 };
    expect(locationMoved(undefined, { lat: 35.6, lng: -77.37 })).toBe(true);
    expect(locationMoved(prev, { lat: 35.60001, lng: -77.37 })).toBe(false);
    expect(locationMoved(prev, { lat: 35.6001, lng: -77.37 })).toBe(true);
  });

  it("keeps on-course pings and rejects home/off-course coordinates", () => {
    expect(locationOnCourse(35.6005, -77.37, NORTH_REC)).toBe(true);
    expect(locationOnCourse(40, -90, NORTH_REC)).toBe(false);
    expect(locationOnCourse(35.6, -77.37, [])).toBe(false);
  });

  it("drops guests, removed players, stale pings, and off-course GPS from the public overlay", () => {
    const now = 1_000_000;
    const locations = new Map([
      [0, { lat: 35.6, lng: -77.37, at: now - 1_000 }],
      [1, { lat: 35.601, lng: -77.371, at: now - 1_000 }],
      [2, { lat: 35.602, lng: -77.372, at: now - 200_000 }],
      [4, { lat: 40, lng: -90, at: now - 1_000 }],
    ]);
    const published = publicPlayerLocations(
      [
        { name: "Alex Schwarga", memberId: "m_a" },
        { name: "Walk-on", memberId: "g_abc" },
        { name: "TJ Braley", memberId: "m_b" },
        { name: "Gone", memberId: "m_c", removed: true },
        { name: "Home", memberId: "m_d" },
      ],
      locations,
      now,
      NORTH_REC,
    );
    expect(published).toEqual([{ index: 0, initials: "AS", lat: 35.6, lng: -77.37, at: now - 1_000 }]);
  });
});
