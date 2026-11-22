import { describe, expect, it } from "vitest";
import { formatPhotoContext, formatRulesContext, rulesForQuestion } from "../src/rules-lookup.js";
import { takeRulingImages } from "../src/photos.js";

describe("rules lookup", () => {
  it("stays quiet for a normal club question", () => {
    expect(rulesForQuestion("when is the next league round?", false)).toEqual([]);
  });

  it("picks the out-of-bounds note without copying a rulebook", () => {
    const notes = rulesForQuestion("Is this disc OB if it crossed the water?", false);
    expect(notes.map((note) => note.id)).toContain("ob");
    expect(formatRulesContext(notes)).toMatch(/not a tournament director/);
    expect(formatRulesContext(notes)).toMatch(/80602/);
    expect(formatRulesContext(notes)).toMatch(/1 meter perpendicular/);
    expect(formatRulesContext(notes).length).toBeLessThan(4000);
  });

  it("matches current 2025/2026 PDGA rules across hazard, practice, stance, relief, provisional, lost, mando and 808 scoring", () => {
    const check = (q: string, id: string, ...patterns: RegExp[]) => {
      const notes = rulesForQuestion(q, false);
      expect(notes.map((n) => n.id)).toContain(id);
      const text = formatRulesContext(notes);
      for (const p of patterns) expect(text).toMatch(p);
    };
    check("My disc landed in a sand trap hazard", "hazard", /80605/, /where the disc lies/);
    check("I threw a practice throw during the round", "practice", /80903/, /1-throw penalty/);
    check("Question about foot fault when putting inside circle", "stance", /80601/, /full control of balance/);
    check("Relief from casual water or two-meter tree", "relief", /80302/, /line of play/, /805\.02/);
    check("Should we play a provisional shot?", "provisional", /80902/, /before throwing/, /both lies/);
    check("How long do we search for a lost disc?", "lost", /80503/, /3 minutes/);
    check("Did we miss the mandatory?", "mando", /80401/, /restricted plane/);
    check("Who keeps score on the scorecard under 808?", "scoring", /808/, /every player/, /30 minutes/);
  });

  it("adds the lie notes when a photo is attached, even if the question is short", () => {
    const notes = rulesForQuestion("what's the call?", true);
    expect(notes.map((note) => note.id)).toEqual(expect.arrayContaining(["ob", "mark", "mando", "relief"]));
    expect(notes.length).toBeLessThanOrEqual(5);
  });

  it("says a video is still frames, not motion", () => {
    const text = formatPhotoContext(["A disc is next to a rope."], "video");
    expect(text).toMatch(/still frames/);
    expect(text).toMatch(/foot fault/);
    expect(text).toMatch(/rope/);
  });

  it("rejects a ruling image that is not a real jpeg, png, or webp", () => {
    expect(takeRulingImages(["data:image/svg+xml;base64,PHN2Zy8+"])).toBeNull();
    const jpeg = "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0x00));
    expect(takeRulingImages([jpeg])).toHaveLength(1);
  });
});
