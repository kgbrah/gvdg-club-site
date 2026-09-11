import { describe, expect, it } from "vitest";
import { sanitizeCrottsHref, suggestCrottsActions } from "../src/assistant-actions.js";

describe("Crotts action allowlist", () => {
  it("keeps club pages and a live watch link", () => {
    expect(sanitizeCrottsHref("score.html?event=2&watch=1")).toBe("score.html?event=2&watch=1");
    expect(sanitizeCrottsHref("events.html#event/12")).toBe("events.html#event/12");
    expect(sanitizeCrottsHref("gvdg-members.html#apply")).toBe("gvdg-members.html#apply");
    expect(sanitizeCrottsHref("mailto:greenvillediscgolf@gmail.com")).toBe("mailto:greenvillediscgolf@gmail.com");
  });

  it("drops javascript, foreign hosts, and extra query keys", () => {
    expect(sanitizeCrottsHref("javascript:alert(1)")).toBe("");
    expect(sanitizeCrottsHref("https://evil.example/score.html")).toBe("");
    expect(sanitizeCrottsHref("score.html?event=2&gt=stolen")).toBe("");
    expect(sanitizeCrottsHref("../admin.html")).toBe("");
  });

  it("offers a watch button for a live round without inventing writes", () => {
    const actions = suggestCrottsActions({
      message: "can I watch the live round?",
      liveEvents: [{ id: 2, name: "West Meadowbrook" }],
    });
    expect(actions).toEqual([
      { href: "score.html?event=2&watch=1", id: "watch-2", label: "Watch West Meadowbrook" },
    ]);
  });

  it("offers apply and events buttons from plain English", () => {
    const join = suggestCrottsActions({ message: "I want to join the club" });
    expect(join.some((action) => action.href === "gvdg-members.html#apply")).toBe(true);
    const events = suggestCrottsActions({
      message: "register for league night",
      openEvents: [{ id: 9, name: "Thursday Doubles" }],
    });
    expect(events.map((action) => action.href)).toEqual(["events.html#event/9", "events.html"]);
  });
});
