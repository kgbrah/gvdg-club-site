import { describe, expect, it } from "vitest";
import {
  applyMapConsensus,
  computeMapConsensus,
  holeAnchor,
  mapMarkAccuracyOk,
  mapMarkNearAnchor,
  parseMapMarkBody,
  MAP_MARK_PUBLISH_MEMBERS,
} from "../src/course-map-marks.js";

const TEE = { lat: 35.612, lng: -77.366 };

describe("parseMapMarkBody", () => {
  it("accepts tee/target and pin alias", () => {
    expect(parseMapMarkBody({ hole: 7, kind: "tee", lat: 35.61234, lng: -77.36612 })).toMatchObject({
      hole: 7,
      kind: "tee",
      lat: 35.61234,
      lng: -77.36612,
    });
    expect(parseMapMarkBody({ hole: 7, kind: "pin", lat: 35.612, lng: -77.366, accuracyM: 4 })).toMatchObject({
      kind: "target",
      accuracyM: 4,
    });
  });

  it("rejects bad holes, coords, and negative accuracy", () => {
    expect(parseMapMarkBody({ hole: 0, kind: "tee", lat: 35, lng: -77 })).toBeNull();
    expect(parseMapMarkBody({ hole: 1, kind: "fairway", lat: 35, lng: -77 })).toBeNull();
    expect(parseMapMarkBody({ hole: 1, kind: "tee", lat: 91, lng: 0 })).toBeNull();
    expect(parseMapMarkBody({ hole: 1, kind: "tee", lat: 35, lng: -77, accuracyM: -1 })).toBeNull();
  });
});

describe("map mark quality", () => {
  it("rejects fuzzy GPS and far-from-anchor marks", () => {
    expect(mapMarkAccuracyOk(12)).toBe(true);
    expect(mapMarkAccuracyOk(40)).toBe(false);
    expect(mapMarkAccuracyOk(null)).toBe(true);
    expect(mapMarkNearAnchor({ lat: 35.6121, lng: -77.366 }, TEE)).toBe(true);
    expect(mapMarkNearAnchor({ lat: 35.62, lng: -77.35 }, TEE)).toBe(false);
    expect(holeAnchor({ tee: TEE, target: null }, "tee")).toEqual(TEE);
    expect(holeAnchor({ tee: TEE, target: null }, "target")).toBeNull();
  });
});

describe("computeMapConsensus", () => {
  it("does not publish until three clustered members agree", () => {
    const a = { member_id: "m_a", lat: 35.61201, lng: -77.36601 };
    const b = { member_id: "m_b", lat: 35.61202, lng: -77.36600 };
    expect(computeMapConsensus(1, "target", [a, b]).published).toBe(false);
    const c = { member_id: "m_c", lat: 35.61200, lng: -77.36602 };
    const published = computeMapConsensus(1, "target", [a, b, c]);
    expect(MAP_MARK_PUBLISH_MEMBERS).toBe(3);
    expect(published.published).toBe(true);
    expect(published.members).toBe(3);
    expect(published.lat).toBeCloseTo(35.61201, 4);
  });

  it("drops a far outlier so two tight marks cannot publish", () => {
    const clustered = [
      { member_id: "m_a", lat: 35.61201, lng: -77.36601 },
      { member_id: "m_b", lat: 35.61202, lng: -77.36600 },
      { member_id: "m_c", lat: 35.62000, lng: -77.35000 },
    ];
    const result = computeMapConsensus(4, "tee", clustered);
    expect(result.published).toBe(false);
    expect(result.members).toBe(2);
  });
});

describe("applyMapConsensus", () => {
  it("overlays published tee and basket coords without dropping labels", () => {
    const holes = [{
      hole: 3,
      par: 3,
      tee: { label: "Blue", lat: 35.6, lng: -77.37 },
      target: { label: "A", lat: 35.601, lng: -77.37 },
    }];
    const next = applyMapConsensus(holes, [
      { hole: 3, kind: "tee", lat: 35.612, lng: -77.366, samples: 4, members: 4, spread_m: 3, published: true },
      { hole: 3, kind: "target", lat: 35.613, lng: -77.365, samples: 4, members: 4, spread_m: 2, published: true },
    ]);
    expect(next[0]?.tee).toMatchObject({ label: "Blue", lat: 35.612, lng: -77.366 });
    expect(next[0]?.target).toMatchObject({ label: "A", lat: 35.613, lng: -77.365 });
  });

  it("can seed a hole that had no map yet", () => {
    const next = applyMapConsensus([{ hole: 1, par: 3, tee: null, target: null }], [
      { hole: 1, kind: "tee", lat: 35.61, lng: -77.36, samples: 3, members: 3, spread_m: 4, published: true },
      { hole: 1, kind: "target", lat: 35.611, lng: -77.359, samples: 3, members: 3, spread_m: 4, published: true },
    ]);
    expect(next[0]?.tee).toMatchObject({ label: "Tee", lat: 35.61, lng: -77.36 });
    expect(next[0]?.target).toMatchObject({ label: "Basket", lat: 35.611, lng: -77.359 });
  });
});
