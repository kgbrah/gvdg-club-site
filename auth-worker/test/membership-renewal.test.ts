import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMembershipRenewalReminders } from "../src/membership-renewal.js";
import type { Env } from "../src/env.js";
import { b64url } from "../src/web-push.js";

afterEach(() => vi.unstubAllGlobals());

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    get: async (key: string) => rows.get(key) ?? null,
    put: async (key: string, value: string) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (opts?: { prefix?: string }) => ({
      keys: [...rows.keys()].filter((key) => key.startsWith(opts?.prefix || "")).map((name) => ({ name })),
      list_complete: true,
    }),
    rows,
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async all() { return { results: db.prepare(sql).all(...(bound as never[])), success: true }; },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async run() {
          db.prepare(sql).run(...(bound as never[]));
          return { results: [], success: true };
        },
      };
      return stmt;
    },
  };
}

async function vapid() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return {
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    VAPID_PRIVATE_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  };
}

async function device(id: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint: `https://push.example/send/${id}`, p256dh: b64url(publicRaw), auth: b64url(auth) };
}

const member = (memberId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ memberId, name: memberId, isAdmin: false, pinHash: "x", mustChangePin: false, ...extra });

describe("December membership reminder", () => {
  it("does nothing outside the December window", async () => {
    const roster = kv({ "member:m_due": member("m_due") });
    const env = { ROSTER: roster, DB: await sqliteDb() } as unknown as Env;
    const result = await sendMembershipRenewalReminders(env, new Date("2026-11-16T15:00:00Z"));
    expect(result.skipped).toBe("not_december");
    expect(roster.rows.has("renewal-notice:2026")).toBe(false);
  });

  it("pushes once, on December 1, only to members who still need next year", async () => {
    const due = await device("due");
    const done = await device("done");
    const db = await sqliteDb();
    await db.prepare(
      "INSERT INTO member_push_subscriptions (endpoint, member_id, p256dh, auth, bag_tags, messages) VALUES (?, ?, ?, ?, 1, 1)",
    ).bind(due.endpoint, "m_due", due.p256dh, due.auth).run();
    await db.prepare(
      "INSERT INTO member_push_subscriptions (endpoint, member_id, p256dh, auth, bag_tags, messages) VALUES (?, ?, ?, ?, 0, 0)",
    ).bind(done.endpoint, "m_done", done.p256dh, done.auth).run();
    const roster = kv({
      "member:m_due": member("m_due"),
      "member:m_done": member("m_done", { memberThroughYear: 2027 }),
    });
    const env = { ROSTER: roster, DB: db, ...(await vapid()) } as unknown as Env;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(null, { status: 201 });
    });
    const when = new Date("2026-12-01T15:00:00Z");
    const first = await sendMembershipRenewalReminders(env, when);
    expect(first).toMatchObject({ sent: 1, skipped: null, year: 2026 });
    expect(calls).toEqual([due.endpoint]);
    expect(roster.rows.has("renewal-notice:2026")).toBe(true);

    const second = await sendMembershipRenewalReminders(env, new Date("2026-12-03T15:00:00Z"));
    expect(second.skipped).toBe("already_sent");
    expect(calls).toEqual([due.endpoint]);
  });

  it("does not claim the year when push is not configured", async () => {
    const roster = kv({ "member:m_due": member("m_due") });
    const env = { ROSTER: roster, DB: await sqliteDb() } as unknown as Env;
    const result = await sendMembershipRenewalReminders(env, new Date("2026-12-01T15:00:00Z"));
    expect(result.skipped).toBe("unconfigured");
    expect(roster.rows.has("renewal-notice:2026")).toBe(false);
  });

  it("is called from the daily cron, not a new trigger", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toContain("sendMembershipRenewalReminders");
    const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(wrangler).not.toContain("0 5 1 12");
  });
});
