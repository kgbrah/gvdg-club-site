import { describe, it, expect } from "vitest";
import { parseVisionJson } from "../src/vision.js";

describe("parseVisionJson", () => {
  it("parses a clean multi-layout response", () => {
    const r = parseVisionJson('{"hole":7,"layouts":[{"label":"Long","color":"blue","par":4,"distance_ft":420},{"label":"Short","color":"white","par":3,"distance_ft":285}]}');
    expect(r.hole).toBe(7);
    expect(r.layouts.length).toBe(2);
    expect(r.layouts[0]!).toEqual({ label: "Long", color: "blue", par: 4, distance_ft: 420, tee: null, target: null });
  });
  it("extracts JSON from a markdown code fence and prose", () => {
    const r = parseVisionJson('Sure!\n```json\n{"hole":3,"layouts":[{"label":"Main","par":3,"distance_ft":250}]}\n```');
    expect(r.hole).toBe(3);
    expect(r.layouts[0]!.par).toBe(3);
  });
  it("clamps out-of-range par/distance to null and coerces color to string", () => {
    const r = parseVisionJson('{"hole":99,"layouts":[{"label":"X","color":5,"par":40,"distance_ft":5}]}');
    expect(r.hole).toBe(99);                 // hole clamp is [1,99]
    expect(r.layouts[0]!.par).toBeNull();     // 40 out of [1,10]
    expect(r.layouts[0]!.distance_ft).toBeNull(); // 5 < 20
    expect(r.layouts[0]!.color).toBe("5");    // coerced
  });
  it("returns an empty result on garbage / no JSON", () => {
    expect(parseVisionJson("the sign is unreadable").layouts).toEqual([]);
    expect(parseVisionJson("").hole).toBeNull();
    expect(parseVisionJson('{"nope":true}').layouts).toEqual([]);
  });
  it("drops malformed layout rows but keeps good ones", () => {
    const r = parseVisionJson('{"hole":1,"layouts":[{"label":"A","par":3,"distance_ft":200},"junk",{"par":4}]}');
    expect(r.layouts.length).toBe(2);        // "A" + the {par:4} (label defaults to "")
    expect(r.layouts[0]!.label).toBe("A");
  });
});
