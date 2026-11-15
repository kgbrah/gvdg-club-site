import { describe, expect, it } from "vitest";
import { mergeUdiscCalendars, normalizeUdiscEventsUrl, parseUdiscCalendar, udiscImportCandidates } from "../src/imports.js";

function turbo(pool: unknown[]): string {
  const arg = JSON.stringify(JSON.stringify(pool));
  return `<!doctype html><body><script>window.__reactRouterContext.streamController.enqueue(${arg})</script></body>`;
}

// Flat React Router pool: index 0 is {loaderData: schedule route}.
const LEAGUE_POOL = [
  /* 0 */ { _1: 2 },
  /* 1 */ "loaderData",
  /* 2 */ { _3: 4 },
  /* 3 */ "routes/leagues/slug/schedule",
  /* 4 */ { _5: 6, _17: 18, _20: 21, _22: 23 },
  /* 5 */ "league",
  /* 6 */ { _7: 8, _9: 10, _11: 12, _13: 14, _15: 16 },
  /* 7 */ "name",
  /* 8 */ "Dolly Dubs",
  /* 9 */ "slug",
  /*10 */ "dolly-dubs",
  /*11 */ "shortId",
  /*12 */ "5JJBOv",
  /*13 */ "playFormat",
  /*14 */ "singles",
  /*15 */ "longDescription",
  /*16 */ "Weekly doubles at the park.",
  /*17 */ "eventListings",
  /*18 */ [19],
  /*19 */ { _7: 24, _25: 26, _27: 28, _29: 30, _31: 32, _33: 34, _36: 37 },
  /*20 */ "resultsCount",
  /*21 */ 1,
  /*22 */ "currentPage",
  /*23 */ 1,
  /*24 */ "Dolly Dubs - Week 1",
  /*25 */ "shortId",
  /*26 */ "abc123",
  /*27 */ "eventType",
  /*28 */ "league",
  /*29 */ "startDate",
  /*30 */ "2026-11-18",
  /*31 */ "layoutName",
  /*32 */ "Main",
  /*33 */ "location",
  /*34 */ { _38: 39 },
  /*35 */ "unused",
  /*36 */ "scoring",
  /*37 */ { _13: 40 },
  /*38 */ "courseName",
  /*39 */ "Dolly Cooper Park",
  /*40 */ "teams",
];

describe("normalizeUdiscEventsUrl", () => {
  it("turns a league home link into the schedule URL", () => {
    expect(normalizeUdiscEventsUrl("https://www.udisc.com/leagues/dolly-dubs-5JJBOv")).toEqual({
      kind: "league",
      fetchUrl: "https://udisc.com/leagues/dolly-dubs-5JJBOv/schedule",
      scheduleUrl: "https://udisc.com/leagues/dolly-dubs-5JJBOv/schedule",
    });
  });
  it("accepts an event link and rejects anything else", () => {
    expect(normalizeUdiscEventsUrl("https://udisc.com/events/week-1-abc123/about")?.kind).toBe("event");
    expect(normalizeUdiscEventsUrl("https://udisc.com/courses/dolly-cooper-gX5K")).toBeNull();
    expect(normalizeUdiscEventsUrl("https://evil.example/leagues/dolly")).toBeNull();
  });
});

describe("parseUdiscCalendar", () => {
  it("reads a league and its event from the turbo-stream", () => {
    const calendar = parseUdiscCalendar(turbo(LEAGUE_POOL), "https://udisc.com/leagues/dolly-dubs-5JJBOv/schedule");
    expect(calendar.league).toMatchObject({
      type: "league",
      name: "Dolly Dubs",
      format: "stroke",
      season: "2026",
      external_url: "https://udisc.com/leagues/dolly-dubs-5JJBOv",
    });
    expect(calendar.events).toEqual([
      expect.objectContaining({
        type: "league_round",
        name: "Dolly Dubs - Week 1",
        date: "2026-11-18",
        format: "doubles",
        source: "udisc",
        venue: "Dolly Cooper Park",
        league_name: "Dolly Dubs",
        external_url: "https://udisc.com/events/dolly-dubs-week-1-abc123",
        notes: "UDisc · Dolly Cooper Park · Main",
      }),
    ]);
    expect(udiscImportCandidates(mergeUdiscCalendars([calendar])).map((row) => row.type)).toEqual(["league", "league_round"]);
  });

  it("returns nothing when the page has no stream", () => {
    expect(parseUdiscCalendar("<html></html>", "https://udisc.com/events/x").events).toEqual([]);
  });
});
