import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { signOpenPlaySession, signSession } from "../src/jwt.js";
import { arrayField, jsonObject } from "./json.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://gvdgclub.com";

const members = {
  "member:m_jane": JSON.stringify({ memberId: "m_jane", name: "Jane", isAdmin: false, pinHash: "x", mustChangePin: false }),
};

function kv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
}

function mockDb(rows: { lat: number; lng: number; n: number; memberId: string }[]) {
  return {
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ");
      const stmt = {
        binds: [] as unknown[],
        bind(...values: unknown[]) {
          stmt.binds = values;
          return stmt;
        },
        async first() {
          return null;
        },
        async all() {
          if (text.includes("FROM hole_shot_marks")) {
            return {
              results: rows.map((row) => ({
                lat: row.lat,
                lng: row.lng,
                throw_n: row.n,
                member_id: row.memberId,
              })),
              success: true,
            };
          }
          return { results: [], success: true };
        },
        async run() {
          if (text.includes("INSERT OR IGNORE INTO hole_shot_harvest")) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

function env(rows: { lat: number; lng: number; n: number; memberId: string }[]) {
  return {
    ROSTER: kv(members),
    RATELIMIT: kv(),
    DB: mockDb(rows),
    JWT_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function call(path: string, token?: string) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (token) headers.authorization = "Bearer " + token;
  return worker.fetch(new Request("https://w" + path, { method: "GET", headers }), env([
    { lat: 35.6, lng: -77.37, n: 1, memberId: "m_jane" },
    { lat: 35.601, lng: -77.371, n: 1, memberId: "m_pat" },
    { lat: 35.602, lng: -77.372, n: 2, memberId: "m_pat" },
  ]));
}

describe("GET /layouts/:id/heatmap", () => {
  it("rejects a bad hole", async () => {
    expect((await call("/layouts/12/heatmap?hole=0")).status).toBe(400);
    expect((await call("/layouts/12/heatmap")).status).toBe(400);
    expect((await call("/layouts/nope/heatmap?hole=3")).status).toBe(400);
  });

  it("returns public field marks without you rings", async () => {
    const res = await call("/layouts/12/heatmap?hole=3");
    expect(res.status).toBe(200);
    const body = await jsonObject(res);
    expect(body.hole).toBe(3);
    expect(body.samples).toBe(3);
    expect(arrayField(body, "lies")).toHaveLength(3);
    expect(arrayField(body, "you")).toHaveLength(0);
    expect(arrayField(body, "drives")).toHaveLength(2);
  });

  it("attaches you rings for a member session and ignores open-play tokens", async () => {
    const member = await signSession({ sub: "m_jane", mustChangePin: false }, SECRET, 900);
    const mine = await jsonObject(await call("/layouts/12/heatmap?hole=3", member));
    expect(arrayField(mine, "you")).toEqual([{ lat: 35.6, lng: -77.37, n: 1 }]);
    expect(mine.samples).toBe(2);

    const guest = await signOpenPlaySession({ sub: "play:pat", name: "Pat" }, SECRET, 900);
    const asGuest = await jsonObject(await call("/layouts/12/heatmap?hole=3", guest));
    expect(arrayField(asGuest, "you")).toHaveLength(0);
    expect(asGuest.samples).toBe(3);
  });
});
