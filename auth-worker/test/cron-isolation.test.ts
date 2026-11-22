import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

const calls: string[] = [];

vi.mock("../src/pdga-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdga-events.js")>();
  return {
    ...actual,
    refreshClubPdgaEvents: async () => {
      calls.push("refreshClubPdgaEvents");
      throw new Error("pdga_events_boom");
    },
  };
});

vi.mock("../src/pdga-event-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdga-event-cache.js")>();
  return {
    ...actual,
    refreshClubPdgaEventCopies: async () => {
      calls.push("refreshClubPdgaEventCopies");
      return { refreshed: 0, cleared: 0 };
    },
  };
});

vi.mock("../src/pdga-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdga-api.js")>();
  return {
    ...actual,
    purgePdgaCaches: async () => {
      calls.push("purgePdgaCaches");
      throw new Error("purge_boom");
    },
  };
});

vi.mock("../src/udisc-league-refresh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/udisc-league-refresh.js")>();
  return {
    ...actual,
    refreshImportedUdiscLeagues: async () => {
      calls.push("refreshImportedUdiscLeagues");
      return { leagues: 1, updated: [], failed: [] };
    },
  };
});

import worker from "../src/index.js";

describe("hourly PDGA cron error isolation", () => {
  it("runs refreshClubPdgaEventCopies and refreshImportedUdiscLeagues even when earlier jobs throw, then reports error", async () => {
    calls.length = 0;
    const pending: Promise<unknown>[] = [];
    const db = {
      prepare() {
        const stmt = {
          bind: () => stmt,
          all: async () => ({ results: [], success: true }),
          first: async () => null,
          run: async () => ({ results: [], success: true }),
        };
        return stmt;
      },
    };
    const kv = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true }),
    };
    const env = { DB: db, ROSTER: kv, RATELIMIT: kv, JWT_SECRET: "x".repeat(40), ALLOWED_ORIGINS: "https://gvdgclub.com" } as unknown as Env;

    await worker.scheduled(
      { cron: "7 * * * *", scheduledTime: Date.parse("2026-11-15T20:07:00Z"), noRetry() {} } as unknown as ScheduledController,
      env,
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    );
    const settled = await Promise.allSettled(pending);
    expect(calls).toEqual([
      "purgePdgaCaches",
      "refreshClubPdgaEventCopies",
      "refreshClubPdgaEvents",
      "refreshImportedUdiscLeagues",
    ]);
    expect(settled[0]?.status).toBe("rejected");
    expect(String((settled[0] as PromiseRejectedResult).reason)).toContain("pdga_events_boom");
  });
});
