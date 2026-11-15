import { describe, expect, it } from "vitest";
import { isEasternSundayAtThree, isUdiscLeagueRefreshCron, udiscLeagueUrl } from "../src/udisc-league-refresh.js";

describe("UDisc league refresh schedule", () => {
  it("recognizes the Sunday UTC crons that can be 3pm Eastern", () => {
    expect(isUdiscLeagueRefreshCron("0 19 * * 0")).toBe(true);
    expect(isUdiscLeagueRefreshCron("0 20 * * 0")).toBe(true);
    expect(isUdiscLeagueRefreshCron("7 * * * *")).toBe(false);
  });

  it("keeps Sunday 3pm Eastern through daylight saving", () => {
    expect(isEasternSundayAtThree(new Date("2026-11-15T20:00:00Z"))).toBe(true);
    expect(isEasternSundayAtThree(new Date("2026-11-15T19:00:00Z"))).toBe(false);
    expect(isEasternSundayAtThree(new Date("2026-07-12T19:00:00Z"))).toBe(true);
    expect(isEasternSundayAtThree(new Date("2026-07-12T20:00:00Z"))).toBe(false);
  });

  it("reads the UDisc league link stored on an imported league", () => {
    expect(udiscLeagueUrl("Weekly tags\nhttps://udisc.com/leagues/sunday-baggers-ab12")).toBe("https://udisc.com/leagues/sunday-baggers-ab12");
    expect(udiscLeagueUrl("https://www.udisc.com/leagues/sunday-baggers-ab12/schedule")).toBe("https://udisc.com/leagues/sunday-baggers-ab12");
    expect(udiscLeagueUrl("not a link")).toBeNull();
  });
});
