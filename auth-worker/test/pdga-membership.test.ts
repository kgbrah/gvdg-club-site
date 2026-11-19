import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { signSession } from "../src/jwt.js";
import { resetPdgaApiSession } from "../src/pdga-api.js";
import { promoCurrent } from "../src/pdga-membership-routes.js";

// Joining or renewing a PDGA membership from the club site: the member's PDGA status from the official API, links to
// pdga.com, and the club's PDGA discount code (set by an admin each year), shown only to current club members.

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";
const PDGA = "https://api.test.pdga";
const YEAR = new Date().getUTCFullYear();

function kv(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    async get(key: string) { return rows.get(key) ?? null; },
    async put(key: string, value: string) { rows.set(key, value); },
    async delete(key: string) { rows.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) { return { keys: [...rows.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

async function sqliteDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) raw.exec(readFileSync(new URL(file, dir), "utf8"));
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      async all() { return { results: raw.prepare(sql).all(...(bound as never[])), success: true }; },
      async first() { return raw.prepare(sql).get(...(bound as never[])) ?? null; },
      async run() { const info = raw.prepare(sql).run(...(bound as never[])); return { results: [], success: true, meta: { changes: Number(info.changes) } }; },
    };
    return stmt;
  };
  return { raw, prepare, async batch(list: { run(): Promise<unknown> }[]) { for (const s of list) await s.run(); return []; } };
}

const member = (memberId: string, extra: Record<string, unknown>) => JSON.stringify({ memberId, name: memberId, pinHash: "x", mustChangePin: false, ...extra });
let env: Env;

beforeEach(async () => {
  resetPdgaApiSession();
  env = {
    DB: await sqliteDb(), RATELIMIT: kv(), JWT_SECRET: SECRET, SESSION_TTL_SEC: "900", ALLOWED_ORIGINS: ORIGIN,
    PDGA_API_USERNAME: "club", PDGA_API_PASSWORD: "pw", PDGA_API_BASE: PDGA,
    ROSTER: kv({
      "member:m_admin": member("m_admin", { isAdmin: true }),
      "member:m_current": member("m_current", { memberThroughYear: YEAR, pdgaNo: "80024" }),
      "member:m_lapsed": member("m_lapsed", { memberThroughYear: YEAR - 2, pdgaNo: "70007" }),
      "member:m_guest": member("m_guest", { guest: true, pdgaNo: "90001" }),
      "member:m_nopdga": member("m_nopdga", { memberThroughYear: YEAR }),
    }),
  } as unknown as Env;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/user/login")) return Response.json({ sessid: "s", session_name: "SESS", token: "t" });
    if (url.pathname.endsWith("/players")) {
      const players: Record<string, unknown> = {
        "80024": { first_name: "Ada", last_name: "Lovelace", pdga_number: "80024", membership_status: "current", membership_expiration_date: `${YEAR}-12-31`, rating: "905" },
        "70007": { first_name: "Cy", last_name: "Young", pdga_number: "70007", membership_status: "expired", membership_expiration_date: `${YEAR - 1}-12-31` },
        "90001": { first_name: "Bo", last_name: "Guest", pdga_number: "90001", membership_status: "current", membership_expiration_date: `${YEAR}-12-31` },
      };
      return Response.json({ status: 0, players: (url.searchParams.get("pdga_number") ?? "").split(",").flatMap((n) => players[n] ? [players[n]] : []) });
    }
    return new Response("unexpected", { status: 599 });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function call(path: string, options: { sub?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
  if (options.sub) headers.Authorization = "Bearer " + await signSession({ sub: options.sub, mustChangePin: false }, SECRET, 900);
  const response = await worker.fetch(new Request("https://worker" + path, { method: options.method ?? "GET", headers,
    body: options.body == null ? undefined : JSON.stringify(options.body) }), env);
  return { status: response.status, data: await response.json() as Record<string, any> };
}

describe("PDGA membership and the club's discount code", () => {
  it("lets an admin set this year's code, and refuses a malformed one", async () => {
    expect((await call("/admin/club-settings/pdga-promo", { sub: "m_current", method: "PUT", body: { code: "X" } })).status).toBe(403);
    expect((await call("/admin/club-settings/pdga-promo", { sub: "m_admin", method: "PUT", body: { code: "has space" } })).data.error).toBe("invalid_code");
    const saved = await call("/admin/club-settings/pdga-promo", { sub: "m_admin", method: "PUT", body: { code: "GVDG" + YEAR, validThrough: String(YEAR) } });
    expect(saved.data.promo).toMatchObject({ code: "GVDG" + YEAR, validThrough: String(YEAR) });
    expect((await call("/admin/club-settings/pdga-promo", { sub: "m_admin" })).data.promo.code).toBe("GVDG" + YEAR);
  });

  it("shows a current club member their PDGA status and the code; lapsed members and guest accounts get the links only", async () => {
    await call("/admin/club-settings/pdga-promo", { sub: "m_admin", method: "PUT", body: { code: "GVDG" + YEAR, validThrough: String(YEAR) } });
    const current = await call("/pdga/membership", { sub: "m_current" });
    expect(current.data).toMatchObject({
      pdgaNumber: "80024", lookup: "ok", player: { membershipStatus: "current", membershipExpires: `${YEAR}-12-31`, url: "https://www.pdga.com/player/80024" },
      promo: { code: "GVDG" + YEAR }, clubDiscountAvailable: true,
      joinUrl: "https://www.pdga.com/membership", renewUrl: "https://www.pdga.com/membership/renew",
      attribution: "Player, event, and course data provided by PDGA",
    });
    const lapsed = await call("/pdga/membership", { sub: "m_lapsed" });
    expect(lapsed.data).toMatchObject({ player: { membershipStatus: "expired", membershipExpires: `${YEAR - 1}-12-31` }, promo: null, clubDiscountAvailable: true });
    expect((await call("/pdga/membership", { sub: "m_guest" })).data).toMatchObject({ promo: null, clubDiscountAvailable: true });
    expect((await call("/pdga/membership", { sub: "m_nopdga" })).data).toMatchObject({ pdgaNumber: null, player: null, lookup: "none", promo: { code: "GVDG" + YEAR } });
    expect((await call("/pdga/membership", { sub: "m_admin" })).data.promo.code).toBe("GVDG" + YEAR);
    expect((await call("/pdga/membership")).status).toBe(401);
  });

  it("stops offering last year's code, and a cleared code", async () => {
    await call("/admin/club-settings/pdga-promo", { sub: "m_admin", method: "PUT", body: { code: "GVDGOLD", validThrough: String(YEAR - 1) } });
    expect((await call("/pdga/membership", { sub: "m_current" })).data).toMatchObject({ promo: null, clubDiscountAvailable: false });
    await call("/admin/club-settings/pdga-promo", { sub: "m_admin", method: "PUT", body: { code: "" } });
    expect((await call("/admin/club-settings/pdga-promo", { sub: "m_admin" })).data.promo).toBeNull();
    expect(promoCurrent({ code: "A1", validThrough: "2026-03-31", updatedAt: "" }, new Date("2026-03-31T12:00:00Z"))).toBe(true);
    expect(promoCurrent({ code: "A1", validThrough: "2026-03-31", updatedAt: "" }, new Date("2026-04-01T12:00:00Z"))).toBe(false);
  });
});
