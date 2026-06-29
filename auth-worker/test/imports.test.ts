import { afterEach, describe, it, expect, vi } from "vitest";
import { isAllowedUrl, parseCsvRows, normalizeDgs, safeFetch } from "../src/imports.js";

afterEach(() => vi.unstubAllGlobals());

describe("isAllowedUrl — SSRF guard", () => {
  const allow = ["udisc.com", "discgolfscene.com"];

  it("accepts https on an allowlisted apex host", () => {
    expect(isAllowedUrl("https://udisc.com/courses/x", allow)).toBe(true);
  });
  it("accepts an allowlisted subdomain", () => {
    expect(isAllowedUrl("https://www.discgolfscene.com/tournaments/y", allow)).toBe(true);
  });
  it("rejects a non-allowlisted host", () => {
    expect(isAllowedUrl("https://evil.example/x", allow)).toBe(false);
  });
  it("rejects http (must be https)", () => {
    expect(isAllowedUrl("http://udisc.com/x", allow)).toBe(false);
  });
  it("rejects a suffix look-alike (udisc.com.evil.example)", () => {
    expect(isAllowedUrl("https://udisc.com.evil.example/x", allow)).toBe(false);
  });
  it("rejects userinfo @-tricks (host is actually evil)", () => {
    expect(isAllowedUrl("https://udisc.com@evil.example/x", allow)).toBe(false);
  });
  it("rejects raw IP literals (metadata SSRF)", () => {
    expect(isAllowedUrl("https://169.254.169.254/latest/meta-data", allow)).toBe(false);
    expect(isAllowedUrl("https://127.0.0.1/x", allow)).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(isAllowedUrl("not a url", allow)).toBe(false);
    expect(isAllowedUrl("", allow)).toBe(false);
  });
});

describe("parseCsvRows", () => {
  it("parses a header + rows into objects, handling quotes/commas", () => {
    const rows = parseCsvRows('name,date,type\n"Hangover, 7",2026-08-01,tournament\nLeague Wk1,2026-08-08,league_round');
    expect(rows).toEqual([
      { name: "Hangover, 7", date: "2026-08-01", type: "tournament" },
      { name: "League Wk1", date: "2026-08-08", type: "league_round" },
    ]);
  });
  it("returns [] for empty/headers-only input", () => {
    expect(parseCsvRows("")).toEqual([]);
    expect(parseCsvRows("name,date")).toEqual([]);
  });
});

describe("safeFetch", () => {
  it("rejects a declared oversized response before buffering it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ignored", { headers: { "content-length": "99" } })),
    );

    await expect(safeFetch("https://docs.google.com/sheet.csv", ["docs.google.com"], { maxBytes: 10 })).rejects.toThrow("response_too_large");
  });

  it("stops streaming an undeclared oversized response once the byte cap is crossed", async () => {
    let pulls = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 3) throw new Error("read_too_far");
        controller.enqueue(encoder.encode("abcd"));
      },
      cancel() {},
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));

    await expect(safeFetch("https://docs.google.com/sheet.csv", ["docs.google.com"], { maxBytes: 8 })).rejects.toThrow("response_too_large");
    expect(pulls).toBeLessThanOrEqual(4);
  });
});

describe("normalizeDgs", () => {
  it("maps a tournaments.json feed into event candidates", () => {
    const feed = {
      tournaments: [
        { name: "The Hangover 6", date: "2026-01-01", venue: "West Meadowbrook", city: "Greenville, NC", tier: "C", url: "https://www.discgolfscene.com/tournaments/The_Hangover_6_2026" },
      ],
    };
    const cands = normalizeDgs(feed);
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ type: "tournament", name: "The Hangover 6", date: "2026-01-01", source: "dgs" });
    expect(cands[0]!.external_url).toMatch(/discgolfscene\.com/);
  });
  it("tolerates a bare array and skips nameless rows", () => {
    const cands = normalizeDgs([{ name: "X", date: "2026-02-02" }, { date: "2026-03-03" }]);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.name).toBe("X");
  });
});
