import { describe, it, expect } from "vitest";
import { parseUdiscLayout } from "../src/imports.js";

// UDisc course pages embed course data in JSON (e.g. Next.js __NEXT_DATA__). This is a synthetic
// fixture of a *plausible* shape — real UDisc markup may differ, so the parser is best-effort and
// degrades to "name only + manual pars" when nothing parseable is found.
const NEXT_DATA = `<!doctype html><html><head>
<title>West Side Park &middot; UDisc Disc Golf Courses</title></head><body>
<script id="__NEXT_DATA__" type="application/json">
{"props":{"pageProps":{"course":{"name":"West Side Park","holes":[
{"holeNumber":1,"par":3,"teePositions":[{"latitude":35.0,"longitude":-82.4}],"targetPosition":{"latitude":35.001,"longitude":-82.4}},
{"holeNumber":2,"par":4,"teePositions":[{"latitude":35.002,"longitude":-82.4}],"targetPosition":{"latitude":35.004,"longitude":-82.4}}
]}}}}
</script></body></html>`;

describe("parseUdiscLayout (best-effort)", () => {
  it("extracts name, per-hole pars, and tee/target coords from embedded JSON", () => {
    const r = parseUdiscLayout(NEXT_DATA, "https://udisc.com/courses/west-side-park");
    expect(r.name).toBe("West Side Park");
    expect(r.holes).toHaveLength(2);
    expect(r.holes[0]).toMatchObject({ hole: 1, par: 3 });
    expect(r.holes[0]!.tee).toMatchObject({ lat: 35.0, lng: -82.4 });
    expect(r.holes[0]!.target).toMatchObject({ lat: 35.001, lng: -82.4 });
    expect(r.holes[1]).toMatchObject({ hole: 2, par: 4 });
  });

  it("builds a tee+target position pool from the holes", () => {
    const r = parseUdiscLayout(NEXT_DATA, "https://udisc.com/courses/west-side-park");
    expect(r.positions.filter((p) => p.kind === "tee")).toHaveLength(2);
    expect(r.positions.filter((p) => p.kind === "target")).toHaveLength(2);
    expect(r.positions[0]).toMatchObject({ kind: "tee", lat: 35.0, lng: -82.4 });
  });

  it("degrades gracefully when no parseable course JSON is present", () => {
    const r = parseUdiscLayout("<html><head><title>Some Course | UDisc</title></head><body>JS app</body></html>", "https://udisc.com/courses/x");
    expect(r.name).toBe("Some Course");
    expect(r.holes).toEqual([]);
    expect(r.positions).toEqual([]);
    expect(r.note).toMatch(/manual/i);
  });
});
