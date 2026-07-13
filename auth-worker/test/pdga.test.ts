import { describe, it, expect } from "vitest";
import { parsePlayerPage, parseDetailRounds, fetchPdgaStats } from "../src/pdga.js";

// Fixtures mirror the real pdga.com markup (verified against player #273070).
const PLAYER_HTML = `
<h1 class="title" id="page-title">Kevin Gray #273070</h1>
<ul><li class="current-rating"> <strong>Current Rating:</strong> 891
  <a title="-3 point" href="/player/273070/history">-3</a>
  <small class="rating-date">(as of 09-Jun-2026)</small> </li></ul>`;

const DETAILS_HTML = `
<table><tr><th class="round-rating">Rating</th></tr>
<tr class="evaluated included odd"><td class="tournament"><a href="/tour/event/104398">GVDG Monthly</a></td><td class="tier">C</td><td class="date" data-text="1780200000">31-May-2026</td><td class="division">MA2</td><td class="round tooltip" data-tooltip-content="#a">2</td><td class="score">69</td><td class="round-rating">888</td><td class="evaluated">Yes</td></tr>
<tr class="evaluated included even"><td class="tournament"><a href="/tour/event/104398">GVDG Monthly</a></td><td class="tier">C</td><td class="date" data-text="1780200000">31-May-2026</td><td class="division">MA2</td><td class="round tooltip" data-tooltip-content="#b">1</td><td class="score">75</td><td class="round-rating">836</td><td class="evaluated">Yes</td></tr>
<tr class="odd"><td class="tournament"><a href="/tour/event/100001">Spring Open</a></td><td class="tier">B</td><td class="date" data-text="1770000000">01-Mar-2026</td><td class="division">MA1</td><td class="round">1</td><td class="score">61</td><td class="round-rating">925</td><td class="evaluated">Yes</td></tr>
</table>`;

const PLAYER_WITH_PENDING_EVENT_HTML = `${PLAYER_HTML}
<h4>MA2 · Mixed Amateur 2</h4>
<table><tr><td class="place">8</td><td class="tournament"><a href="/tour/event/104547#MA2">Yard Gnomes Open presented by Play it Again Sports</a></td><td class="tier">B</td><td class="dates" data-text="1783742400">11-Jul-2026</td></tr></table>`;

const PENDING_EVENT_HTML = `
<h2>Unofficial Results</h2>
<table class="results"><tr class="even"><td class="place">8</td><td class="player"><a href="/player/273070">Kevin Gray</a></td><td class="pdga-number">273070</td><td class="player-rating">891</td><td class="par">+10</td><td class="round"><a href="/live/event/104547/MA2/scores?round=1" class="score">67</a></td><td class="round-rating">818</td><td class="round"><a href="/live/event/104547/MA2/scores?round=2" class="score">66</a></td><td class="round-rating">909</td><td class="total">133</td></tr></table>`;

describe("pdga.com parsers", () => {
  it("parses name + official rating + date from the player page", () => {
    const p = parsePlayerPage(PLAYER_HTML);
    expect(p).toEqual({ name: "Kevin Gray", official_rating: 891, rating_date: "09-Jun-2026" });
  });

  it("returns nulls (no throw) on unexpected markup", () => {
    expect(parsePlayerPage("<html>nope</html>")).toEqual({ name: null, official_rating: null, rating_date: null });
    expect(parseDetailRounds("<html>nope</html>")).toEqual([]);
  });

  it("groups detail rounds into events, most recent first", () => {
    const events = parseDetailRounds(DETAILS_HTML);
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ tournament: "GVDG Monthly", date: "31-May-2026", division: "MA2" });
    expect(events[0]?.rounds.map((r) => r.rating)).toEqual([888, 836]);
    expect(events[1]).toMatchObject({ tournament: "Spring Open", division: "MA1" });
    expect(events[1]?.rounds[0]?.rating).toBe(925);
  });

  it("computes live (recent-form mean) + peak from a stubbed fetch", async () => {
    const stub: typeof fetch = async (input) =>
      new Response(String(input).endsWith("/details") ? DETAILS_HTML : PLAYER_HTML, { status: 200 });
    const s = await fetchPdgaStats("273070", stub);
    expect(s.official_rating).toBe(891);
    expect(s.peak_rating).toBe(925); // max round rating
    expect(s.live_rating).toBe(883); // round((888+836+925)/3)
    expect(s.events_count).toBe(2);
    expect(s.name).toBe("Kevin Gray");
  });

  it("includes newly reported round ratings before PDGA adds them to ratings detail", async () => {
    // Given a player page with a newly reported event whose rounds are only on the event page.
    const stub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/details")) return new Response(DETAILS_HTML, { status: 200 });
      if (url.endsWith("/tour/event/104547")) return new Response(PENDING_EVENT_HTML, { status: 200 });
      return new Response(PLAYER_WITH_PENDING_EVENT_HTML, { status: 200 });
    };

    // When the live PDGA stats are built.
    const stats = await fetchPdgaStats("273070", stub);

    // Then the reported event leads the feed and contributes its newest rounds to the live rating.
    expect(stats.events[0]).toMatchObject({
      tournament: "Yard Gnomes Open presented by Play it Again Sports",
      date: "11-Jul-2026",
      division: "MA2",
      rounds: [
        { rating: 909, score: 66, round: "2" },
        { rating: 818, score: 67, round: "1" },
      ],
    });
    expect(stats.live_rating).toBe(875);
  });

  it("keeps evaluated ratings when a pending event page is temporarily unavailable", async () => {
    // Given a healthy player/detail response and a failed request for the newly reported event.
    const stub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/details")) return new Response(DETAILS_HTML, { status: 200 });
      if (url.endsWith("/tour/event/104547")) throw new TypeError("event page unavailable");
      return new Response(PLAYER_WITH_PENDING_EVENT_HTML, { status: 200 });
    };

    // When live PDGA stats are built.
    const stats = await fetchPdgaStats("273070", stub);

    // Then the existing evaluated history remains available instead of failing the whole response.
    expect(stats.events[0]?.tournament).toBe("GVDG Monthly");
    expect(stats.live_rating).toBe(883);
  });
});
