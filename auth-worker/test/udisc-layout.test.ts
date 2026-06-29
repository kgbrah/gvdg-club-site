import { describe, it, expect } from "vitest";
import { parseUdiscLayout, parseUdiscLayouts } from "../src/imports.js";

// UDisc (React Router v7) ships course data as a turbo-stream pool inside
// `window.__reactRouterContext.streamController.enqueue("…")`. The pool is a flat array where objects
// are `{ "_<keyIndex>": <valueIndex> }` and strings are interned. This fixture mirrors that real shape
// (verified against a live course page): two layouts, holes carrying par + tee/target latitude/longitude.
const POOL = [
  /* 0*/ [34, 35], // root: [layoutA, layoutB]
  /* 1*/ "name",
  /* 2*/ "layoutId",
  /* 3*/ "holes",
  /* 4*/ "par",
  /* 5*/ "latitude",
  /* 6*/ "longitude",
  /* 7*/ "teePosition",
  /* 8*/ "targetPosition",
  /* 9*/ 35.0,
  /*10*/ -82.4,
  /*11*/ 35.001,
  /*12*/ 35.002,
  /*13*/ 35.004,
  /*14*/ 35.01,
  /*15*/ "1",
  /*16*/ "2",
  /*17*/ 3,
  /*18*/ 4,
  /*19*/ 5,
  /*20*/ "Front 9 White",
  /*21*/ "Back Blue",
  /*22*/ 100,
  /*23*/ 200,
  /*24*/ { _5: 9, _6: 10 }, // {latitude:35.0, longitude:-82.4}
  /*25*/ { _5: 11, _6: 10 },
  /*26*/ { _5: 12, _6: 10 },
  /*27*/ { _5: 13, _6: 10 },
  /*28*/ { _5: 14, _6: 10 },
  /*29*/ { _1: 15, _4: 17, _7: 24, _8: 25 }, // hole {name:"1", par:3, teePosition, targetPosition}
  /*30*/ { _1: 16, _4: 18, _7: 26, _8: 27 },
  /*31*/ { _1: 15, _4: 19, _7: 24, _8: 28 },
  /*32*/ [29, 30], // layoutA holes
  /*33*/ [31], // layoutB holes
  /*34*/ { _1: 20, _2: 22, _3: 32 }, // layoutA {name, layoutId, holes}
  /*35*/ { _1: 21, _2: 23, _3: 33 },
];

function turboStreamHtml(pool: unknown[], title = "Test Course | UDisc"): string {
  const arg = JSON.stringify(JSON.stringify(pool)); // double-encoded: enqueue takes a JSON string
  return `<!doctype html><html><head><title>${title}</title></head><body>
<script>window.__reactRouterContext.streamController.enqueue(${arg})</script>
</body></html>`;
}

describe("parseUdiscLayouts — turbo-stream decode", () => {
  const html = turboStreamHtml(POOL);

  it("extracts every layout with per-hole pars", () => {
    const { layouts } = parseUdiscLayouts(html, "https://udisc.com/courses/x");
    expect(layouts.map((l) => l.name)).toEqual(["Front 9 White", "Back Blue"]);
    expect(layouts[0]!.holes.map((h) => h.par)).toEqual([3, 4]);
    expect(layouts[1]!.holes.map((h) => h.par)).toEqual([5]);
  });

  it("resolves hole numbers and tee/target coordinates", () => {
    const { layouts } = parseUdiscLayouts(html, "https://udisc.com/courses/x");
    const h1 = layouts[0]!.holes[0]!;
    expect(h1.hole).toBe(1);
    expect(h1.tee).toMatchObject({ lat: 35.0, lng: -82.4 });
    expect(h1.target).toMatchObject({ lat: 35.001, lng: -82.4 });
    expect(layouts[0]!.holes[1]!.hole).toBe(2);
  });

  it("builds a tee+target position pool per layout", () => {
    const { layouts } = parseUdiscLayouts(html, "https://udisc.com/courses/x");
    expect(layouts[0]!.positions.filter((p) => p.kind === "tee")).toHaveLength(2);
    expect(layouts[0]!.positions.filter((p) => p.kind === "target")).toHaveLength(2);
    expect(layouts[1]!.positions).toHaveLength(2); // 1 hole → 1 tee + 1 target
  });

  it("dedupes layouts by UDisc layoutId", () => {
    // Same pool referenced twice from the root must not yield duplicate layouts.
    const dupPool = POOL.slice();
    dupPool[0] = [34, 35, 34];
    const { layouts } = parseUdiscLayouts(turboStreamHtml(dupPool), "https://udisc.com/courses/x");
    expect(layouts).toHaveLength(2);
  });

  it("parseUdiscLayout returns the first layout", () => {
    const r = parseUdiscLayout(html, "https://udisc.com/courses/x");
    expect(r.name).toBe("Front 9 White");
    expect(r.holes).toHaveLength(2);
  });
});

describe("parseUdiscLayouts — graceful degrade", () => {
  it("returns name-only when there is no turbo-stream payload", () => {
    const html = "<html><head><title>Some Course | UDisc</title></head><body>just a shell</body></html>";
    const { name, layouts } = parseUdiscLayouts(html, "https://udisc.com/courses/x");
    expect(name).toBe("Some Course");
    expect(layouts).toEqual([]);

    const single = parseUdiscLayout(html, "https://udisc.com/courses/x");
    expect(single.name).toBe("Some Course");
    expect(single.holes).toEqual([]);
    expect(single.note).toMatch(/manual/i);
  });

  it("ignores a non-hole array named holes", () => {
    // holes whose elements have no numeric par must not register as a layout.
    const pool = [[1], { _2: 3 }, "holes", [4, 5], "review one", "review two"];
    const { layouts } = parseUdiscLayouts(turboStreamHtml(pool), "https://udisc.com/courses/x");
    expect(layouts).toEqual([]);
  });
});
